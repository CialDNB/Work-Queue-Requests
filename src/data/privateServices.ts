// THE PRIVATE HTTP SERVICE TRANSPORT. `privateServiceFetch()` calls an on-premises or in-VPC HTTP
// service through its Workers VPC service binding, `VPC_<SERVICE>`, and nothing else in the app
// does. It is the HTTP sibling of src/data/aurora.ts: the same binding kind, a different protocol.
//
// WHY A SEPARATE PATH. A Workers VPC service binding is `{ binding, service_id }` with no per-Worker
// ACL, gated by the flat account permission `Connectivity Directory Bind` — exactly the property
// that makes binding-allowlist.jsonc the reviewed grant for a database. A service that speaks HTTP
// is reached the same way, so it is granted the same way: a `vpc_services` grant, now with
// `"class": "http"`. What it is NOT is a database: it has no connection string, no SQL, and no
// AURORA_SOURCES entry. The gate (`npm run verify:edge`) cross-checks an http grant against the
// table below instead, and refuses a name registered in both.
//
// WHAT THIS FILE GUARANTEES, on every call:
//
//   • the request goes through the binding, never a raw fetch(): the private name does not exist in
//     public DNS, and the binding is the only reviewed way to reach it;
//   • the URL is always `https://<host><path>`, where the host comes from the `VPC_<SERVICE>_HOST`
//     var (set by the deploying config, or by central delivery on a DB Israel app) — a caller
//     passes a PATH and cannot name another host, a scheme, a port or credentials in the URL;
//   • the app credential is attached: the service's registered Worker secret, as
//     `Authorization: Bearer …`. A caller cannot omit it, replace it, or set `Host`;
//   • redirects are refused rather than followed — a 3xx could point the credential-bearing request
//     anywhere — and every call has a timeout;
//   • nothing secret or identifying is logged: a failure logs the SERVICE NAME and a fixed reason,
//     never the host, path, credential or response body.
//
// WHAT IT DOES NOT DO. It does not record reads. If the service returns client or third-party
// records, it is ALSO an upstream source: register it in UPSTREAM_SOURCES (src/data/upstream.ts),
// define its reads with `defineUpstreamRead`, and have the integration module require the grant
// before it calls this transport. See docs/DATA-ROUTES.md, "Private HTTP services". It does not
// interpret the response either: any non-redirect status is returned for the caller to map.
//
// The binding is looked up by NAME off the environment bag, as aurora.ts does, because `Env`
// declares no Workers VPC binding — the kit binds none, and a fork adds its own. So no file in the
// app names `env.VPC_*`, and the semgrep fence (`hyperdrive-access-outside-data-layer`) keeps it
// that way outside src/data/.
import { type Env, getSecret, type SecretsStoreSecret } from '../env';
import { AppError } from '../framework/errors';
import {
  PRIVATE_SERVICE_FAILURES,
  type PrivateServiceFailure,
} from '../framework/privateServiceFailure';
import { logEvent } from '../platform/logEvent';

// Re-exported so an integration module imports the transport and its vocabulary from one place.
export { PRIVATE_SERVICE_FAILURES, type PrivateServiceFailure };

// ---------------------------------------------------------------------------------------
// Services
// ---------------------------------------------------------------------------------------

/**
 * Every private HTTP service this app may call, and the Worker secret that holds its credential.
 * THE KIT CALLS NONE, so this ships empty — a fork adds one line per service, in protected core,
 * in the SAME pull request as the wrangler binding, its `VPC_<SERVICE>_HOST` var and its
 * `"class": "http"` grant in binding-allowlist.jsonc:
 *
 *     export const PRIVATE_SERVICES = Object.freeze({
 *       example_api: 'EXAMPLE_API_TOKEN',
 *     }) satisfies …;
 *
 * The key is the service NAME: the binding name minus `VPC_`, lowercased — `VPC_EXAMPLE_API` is
 * `example_api`, the same derivation as an Aurora source, so the gate can tell the two tables
 * apart by name and refuse a name in both. The value is the NAME of the secret (a per-Worker secret
 * or a Secrets Store binding, read through `getSecret`), never the value.
 *
 * Keep the literal inline in the `Object.freeze({ … })` call, one `name: 'SECRET'` pair per line:
 * `parsePrivateServices` in scripts/check-edge-hardening.mjs reads this table statically and FAILS
 * CLOSED on a shape it cannot read. `satisfies`, not an annotation, so `KnownPrivateService` stays
 * the literal keys rather than `string`.
 */
export const PRIVATE_SERVICES = Object.freeze({
  // A fork's services land here, one line each: `example_api: 'EXAMPLE_API_TOKEN',`
}) satisfies Readonly<Record<string, string>>;

/** A service registered above — `never` in the kit, which calls none. */
export type KnownPrivateService = keyof typeof PRIVATE_SERVICES & string;

type ServiceTable = Readonly<Record<string, string>>;

/** Service name (`example_api`) → binding name (`VPC_EXAMPLE_API`). */
export function bindingForPrivateService(service: string): string {
  return `VPC_${service.toUpperCase()}`;
}

/** Binding name (`VPC_EXAMPLE_API`) → the var holding its host (`VPC_EXAMPLE_API_HOST`). */
export function hostVarForBinding(binding: string): string {
  return `${binding}_HOST`;
}

/** The service-name shape: what `sourceNameForBinding` produces from a `VPC_*` binding. */
const SERVICE_NAME = /^[a-z][a-z0-9_]*$/;
/** A Worker secret / binding name. */
const SECRET_NAME = /^[A-Z][A-Z0-9_]*$/;
/**
 * A bare, lowercase DNS host name with at least two labels: no scheme, port, path, userinfo or
 * trailing dot. The same shape the gate requires of the `_HOST` var in a deploying config; checked
 * again here because central delivery, a dashboard edit or a test can set the var too.
 */
export const PRIVATE_SERVICE_HOST =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

// ---------------------------------------------------------------------------------------
// Failures
// ---------------------------------------------------------------------------------------

/**
 * The kit's opaque 500 to whatever reaches the response, with the reason kept on the object for the
 * integration module that called. A route that lets it propagate renders the same body as any
 * internal error — nothing about the service, its host or the failure reaches a client.
 */
export class PrivateServiceError extends AppError {
  constructor(readonly reason: PrivateServiceFailure) {
    super(500, 'internal_error', 'Something went wrong');
    this.name = 'PrivateServiceError';
  }

  /** True for the failures a caller may retry: the service did not answer, or not in time. */
  get transient(): boolean {
    return this.reason === 'timeout' || this.reason === 'network';
  }
}

function fail(service: string, reason: PrivateServiceFailure): PrivateServiceError {
  logEvent('private_service_failed', { service, reason });
  return new PrivateServiceError(reason);
}

// ---------------------------------------------------------------------------------------
// The call
// ---------------------------------------------------------------------------------------

/** The Workers VPC service binding surface this transport uses: `fetch`, and only `fetch`. */
interface PrivateServiceBinding {
  fetch(input: string, init?: RequestInit): Promise<Response>;
}

export const DEFAULT_TIMEOUT_MS = 10_000;
export const MAX_TIMEOUT_MS = 30_000;

export interface PrivateServiceInit extends Omit<RequestInit, 'redirect'> {
  /**
   * Milliseconds the whole call may take — the credential lookup and the request, from the first
   * await — before it is abandoned as `timeout`. 1–30000; default 10000. The signal
   * stays on the request, so it bounds reading the body too: a body read that outlives it rejects
   * with the platform's abort error, which is the caller's to map.
   */
  timeoutMs?: number;
}

/**
 * Call a registered private HTTP service. `path` is the request path (and query), starting with a
 * single `/`; the transport supplies the scheme, the host and the credential. Returns the
 * service's response for any non-redirect status — mapping a 4xx/5xx is the caller's job. Throws a
 * `PrivateServiceError` (the kit's opaque 500, with a `reason`) when the call cannot be made or
 * does not complete.
 *
 *     const res = await privateServiceFetch(env, 'example_api', '/v1/items?limit=20');
 */
export function privateServiceFetch(
  env: Env,
  service: KnownPrivateService,
  path: string,
  init?: PrivateServiceInit,
): Promise<Response> {
  return callPrivateService(env, service, path, init, PRIVATE_SERVICES);
}

/**
 * The same call against a SYNTHETIC service table, for the kit's own tests — the kit registers no
 * service, so `KnownPrivateService` is `never` and the public entry point cannot be called with a
 * name. Production code calls `privateServiceFetch`; a table passed here is not reviewed.
 */
export function __privateServiceFetchForTest(
  env: Env,
  table: ServiceTable,
  service: string,
  path: string,
  init?: PrivateServiceInit,
): Promise<Response> {
  return callPrivateService(env, service, path, init, table);
}

async function callPrivateService(
  env: Env,
  service: string,
  path: string,
  init: PrivateServiceInit | undefined,
  table: ServiceTable,
): Promise<Response> {
  // Only a registered service, by the table's OWN key — `toString` or `__proto__` is not a service.
  const secretName = Object.hasOwn(table, service) ? table[service] : undefined;
  if (
    !SERVICE_NAME.test(service) ||
    typeof secretName !== 'string' ||
    !SECRET_NAME.test(secretName)
  ) {
    throw fail(SERVICE_NAME.test(service) ? service : 'invalid', 'unregistered');
  }

  const bag = env as unknown as Record<string, unknown>;
  const bindingName = bindingForPrivateService(service);
  const binding = bag[bindingName] as Partial<PrivateServiceBinding> | undefined;
  if (!binding || typeof binding !== 'object' || typeof binding.fetch !== 'function') {
    // A registered service with no binding in THIS environment — legitimate mid-rollout (staging
    // binds it, production does not yet), and never something to paper over with a raw fetch().
    throw fail(service, 'binding_missing');
  }

  const host = bag[hostVarForBinding(bindingName)];
  if (typeof host !== 'string' || !PRIVATE_SERVICE_HOST.test(host))
    throw fail(service, 'host_invalid');

  const url = requestUrl(host, path);
  if (url === null) throw fail(service, 'request_refused');

  const { timeoutMs = DEFAULT_TIMEOUT_MS, headers: callerHeaders, signal, ...rest } = init ?? {};
  // `cf` carries Cloudflare's per-request overrides — `resolveOverride` among them, which changes
  // where a request is resolved. Where the call goes is the transport's decision, never a caller's.
  if ('cf' in rest) throw fail(service, 'request_refused');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
    // A bad timeout is a programming error; an unbounded call is the failure it would cause.
    throw fail(service, 'request_refused');
  }
  // The deadline starts here, before the first await, so it bounds the WHOLE call — the credential
  // lookup (a Secrets Store read can stall) as well as the request — and every await below races it.
  const deadline = AbortSignal.timeout(timeoutMs);
  const abort = signal ? AbortSignal.any([signal, deadline]) : deadline;
  /** The failure for an await that did not complete: the deadline's, else the caller's abort. */
  const interrupted = (otherwise: PrivateServiceFailure): PrivateServiceFailure =>
    deadline.aborted ? 'timeout' : abort.aborted ? 'aborted' : otherwise;

  const headers = new Headers(callerHeaders);
  // The credential and the routing are the transport's. A caller that sets either is trying to send
  // something the review did not see — refuse it rather than silently overwrite it.
  if (headers.has('authorization') || headers.has('host')) throw fail(service, 'header_refused');

  let credential: string | undefined;
  try {
    credential = await beforeAbort(
      getSecret(bag[secretName] as string | SecretsStoreSecret | undefined),
      abort,
    );
  } catch {
    throw fail(service, interrupted('credential_missing'));
  }
  if (typeof credential !== 'string' || credential === '')
    throw fail(service, 'credential_missing');
  try {
    headers.set('authorization', `Bearer ${credential}`);
  } catch {
    // A value Headers refuses (a newline, a non-Latin-1 character). Caught so the platform's error,
    // whatever it says about the value, never travels further than this line.
    throw fail(service, 'credential_missing');
  }

  let response: Response;
  try {
    // Raced as well as signalled: the signal asks the binding to stop, the race guarantees this
    // call returns at the deadline even if it does not.
    response = await beforeAbort(
      (binding as PrivateServiceBinding).fetch(url, {
        ...rest,
        headers,
        redirect: 'manual',
        signal: abort,
      }),
      abort,
    );
  } catch {
    // The error itself is not logged: a network error's message can carry the URL.
    throw fail(service, interrupted('network'));
  }
  if (response.status >= 300 && response.status < 400) {
    // Release the body without waiting on it — a stalled cancel must not hold the call past its
    // refusal. The Location is never read.
    response.body?.cancel().catch(() => undefined);
    throw fail(service, 'redirect_refused');
  }
  return response;
}

/**
 * `work`, or a rejection the moment `signal` aborts — whichever comes first. The abandoned `work`
 * keeps no listener and its own rejection is swallowed, so nothing outlives the call unhandled.
 */
function beforeAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    work.catch(() => undefined);
    return Promise.reject(signal.reason);
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      work.catch(() => undefined);
      reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
}

/**
 * `https://<host><path>`, or null when `path` could reach anything else. The path must start with
 * exactly one `/` (`//evil` is a scheme-relative URL), carry no backslash (some parsers read it as
 * `/`), no whitespace or control character, and no fragment. Whatever survives must still resolve
 * to the same origin — the final check, not the first, so a parser quirk cannot slip past the list.
 */
export function requestUrl(host: string, path: string): string | null {
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')) return null;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: refusing control characters is the point.
  if (/[\\#\s\u0000-\u001f\u007f]/.test(path)) return null;
  const origin = `https://${host}`;
  let url: URL;
  try {
    url = new URL(path, origin);
  } catch {
    return null;
  }
  if (url.origin !== origin || url.username !== '' || url.password !== '') return null;
  return url.href;
}

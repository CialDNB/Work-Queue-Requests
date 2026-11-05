// The private HTTP service transport, src/data/privateServices.ts. The service is a FAKE binding in
// every test — a `fetch` that records what it was handed — because the guarantees are all about
// what leaves the Worker: through the binding, to `https://<host><path>`, with the credential, no
// redirect followed, nothing secret in a log line.
//
// The kit registers no service (PRIVATE_SERVICES ships empty, so `KnownPrivateService` is `never`),
// so the cases run through `__privateServiceFetchForTest` with a synthetic table. Nothing here
// asserts the shipped table's emptiness: that stops being true on a fork's first service, and the
// gate (`npm run verify:edge`) proves it on the kit alone.
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
  __privateServiceFetchForTest,
  bindingForPrivateService,
  hostVarForBinding,
  MAX_TIMEOUT_MS,
  PRIVATE_SERVICE_FAILURES,
  PRIVATE_SERVICES,
  PrivateServiceError,
  type PrivateServiceFailure,
  privateServiceFetch,
  requestUrl,
} from '../../src/data/privateServices';
import type { Env } from '../../src/env';
import { AppError } from '../../src/framework/errors';
import { captureLogs } from '../helpers/logs';

const TABLE = { example_api: 'EXAMPLE_API_TOKEN' } as const;
const HOST = 'example-api.private.staging.example.test';
// Synthetic — a credential-shaped string the log assertions can search for.
const TOKEN = 'synthetic-token-7f3a9c';

interface Call {
  url: string;
  init: RequestInit | undefined;
}

/** A fake Workers VPC service binding: records each call, answers with `respond`. */
function fakeBinding(respond: (url: string, init?: RequestInit) => Promise<Response> | Response) {
  const calls: Call[] = [];
  return {
    calls,
    fetch: async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return respond(url, init);
    },
  };
}

function envWith(extra: Record<string, unknown>): Env {
  return { ...env, ...extra } as unknown as Env;
}

/** An env carrying the binding, its host and the credential — the fully configured case. */
function configured(binding = fakeBinding(() => new Response('ok'))) {
  return {
    binding,
    env: envWith({
      VPC_EXAMPLE_API: binding,
      VPC_EXAMPLE_API_HOST: HOST,
      EXAMPLE_API_TOKEN: TOKEN,
    }),
  };
}

async function expectFailure(
  call: Promise<unknown>,
  reason: PrivateServiceFailure,
): Promise<PrivateServiceError> {
  const err = await call.then(
    () => {
      throw new Error(`expected a ${reason} failure`);
    },
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(PrivateServiceError);
  expect(err).toBeInstanceOf(AppError);
  const e = err as PrivateServiceError;
  expect(e.reason).toBe(reason);
  // Whatever the reason, what reaches a response is the kit's opaque 500.
  expect([e.status, e.code, e.message]).toEqual([500, 'internal_error', 'Something went wrong']);
  return e;
}

/** `p`, or a rejection if it has not settled within `ms` — a pending call fails, it does not hang. */
function settlesWithin<T>(p: Promise<T>, ms = 500): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_resolve, reject) =>
      setTimeout(() => reject(new Error(`still pending after ${ms} ms`)), ms),
    ),
  ]);
}

describe('naming — one derivation, shared with the gate', () => {
  it('derives the binding and its host var from the service name', () => {
    expect(bindingForPrivateService('example_api')).toBe('VPC_EXAMPLE_API');
    expect(hostVarForBinding('VPC_EXAMPLE_API')).toBe('VPC_EXAMPLE_API_HOST');
  });
});

describe('the public entry point', () => {
  // `privateServiceFetch` reads the REVIEWED table and nothing else: a fully configured binding,
  // host and secret are not enough for a service that table does not list. In the kit the table is
  // empty, so every name is refused; in a fork, a name it has not registered is.
  it('refuses a service the reviewed table does not list, however well configured', async () => {
    let name = 'example_api_unlisted';
    while (Object.hasOwn(PRIVATE_SERVICES, name)) name = `${name}_x`;
    const binding = fakeBinding(() => new Response('ok'));
    const upper = name.toUpperCase();
    const e = envWith({
      [`VPC_${upper}`]: binding,
      [`VPC_${upper}_HOST`]: HOST,
      EXAMPLE_API_TOKEN: TOKEN,
    });
    await expectFailure(privateServiceFetch(e, name as never, '/x'), 'unregistered');
    expect(binding.calls).toHaveLength(0);
  });
});

describe('a configured call', () => {
  it('goes through the binding to https://<host><path>, with the credential', async () => {
    const { binding, env: e } = configured();
    const res = await __privateServiceFetchForTest(e, TABLE, 'example_api', '/v1/items?limit=2');
    expect(await res.text()).toBe('ok');
    expect(binding.calls).toHaveLength(1);
    const [call] = binding.calls;
    expect(call?.url).toBe(`https://${HOST}/v1/items?limit=2`);
    const headers = new Headers(call?.init?.headers);
    expect(headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
    expect(call?.init?.redirect).toBe('manual');
    expect(call?.init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('passes the method, body and the caller’s own headers through', async () => {
    const { binding, env: e } = configured();
    await __privateServiceFetchForTest(e, TABLE, 'example_api', '/v1/items', {
      method: 'POST',
      body: '{"a":1}',
      headers: { 'content-type': 'application/json' },
    });
    const init = binding.calls[0]?.init;
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe('{"a":1}');
    expect(new Headers(init?.headers).get('content-type')).toBe('application/json');
  });

  it('reads the credential from a Secrets Store binding too', async () => {
    const { binding, env: e } = configured();
    const store = envWith({ ...e, EXAMPLE_API_TOKEN: { get: async () => TOKEN } });
    await __privateServiceFetchForTest(store, TABLE, 'example_api', '/v1/items');
    expect(new Headers(binding.calls[0]?.init?.headers).get('authorization')).toBe(
      `Bearer ${TOKEN}`,
    );
  });

  // Mapping a 4xx/5xx is the integration module's job; the transport returns it untouched.
  it('returns a non-redirect error status as-is', async () => {
    const { env: e } = configured(fakeBinding(() => new Response('nope', { status: 403 })));
    const res = await __privateServiceFetchForTest(e, TABLE, 'example_api', '/v1/items');
    expect(res.status).toBe(403);
  });
});

describe('what it refuses — before anything leaves the Worker', () => {
  it('a service the table does not register, including inherited keys', async () => {
    const { binding, env: e } = configured();
    for (const name of ['other_service', 'toString', '__proto__', 'Example_Api']) {
      await expectFailure(__privateServiceFetchForTest(e, TABLE, name, '/x'), 'unregistered');
    }
    expect(binding.calls).toHaveLength(0);
  });

  it('a table entry that does not name a secret', async () => {
    const { binding, env: e } = configured();
    await expectFailure(
      __privateServiceFetchForTest(e, { example_api: 'not a secret' }, 'example_api', '/x'),
      'unregistered',
    );
    expect(binding.calls).toHaveLength(0);
  });

  // Mid-rollout this is normal (staging binds, production does not yet). It must fail closed, not
  // fall back to a raw fetch of the host.
  it('a registered service with no binding, or something that is not one', async () => {
    const { env: e } = configured();
    for (const binding of [undefined, null, 'VPC', { connectionString: 'x' }]) {
      await expectFailure(
        __privateServiceFetchForTest(
          envWith({ ...e, VPC_EXAMPLE_API: binding }),
          TABLE,
          'example_api',
          '/x',
        ),
        'binding_missing',
      );
    }
  });

  it('a missing or malformed host var', async () => {
    const { binding, env: e } = configured();
    for (const host of [
      undefined,
      '',
      'https://example-api.example.test',
      'example-api.example.test:8443',
      'example-api.example.test/x',
      'user@example-api.example.test',
      'Example-Api.example.test',
      'localhost',
      'example-api.example.test.',
    ]) {
      await expectFailure(
        __privateServiceFetchForTest(
          envWith({ ...e, VPC_EXAMPLE_API_HOST: host }),
          TABLE,
          'example_api',
          '/x',
        ),
        'host_invalid',
      );
    }
    expect(binding.calls).toHaveLength(0);
  });

  it('a missing credential, plain or from the store', async () => {
    const { binding, env: e } = configured();
    for (const secret of [
      undefined,
      '',
      { get: async () => '' },
      {
        get: async () => {
          throw new Error('store down');
        },
      },
    ]) {
      await expectFailure(
        __privateServiceFetchForTest(
          envWith({ ...e, EXAMPLE_API_TOKEN: secret }),
          TABLE,
          'example_api',
          '/x',
        ),
        'credential_missing',
      );
    }
    expect(binding.calls).toHaveLength(0);
  });

  it('a path that could reach another origin, or is not a plain path', async () => {
    const { binding, env: e } = configured();
    for (const path of [
      '',
      'v1/items',
      '//evil.example.test/x',
      'https://evil.example.test/x',
      '/\\evil.example.test',
      '/x#frag',
      '/x y',
      '/x\ny',
      '/x\u0000',
    ]) {
      await expectFailure(
        __privateServiceFetchForTest(e, TABLE, 'example_api', path),
        'request_refused',
      );
    }
    expect(binding.calls).toHaveLength(0);
  });

  it('a timeout outside 1..MAX_TIMEOUT_MS', async () => {
    const { binding, env: e } = configured();
    for (const timeoutMs of [0, -1, 1.5, MAX_TIMEOUT_MS + 1, Number.NaN]) {
      await expectFailure(
        __privateServiceFetchForTest(e, TABLE, 'example_api', '/x', { timeoutMs }),
        'request_refused',
      );
    }
    expect(binding.calls).toHaveLength(0);
  });

  // `cf.resolveOverride` changes where a request resolves; where the call goes is not a caller's.
  it('a caller-set cf override', async () => {
    const { binding, env: e } = configured();
    await expectFailure(
      __privateServiceFetchForTest(e, TABLE, 'example_api', '/x', {
        cf: { resolveOverride: 'evil.example.test' },
      } as never),
      'request_refused',
    );
    expect(binding.calls).toHaveLength(0);
  });

  // The credential and the routing are the transport's: a caller cannot replace either.
  it('a caller-set Authorization or Host header', async () => {
    const { binding, env: e } = configured();
    for (const headers of <Record<string, string>[]>[
      { authorization: 'Bearer other' },
      { Authorization: 'Basic x' },
      { host: 'evil.example.test' },
    ]) {
      await expectFailure(
        __privateServiceFetchForTest(e, TABLE, 'example_api', '/x', { headers }),
        'header_refused',
      );
    }
    expect(binding.calls).toHaveLength(0);
  });
});

describe('what it refuses — after the call', () => {
  // A 3xx could send the credential-bearing request anywhere; it is never followed.
  it('a redirect, whatever its Location', async () => {
    for (const status of [301, 302, 303, 307, 308]) {
      const { env: e } = configured(
        fakeBinding(
          () => new Response(null, { status, headers: { location: 'https://evil.example.test/' } }),
        ),
      );
      await expectFailure(
        __privateServiceFetchForTest(e, TABLE, 'example_api', '/x'),
        'redirect_refused',
      );
    }
  });

  it('a network failure, as a transient one', async () => {
    const { env: e } = configured(
      fakeBinding(() => {
        throw new TypeError(`connect failed to https://${HOST}/x`);
      }),
    );
    const err = await expectFailure(
      __privateServiceFetchForTest(e, TABLE, 'example_api', '/x'),
      'network',
    );
    expect(err.transient).toBe(true);
  });

  it('a call that outlives its timeout, as a transient one', async () => {
    const { env: e } = configured(
      fakeBinding(
        (_url, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
          }),
      ),
    );
    const err = await expectFailure(
      __privateServiceFetchForTest(e, TABLE, 'example_api', '/x', { timeoutMs: 20 }),
      'timeout',
    );
    expect(err.transient).toBe(true);
  });

  // Codex audit F1: the deadline bounds the WHOLE call. Each case below used to stay pending well
  // past its timeout; `settlesWithin` turns "still pending" into a failure instead of a hang.
  it('times out a credential lookup that stalls, without calling the service', async () => {
    const { binding, env: e } = configured();
    const stalled = envWith({ ...e, EXAMPLE_API_TOKEN: { get: () => new Promise(() => {}) } });
    await expectFailure(
      settlesWithin(
        __privateServiceFetchForTest(stalled, TABLE, 'example_api', '/x', { timeoutMs: 20 }),
      ),
      'timeout',
    );
    expect(binding.calls).toHaveLength(0);
  });

  it('times out a binding that ignores the abort signal', async () => {
    const { env: e } = configured(fakeBinding(() => new Promise<Response>(() => {})));
    await expectFailure(
      settlesWithin(__privateServiceFetchForTest(e, TABLE, 'example_api', '/x', { timeoutMs: 20 })),
      'timeout',
    );
  });

  it('refuses a redirect without waiting on a body whose cancel stalls', async () => {
    const body = new ReadableStream({ cancel: () => new Promise<void>(() => {}) });
    const { env: e } = configured(
      fakeBinding(
        () => new Response(body, { status: 302, headers: { location: 'https://x.test/' } }),
      ),
    );
    await expectFailure(
      settlesWithin(__privateServiceFetchForTest(e, TABLE, 'example_api', '/x')),
      'redirect_refused',
    );
  });

  it('honours the caller’s own abort signal, as a non-transient `aborted`', async () => {
    const controller = new AbortController();
    const { env: e } = configured(
      fakeBinding(
        (_url, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
            controller.abort();
          }),
      ),
    );
    const err = await expectFailure(
      __privateServiceFetchForTest(e, TABLE, 'example_api', '/x', {
        signal: controller.signal,
      }),
      'aborted',
    );
    expect(err.transient).toBe(false);
  });
});

describe('log hygiene', () => {
  it('logs the service and the reason — never the host, path or credential', async () => {
    const logs = captureLogs();
    try {
      const { env: e } = configured(
        fakeBinding(() => {
          throw new TypeError(`connect failed to https://${HOST}/v1/secret-path?token=${TOKEN}`);
        }),
      );
      await expectFailure(
        __privateServiceFetchForTest(e, TABLE, 'example_api', '/v1/secret-path'),
        'network',
      );
      expect(logs.named('private_service_failed')).toEqual([
        expect.objectContaining({ service: 'example_api', reason: 'network' }),
      ]);
      logs.expectAbsent(HOST, TOKEN, 'secret-path');
    } finally {
      logs.restore();
    }
  });

  it('every reason is a registered log value', () => {
    expect(new Set(PRIVATE_SERVICE_FAILURES).size).toBe(PRIVATE_SERVICE_FAILURES.length);
  });
});

describe('requestUrl', () => {
  it('keeps the path and query on the configured origin', () => {
    expect(requestUrl(HOST, '/a/b?c=1&d=2')).toBe(`https://${HOST}/a/b?c=1&d=2`);
    // Dot segments resolve, but can never climb off the origin.
    expect(requestUrl(HOST, '/a/../../b')).toBe(`https://${HOST}/b`);
  });

  it('refuses anything that is not a single-slash path', () => {
    for (const path of ['', 'a', '//x', '/\\x', '/a#b', '/a b']) {
      expect(requestUrl(HOST, path)).toBeNull();
    }
  });
});

// Typed client for the canonical kit envelope: { ok: true, data } | { ok: false, error }.
// Every /api/* call is built from the pinned route table (endpoints.ts) via call(), so the
// client's method+path can't drift from the worker registry. /auth/* surfaces live outside
// defineRoute, so they call request() directly with their literal paths.
import { API_ENDPOINTS, type EndpointId } from './endpoints';
import type {
  AlertingConfig,
  AuditRow,
  Me,
  Note,
  NotePage,
  ReadLogCursor,
  ReadLogRow,
  ServiceIdentity,
  TokenRow,
  UserRow,
} from './types';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  // Only advertise a JSON body when we actually send one. Announcing `content-type:
  // application/json` on a bodiless DELETE is what made the server try to parse an empty body
  // (it 400'd every delete button). The server no longer trusts the header alone, but sending it
  // truthfully is the half that belongs here — the two fixes are independent on purpose.
  const headers: Record<string, string> = { ...((init?.headers as Record<string, string>) ?? {}) };
  if (init?.body !== undefined && init?.body !== null && !('content-type' in headers)) {
    headers['content-type'] = 'application/json';
  }
  const res = await fetch(path, { ...init, headers });
  if (res.status === 204) return undefined as T;
  let body: { ok?: boolean; data?: T; error?: { code: string; message: string } };
  try {
    body = (await res.json()) as typeof body;
  } catch {
    throw new ApiError(res.status, 'bad_response', 'Unexpected response');
  }
  if (!res.ok || body.ok === false) {
    const err = body.error ?? { code: 'unknown', message: 'Request failed' };
    throw new ApiError(res.status, err.code, err.message);
  }
  return body.data as T;
}

// Build and send a request for one named endpoint. Path :params are substituted (URL-encoded),
// query is appended (undefined values dropped), and a body is JSON-serialized only when given.
// Method + path come from API_ENDPOINTS — never inline — so a route change surfaces as a
// pinned-table drift the test catches, not a silently-stale string here.
function call<T>(
  id: EndpointId,
  opts: {
    params?: Record<string, string>;
    query?: Record<string, string | number | undefined>;
    body?: unknown;
  } = {},
): Promise<T> {
  const { method, path } = API_ENDPOINTS[id];
  let url: string = path;
  for (const [k, v] of Object.entries(opts.params ?? {})) {
    url = url.replace(`:${k}`, encodeURIComponent(v));
  }
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(opts.query ?? {})) {
    if (v !== undefined) qs.set(k, String(v));
  }
  const q = qs.toString();
  return request<T>(q ? `${url}?${q}` : url, {
    method,
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
}

export const api = {
  me: () => call<Me>('me.get'),
  // Public login-page config. Empty turnstile_site_key = bot-challenge disabled;
  // entra_enabled = show the "Sign in with Microsoft" path (fully configured server-side);
  // entra_only = magic links are switched off for this app; entra_domains = email domains
  // the form steers to Microsoft instead of sending a link (UX only).
  loginConfig: () =>
    request<{
      turnstile_site_key: string;
      entra_enabled: boolean;
      entra_only: boolean;
      entra_domains: string[];
    }>('/auth/config'),
  requestLink: (email: string, turnstileToken = '') =>
    request<{ message: string }>('/auth/request', {
      method: 'POST',
      body: JSON.stringify({ email, return_to: '/', turnstile_token: turnstileToken }),
    }),
  logout: () => request<void>('/auth/logout', { method: 'POST' }),

  notes: {
    list: (cursor?: string) => call<NotePage>('notes.list', { query: { limit: 20, cursor } }),
    create: (title: string, body: string) => call<Note>('notes.create', { body: { title, body } }),
    update: (id: string, patch: { title?: string; body?: string }) =>
      call<Note>('notes.update', { params: { id }, body: patch }),
    remove: (id: string) => call<void>('notes.remove', { params: { id } }),
  },

  users: {
    list: (cursor?: string) =>
      call<{ users: UserRow[]; next_cursor: string | null }>('users.list', {
        query: { limit: 50, cursor },
      }),
    invite: (email: string, name: string, role: string) =>
      call<UserRow>('users.invite', { body: { email, name, role } }),
    update: (email: string, patch: { role?: string; disabled?: boolean }) =>
      call<UserRow>('users.update', { params: { email }, body: patch }),
    // No `body: {}` here any more — that was a workaround for the framework choking on a
    // bodiless mutation (it patched this one symptom while every other DELETE stayed broken).
    revokeSessions: (email: string) =>
      call<{ revoked: boolean }>('users.revokeSessions', { params: { email } }),
  },

  audit: {
    list: (before?: number) =>
      call<{ items: AuditRow[]; next_before: number | null }>('audit.list', {
        query: { limit: 50, before },
      }),
  },

  readLog: {
    // The cursor is composite — (created_at, id) — and query strings cannot nest, so its two
    // halves travel flat and the worker recombines them. Sending one without the other is a 400
    // by design; this wrapper only ever forwards the whole cursor the last page handed back.
    list: (before?: ReadLogCursor | null) =>
      call<{ items: ReadLogRow[]; next_before: ReadLogCursor | null }>('readLog.list', {
        query: {
          limit: 50,
          before_created_at: before?.created_at,
          before_id: before?.id,
        },
      }),
  },

  tokens: {
    list: () => call<{ tokens: TokenRow[] }>('tokens.list'),
    create: (name: string, expiresInDays?: number) =>
      call<TokenRow & { token: string }>('tokens.create', {
        body: { name, expires_in_days: expiresInDays },
      }),
    revoke: (id: number) => call<void>('tokens.remove', { params: { id: String(id) } }),
  },

  serviceIdentities: {
    list: () =>
      call<{ service_identities: ServiceIdentity[]; grantable_scopes: string[] }>(
        'serviceIdentities.list',
      ),
    create: (input: { slug: string; name: string; scope: string; custodian_email: string }) =>
      call<ServiceIdentity>('serviceIdentities.create', { body: input }),
    update: (id: number, patch: { name?: string; custodian_email?: string; disabled?: boolean }) =>
      call<ServiceIdentity>('serviceIdentities.update', {
        params: { id: String(id) },
        body: patch,
      }),
    tokens: (id: number) =>
      call<{ tokens: TokenRow[] }>('serviceIdentities.tokens', { params: { id: String(id) } }),
    mint: (id: number, name: string, expiresInDays: number) =>
      call<TokenRow & { token: string }>('serviceIdentities.mint', {
        params: { id: String(id) },
        body: { name, expires_in_days: expiresInDays },
      }),
    revokeToken: (id: number, tokenId: number) =>
      call<void>('serviceIdentities.revokeToken', {
        params: { id: String(id), tokenId: String(tokenId) },
      }),
    revokeAll: (id: number) =>
      call<{ revoked: number }>('serviceIdentities.revokeAll', { params: { id: String(id) } }),
  },

  settings: {
    getLogin: () =>
      call<{
        entraOnly: boolean;
        entraOnlyEffective: boolean;
        entraConfigured: boolean;
        entraProven: boolean;
        entraUnprovenTenants: string[];
      }>('settings.getLogin'),
    setLogin: (entraOnly: boolean) =>
      call<{ entraOnly: boolean }>('settings.setLogin', { body: { entraOnly } }),
    getAlerting: () => call<AlertingConfig>('settings.getAlerting'),
    // slack: omit to keep the stored channel, { clear: true } to remove it, or
    // { url } to set/replace it. The stored URL is never read back from the server.
    setAlerting: (recipients: string[], slack: { url?: string; clear?: boolean } = {}) =>
      call<{ recipients: string[]; slackWebhookConfigured: boolean }>('settings.setAlerting', {
        body: {
          recipients,
          ...(slack.clear
            ? { slackWebhookUrl: '' }
            : slack.url
              ? { slackWebhookUrl: slack.url }
              : {}),
        },
      }),
  },
};

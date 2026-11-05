// THE API CLIENT'S ROUTE TABLE — the SPA's single source for the method + path of every
// worker endpoint it calls. api.ts builds every request from this table, and
// test/web/api-client.test.ts PINS it to the live worker route registry (src/routes/): a
// renamed path, a changed method, a removed route, or a new route the SPA ought to call but
// doesn't, fails CI. This is the same "mirror pinned by a test" guard the permission matrix
// uses — the client can no longer silently drift from the routes it calls.
//
// When you add or change a route: update the entry here (path must match the worker route
// EXACTLY, including the :param names) and its wrapper in api.ts. The test names the drift.
export interface ClientEndpoint {
  readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Path template with :params, byte-identical to the worker route. */
  readonly path: string;
}

export const API_ENDPOINTS = {
  'me.get': { method: 'GET', path: '/api/me' },
  'notes.list': { method: 'GET', path: '/api/notes' },
  'notes.create': { method: 'POST', path: '/api/notes' },
  'notes.update': { method: 'PUT', path: '/api/notes/:id' },
  'notes.remove': { method: 'DELETE', path: '/api/notes/:id' },
  'users.list': { method: 'GET', path: '/api/users' },
  'users.invite': { method: 'POST', path: '/api/users' },
  'users.update': { method: 'PATCH', path: '/api/users/:email' },
  'users.revokeSessions': { method: 'POST', path: '/api/users/:email/revoke-sessions' },
  'audit.list': { method: 'GET', path: '/api/audit' },
  'readLog.list': { method: 'GET', path: '/api/read-log' },
  'tokens.list': { method: 'GET', path: '/api/tokens' },
  'tokens.create': { method: 'POST', path: '/api/tokens' },
  'tokens.remove': { method: 'DELETE', path: '/api/tokens/:id' },
  'serviceIdentities.list': { method: 'GET', path: '/api/service-identities' },
  'serviceIdentities.create': { method: 'POST', path: '/api/service-identities' },
  'serviceIdentities.update': { method: 'PATCH', path: '/api/service-identities/:id' },
  'serviceIdentities.tokens': { method: 'GET', path: '/api/service-identities/:id/tokens' },
  'serviceIdentities.mint': { method: 'POST', path: '/api/service-identities/:id/tokens' },
  'serviceIdentities.revokeToken': {
    method: 'DELETE',
    path: '/api/service-identities/:id/tokens/:tokenId',
  },
  'serviceIdentities.revokeAll': {
    method: 'POST',
    path: '/api/service-identities/:id/revoke-tokens',
  },
  'settings.getAlerting': { method: 'GET', path: '/api/settings/alerting' },
  'settings.setAlerting': { method: 'PUT', path: '/api/settings/alerting' },
  'settings.getLogin': { method: 'GET', path: '/api/settings/login' },
  'settings.setLogin': { method: 'PUT', path: '/api/settings/login' },
} as const satisfies Record<string, ClientEndpoint>;

export type EndpointId = keyof typeof API_ENDPOINTS;

// The `node` Vitest project's setup (vitest.config.ts). Portable tests must inject their fetcher;
// moving them out of Workers must not turn an accidental request into live traffic. Every file
// and every test starts from this baseline: fetch rejects and the WebSocket constructor throws
// until a test stubs them, and a stub ends with that test. node-no-network.test.ts exercises
// both; the import guard (scripts/test-runtime-boundary.mjs) keeps a listed file's own imports
// off node:http, node:net and the like. A package that opens its own sockets (undici, ws, a
// database client) is not covered: a test that needs one stays in Workers (#291 review F11).
import { beforeEach } from 'vitest';

function blockedFetch(): Promise<Response> {
  return Promise.reject(new Error('Node tests must stub fetch; outbound network is disabled.'));
}

const BlockedWebSocket = class {
  constructor() {
    throw new Error('Node tests must stub WebSocket; outbound network is disabled.');
  }
} as unknown as typeof WebSocket;

function block() {
  globalThis.fetch = blockedFetch;
  globalThis.WebSocket = BlockedWebSocket;
}

block();
beforeEach(block);

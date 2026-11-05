// The Node project's network guard (node-no-network.ts), exercised (#257 review F19): an unstubbed
// fetch rejects, and an unstubbed WebSocket throws, with the guard's own message; a stub works
// within its own test, and the next test starts from the guard again. Listed in nodeTestFiles
// (test/projects.mjs); the first case fails if it ever runs in a Workers project instead.
import { describe, expect, it } from 'vitest';

const REFUSED = 'Node tests must stub fetch; outbound network is disabled.';
const REFUSED_SOCKET = 'Node tests must stub WebSocket; outbound network is disabled.';
// A reserved name that never resolves: a guard that fell through to the real fetch fails on the
// lookup, with another message, and reaches no host.
const NOWHERE = 'https://network-guard.invalid/';

describe('Node project network guard', () => {
  it('runs in plain Node, not a Workers runtime', () => {
    expect('WebSocketPair' in globalThis).toBe(false);
  });

  it('refuses an unstubbed fetch', async () => {
    await expect(fetch(NOWHERE)).rejects.toThrow(REFUSED);
  });

  it('lets a test stub fetch for itself', async () => {
    globalThis.fetch = async () => new Response('stubbed');
    await expect((await fetch(NOWHERE)).text()).resolves.toBe('stubbed');
  });

  it("does not carry the previous test's stub into the next test", async () => {
    await expect(fetch(NOWHERE)).rejects.toThrow(REFUSED);
  });

  // Node's global WebSocket opens a socket without fetch (#291 review F11).
  it('refuses an unstubbed WebSocket', () => {
    expect(() => new WebSocket('wss://network-guard.invalid/')).toThrow(REFUSED_SOCKET);
  });

  it('lets a test stub WebSocket for itself, until the next test', () => {
    const stub = class {} as unknown as typeof WebSocket;
    globalThis.WebSocket = stub;
    expect(globalThis.WebSocket).toBe(stub);
  });

  it("does not carry the previous test's WebSocket stub into the next test", () => {
    expect(() => new WebSocket('wss://network-guard.invalid/')).toThrow(REFUSED_SOCKET);
  });
});

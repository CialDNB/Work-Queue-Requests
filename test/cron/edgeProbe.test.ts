import { afterEach, describe, expect, it, vi } from 'vitest';
import { runEdgeProbe } from '../../src/cron/edgeProbe';
import type { Env } from '../../src/env';

// runEdgeProbe reads APP_NAME + WORKERS_DEV_HOST and global fetch — no bindings — so a plain cast
// env is enough.
const envWith = (over: Partial<Env>): Env => ({ APP_NAME: 'test-app', ...over }) as unknown as Env;
const WD = 'test-app.acct.workers.dev';

const stub = (handler: () => Response | Promise<Response>) =>
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => handler());

afterEach(() => vi.restoreAllMocks());

describe('runEdgeProbe', () => {
  it('is dormant (and never fetches) when WORKERS_DEV_HOST is unset', async () => {
    const fetchSpy = stub(() => new Response('x'));
    expect(await runEdgeProbe(envWith({}))).toMatch(/dormant/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('passes when the workers.dev host is unreachable (the healthy "off" state)', async () => {
    stub(() => {
      throw new Error('ENOTFOUND'); // workers.dev disabled → the host does not resolve
    });
    expect(await runEdgeProbe(envWith({ WORKERS_DEV_HOST: WD }))).toMatch(/is not serving — ok/);
  });

  it('passes when the host answers non-2xx (not our ingress)', async () => {
    stub(() => new Response('nope', { status: 404 }));
    expect(await runEdgeProbe(envWith({ WORKERS_DEV_HOST: WD }))).toMatch(/is not serving — ok/);
  });

  it('PAGES (throws) when workers.dev is serving THIS app', async () => {
    stub(() => new Response(JSON.stringify({ app: 'test-app', status: 'ok' }), { status: 200 }));
    await expect(runEdgeProbe(envWith({ WORKERS_DEV_HOST: WD }))).rejects.toThrow(
      /workers\.dev ingress .* is SERVING this app/,
    );
  });

  it('does NOT page on a 2xx from another host — incl. a health-shaped body for a DIFFERENT app', async () => {
    // The false-page vector: a parked/placeholder host answering the workers.dev name with the
    // ubiquitous {"status":"ok"} shape. App-name identity is required, so this must NOT page.
    stub(
      () => new Response(JSON.stringify({ status: 'ok', app: 'some-other-app' }), { status: 200 }),
    );
    expect(await runEdgeProbe(envWith({ WORKERS_DEV_HOST: WD }))).toMatch(/is not serving — ok/);
  });
});

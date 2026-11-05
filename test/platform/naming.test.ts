// Pins the attributability naming scheme. If these expectations change, the
// handbook, provision script, and RESOURCES.md conventions must change with them.
import { describe, expect, it } from 'vitest';
import { isValidAppName, resourceNames } from '../../src/platform/naming';

describe('resource naming scheme', () => {
  it('derives every resource name from the app name', () => {
    expect(resourceNames('arena-go')).toEqual({
      worker: 'arena-go',
      workerStaging: 'arena-go-staging',
      d1: 'arena-go-db',
      d1Staging: 'arena-go-db-staging',
      kvSessions: 'arena-go-sessions',
      kvSessionsStaging: 'arena-go-sessions-staging',
      kvCache: 'arena-go-cache',
      r2Backups: 'arena-go-backups',
      r2BackupsStaging: 'arena-go-backups-staging',
      r2Media: 'arena-go-media',
      // The one deliberate non-derived name: the FLEET-SHARED gateway (20/account cap;
      // per-app attribution rides cf-aig-metadata). Pin the VALUE — a drift back to a
      // per-app id would recreate a gateway per fork and re-hit the cap.
      aiGateway: 'all-pr-apps',
      dnsProd: 'arena-go.cialdnb.ai',
      dnsStaging: 'staging-arena-go.cialdnb.ai',
      githubRepo: 'CialDNB/arena-go',
      secretPrefix: 'arena-go',
    });
  });

  it('rejects names that would break attributability', () => {
    for (const bad of ['Arena', 'a', 'app--x', '-app', 'app-', '1app', 'app_name', 'app name']) {
      expect(isValidAppName(bad), bad).toBe(false);
      expect(() => resourceNames(bad)).toThrow();
    }
    for (const good of ['atlas', 'arena-go', 'docs-hub2', 'paved-road']) {
      expect(isValidAppName(good), good).toBe(true);
    }
  });
});

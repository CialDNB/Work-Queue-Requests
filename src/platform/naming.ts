// THE naming scheme (single source of truth). The Cial Cloudflare account is shared
// across business lines — every resource must be attributable to its app at a glance.
// scripts/provision.mjs applies these names automatically; tests pin them so drift
// fails CI. The counterpart rule: binding names inside code stay CANONICAL across all
// kit apps (DB, SESSIONS, BACKUPS, EMAIL, CACHE, MEDIA) — the app prefix lives in the
// resource name, never the binding.

export interface ResourceNames {
  worker: string;
  workerStaging: string;
  d1: string;
  d1Staging: string;
  kvSessions: string;
  kvSessionsStaging: string;
  kvCache: string;
  r2Backups: string;
  r2BackupsStaging: string;
  r2Media: string;
  aiGateway: string;
  dnsProd: string;
  dnsStaging: string;
  githubRepo: string;
  secretPrefix: string;
}

/** The ONE fleet-shared AI Gateway every kit app routes through. Cloudflare caps AI
 *  Gateways at ~20 per account, so per-app gateways stopped scaling — attribution moved
 *  into the `cf-aig-metadata` header ({ app, env }; src/ai/anthropic.ts). The id is the
 *  deliberate exception to "every resource name derives from the app": it must be
 *  IDENTICAL across the fleet, and it deliberately avoids the template's kebab identity,
 *  so the bootstrap rename has nothing to match in it. See DECISIONS 2026-08-28. */
export const FLEET_AI_GATEWAY_ID = 'all-pr-apps';

const APP_NAME_PATTERN = /^[a-z][a-z0-9-]{1,38}[a-z0-9]$/;

export function isValidAppName(app: string): boolean {
  return APP_NAME_PATTERN.test(app) && !app.includes('--');
}

export function resourceNames(app: string): ResourceNames {
  if (!isValidAppName(app)) {
    throw new Error(
      `Invalid app name "${app}": kebab-case, 3-40 chars, starts with a letter, no double hyphens`,
    );
  }
  return {
    worker: app,
    workerStaging: `${app}-staging`,
    d1: `${app}-db`,
    d1Staging: `${app}-db-staging`,
    kvSessions: `${app}-sessions`,
    kvSessionsStaging: `${app}-sessions-staging`,
    kvCache: `${app}-cache`,
    r2Backups: `${app}-backups`,
    r2BackupsStaging: `${app}-backups-staging`,
    r2Media: `${app}-media`,
    aiGateway: FLEET_AI_GATEWAY_ID, // fleet-shared, NOT per-app — see the constant above
    dnsProd: `${app}.cialdnb.ai`,
    dnsStaging: `staging-${app}.cialdnb.ai`,
    githubRepo: `CialDNB/${app}`,
    secretPrefix: app,
  };
}

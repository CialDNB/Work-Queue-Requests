#!/usr/bin/env node
// Provisions Cloudflare resources for this app, applying THE kit naming scheme
// (mirrors src/platform/naming.ts — keep both in sync; the naming test pins it),
// fills the PLACEHOLDER_RUN_PROVISION ids in wrangler config, and regenerates
// docs/RESOURCES.md so every resource on the shared account stays attributable.
//
// Usage:
//   node scripts/provision.mjs --plan                 # print the plan, no network
//   node scripts/provision.mjs --env staging          # create staging resources
//   node scripts/provision.mjs --env production       # create production resources
//
// Auth: CLOUDFLARE_API_TOKEN must be a PER-APP SCOPED, ACCOUNT-OWNED token (never a
// global key, never a personal/user-owned one — it has to outlive the builder; see
// docs/DECISIONS.md 2026-07-13). Required scopes (the HQ-17 pattern): Workers Scripts:Edit,
// D1:Edit, Workers KV Storage:Edit, R2:Edit, Secrets Store:Edit, AI Gateway:READ (read-only on
// purpose — the gateway is fleet-shared, and account-scope Edit on every app's CI token would
// let any one leaked token delete or de-authenticate it for the whole fleet; this script
// VERIFIES the gateway, attempting a create only on a genuine 404 — which succeeds solely
// under a platform-owner credential that carries Edit — DECISIONS 2026-08-28), Email
// Sending:Write (account — the outbound send_email permission, NOT inbound Email Routing); zone
// cialdnb.ai only: Zone DNS:Edit, Zone Workers Routes:Edit, Zone WAF:Edit, Zone Read. Workers
// Routes is needed even for custom-domain-only configs: `workers_dev: false` puts wrangler on a
// route-precheck path that GETs /zones/{zone}/workers/routes, and without the scope a deploy
// uploads the Worker and THEN fails 10000 (DECISIONS 2026-07-27). Zone WAF is what grants
// GET/PUT on /zones/{zone}/rulesets/phases/*/entrypoint — ensureEdgeRule below writes the
// kit:auth-rate-limit rule there, and check-edge-live.mjs reads all three phases for GO-LIVE
// gate 11; without it both fail with the same opaque 10000 (issue #182 — the third instance
// of the missing-scope pattern, after Workers Routes #140 and Zone Read/Email Sending 0.2.1). NOTE: the per-app runtime
// secrets ANTHROPIC_API_KEY + AI_GATEWAY_TOKEN are PER-WORKER plain secrets now (AICOE-467;
// DECISIONS 2026-08-04), NOT account Secrets Store entries — so this script does NOT create or
// mint them: a per-Worker secret lives ON the Worker, which a new app first gets at its first
// deploy (`wrangler secret put` before then silently creates a stub Worker — see the next steps),
// and minting a token here would only leak its VALUE into provision's logs/artifacts. They are
// declared `required` in the wrangler configs (a deploy fails closed if either is missing) and
// set on the FIRST deploy via `--secrets-file` (this script prints the exact next-steps). Without
// AI_GATEWAY_TOKEN, PRODUCTION AI fails closed (503 ai_unconfigured — the AI client refuses the
// direct-provider fallback in prod, DECISIONS 2026-06-23); dev/staging fall back to direct calls.
// Creation runbook: docs/IMPLEMENTATION-HANDBOOK.md §8.1.
import { readFileSync, writeFileSync } from 'node:fs';
import { cialRefusal, resolveDeploymentTarget } from './deployment-target.mjs';
import {
  AUTH_RL_MARKER,
  authRateLimitRule,
  HOST_PIN_MARKER,
  hostPinRule,
  PHASES,
  readPhaseRules,
  upsertRuleByMarker,
} from './edge-rules.mjs';
import { isMainModule } from './kit-checks/main-module.mjs';

const API = 'https://api.cloudflare.com/client/v4';

// Strip `//` + block comments WITHOUT touching comment-like sequences inside string values
// (a `//` in a URL value must survive). Mirrors src/platform/bootstrap.ts stripJsoncComments.
function stripJsonc(text) {
  let out = '';
  let inStr = false;
  let esc = false;
  let line = false;
  let block = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const n = text[i + 1];
    if (line) {
      if (c === '\n') {
        line = false;
        out += c;
      }
    } else if (block) {
      if (c === '*' && n === '/') {
        block = false;
        i++;
      }
    } else if (inStr) {
      out += c;
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') {
      inStr = true;
      out += c;
    } else if (c === '/' && n === '/') {
      line = true;
      i++;
    } else if (c === '/' && n === '*') {
      block = true;
      i++;
    } else {
      out += c;
    }
  }
  return out;
}

function readWranglerConfig(path) {
  return JSON.parse(stripJsonc(readFileSync(path, 'utf8')));
}

// docs/RESOURCES.md may not exist yet (fresh clone; the bootstrap stamps a table-less
// placeholder) — absence just means "nothing recorded yet". Anything else (EACCES, EISDIR,
// EIO) aborts the run: regenerating over a manifest we failed to READ would silently wipe
// its recorded values.
function readFileIfExists(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return '';
    throw err;
  }
}

// Mirror of src/platform/naming.ts — keep in sync; test/platform/provision.test.mjs pins
// this mirror's output against the scheme so it can't silently drift (it had: kvCache,
// r2Media, secretPrefix were missing).

// Mirror of naming.ts FLEET_AI_GATEWAY_ID: the ONE fleet-shared AI Gateway every kit app
// routes through (Cloudflare caps AI Gateways at ~20/account — per-app attribution rides
// the cf-aig-metadata header instead; see DECISIONS 2026-08-28). The id deliberately avoids
// the template's kebab identity, so the bootstrap rename has nothing to match in it.
export const FLEET_AI_GATEWAY_ID = 'all-pr-apps';

export function resourceNames(app) {
  if (!/^[a-z][a-z0-9-]{1,38}[a-z0-9]$/.test(app) || app.includes('--')) {
    throw new Error(`Invalid app name "${app}" (kebab-case, 3-40 chars)`);
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

// The AI Gateway create body — used to ENSURE the fleet-shared gateway exists (normally it
// already does; provisioning an app creates nothing per-app here). The gateways create API
// REQUIRES rate-limiting + cache fields; the old `{ id, collect_logs }` body fails validation
// (error 7001) and the gateway is silently never created. We disable caching + rate limiting
// (each app's own budget gates are the control) and keep metadata logs ON — the per-REQUEST
// privacy invariant `cf-aig-collect-log-payload: false` (src/ai/anthropic.ts) keeps prompt
// PAYLOADS out of the gateway logs regardless.
//
// `authentication: true` makes it an Authenticated Gateway. WITHOUT it the gateway is an OPEN
// proxy: the account id and gateway id are both non-secret, so anyone who knows them can bill
// inference to this account — and on the FLEET gateway that exposure covers every app at once.
// src/ai/anthropic.ts already sends `cf-aig-authorization` on every gateway call, so this
// costs a fork nothing — and it cannot break one either: a worker with no AI_GATEWAY_TOKEN
// never routes through the gateway at all (production already fails closed in
// src/ai/anthropic.ts, dev/staging call Anthropic directly), so gateway auth is only ever
// evaluated when a token is present to satisfy it.
// Pinned by test/platform/provision.test.mjs.
export function aiGatewayCreatePayload(id) {
  return {
    id,
    authentication: true,
    cache_invalidate_on_update: false,
    cache_ttl: 0,
    collect_logs: true,
    rate_limiting_interval: 0,
    rate_limiting_limit: 0,
    rate_limiting_technique: 'fixed',
  };
}

// Verify a LIVE gateway config against the canonical payload. The gateway step is
// GET-first: on a shared account the gateway normally already exists, and only reading it
// back proves the live settings — a dashboard edit (auth off, caching on, rate limiting on)
// would otherwise ride under every later provision run unnoticed, and each is a FLEET-wide hazard:
// auth off = open billable proxy for every app; caching on = one app's completion served
// to another app's user; rate limiting on = one app's burst throttles the whole fleet.
// A missing/unreadable config counts as fully drifted (fail closed).
// Pinned by test/platform/provision.test.mjs.
export function aiGatewayDrift(live) {
  const want = aiGatewayCreatePayload(FLEET_AI_GATEWAY_ID);
  const drift = [];
  for (const key of [
    'authentication',
    'cache_ttl',
    'rate_limiting_interval',
    'rate_limiting_limit',
    'collect_logs',
  ]) {
    if (live?.[key] !== want[key]) {
      drift.push(`${key}=${JSON.stringify(live?.[key])} (want ${JSON.stringify(want[key])})`);
    }
  }
  return drift;
}

// R2 backup lifecycle (AICOE-226 R1). The daily cron (src/cron/backup.ts) is the PRIMARY
// retention — it prunes db-backups/ to BACKUP_RETENTION_DAYS. This bucket lifecycle rule is
// the BACKSTOP: PII-bearing backups still expire if the cron is down. It deletes a few days
// BEYOND the cron's window so it never races the cron (the cron always prunes first).
export const BACKUP_LIFECYCLE_RULE_ID = 'kit-db-backups-expiry';
export const BACKUP_PREFIX = 'db-backups/';
const BACKUP_LIFECYCLE_BUFFER_DAYS = 7;
const DEFAULT_BACKUP_RETENTION_DAYS = 30; // mirrors src/cron/backup.ts

// Read BACKUP_RETENTION_DAYS from the wrangler config vars (mirrors the cron's own logic),
// defaulting to 30. Re-provision after changing it to refresh the bucket rule.
export function backupRetentionDays(config) {
  const n = Number(config?.vars?.BACKUP_RETENTION_DAYS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_BACKUP_RETENTION_DAYS;
}

// PURE + idempotent: upsert the backup-expiry rule into an existing R2 lifecycle ruleset BY
// ID, leaving any other (app-owned) rules untouched. `withBackupLifecycleRule(f(x))` === f(x),
// so re-provisioning replaces our rule in place instead of appending a duplicate — the bug
// that broke prod re-provision. maxAge is in SECONDS per the R2 lifecycle API.
export function withBackupLifecycleRule(existingRules, retentionDays) {
  const maxAge = (retentionDays + BACKUP_LIFECYCLE_BUFFER_DAYS) * 86_400;
  const others = (Array.isArray(existingRules) ? existingRules : []).filter(
    (r) => r?.id !== BACKUP_LIFECYCLE_RULE_ID,
  );
  return [
    ...others,
    {
      id: BACKUP_LIFECYCLE_RULE_ID,
      enabled: true,
      conditions: { prefix: BACKUP_PREFIX },
      deleteObjectsTransition: { condition: { type: 'Age', maxAge } },
    },
  ];
}

async function cf(token, method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res
    .json()
    .catch(() => ({ success: false, errors: [{ message: 'bad json' }] }));
  // Expose the HTTP status alongside the parsed body: some decisions (a 404 vs an authz
  // denial) must not ride on Cloudflare's error PROSE — CF authz errors can be worded
  // "not found"-ish (7003 "could not route…") and genuine 404s can be worded without it.
  return { ...json, status: res.status };
}

async function ensureD1(token, accountId, name) {
  const created = await cf(token, 'POST', `/accounts/${accountId}/d1/database`, { name });
  if (created.success) return { id: created.result.uuid ?? created.result.id, created: true };
  const list = await cf(token, 'GET', `/accounts/${accountId}/d1/database?per_page=100`);
  const existing = (list.result ?? []).find((d) => d.name === name);
  if (existing) return { id: existing.uuid ?? existing.id, created: false };
  throw new Error(`D1 ${name}: ${JSON.stringify(created.errors)}`);
}

async function ensureKv(token, accountId, title) {
  const created = await cf(token, 'POST', `/accounts/${accountId}/storage/kv/namespaces`, {
    title,
  });
  if (created.success) return { id: created.result.id, created: true };
  const list = await cf(token, 'GET', `/accounts/${accountId}/storage/kv/namespaces?per_page=100`);
  const existing = (list.result ?? []).find((n) => n.title === title);
  if (existing) return { id: existing.id, created: false };
  throw new Error(`KV ${title}: ${JSON.stringify(created.errors)}`);
}

async function ensureR2(token, accountId, name) {
  const created = await cf(token, 'POST', `/accounts/${accountId}/r2/buckets`, { name });
  if (created.success) return { created: true };
  const message = JSON.stringify(created.errors ?? []);
  if (message.includes('already exists') || message.includes('10004')) return { created: false };
  return { created: false, error: message };
}

// Best-effort + IDEMPOTENT: upsert our backup-expiry rule by id and PUT the ruleset (PUT
// REPLACES the whole config, so there is no "append" path that could duplicate on re-run).
// Truly best-effort — the cron is the primary retention, this is the backstop — so EVERY
// failure (missing scope, API shape, a thrown network error) returns a 'manual' status
// instead of aborting provisioning.
//   • GET succeeds → merge with the rules it returned, so any other rule on the bucket is
//     preserved (upsert by id; re-running replaces our rule in place, never duplicates).
//   • GET fails (incl. APIs that report a bucket with no lifecycle as an error rather than
//     an empty ruleset) → still PUT just our rule. This bucket is kit-DEDICATED to backups
//     — nothing else manages its lifecycle — so the backstop must get set on a fresh bucket
//     regardless of how an empty GET is reported, and there are no app-owned rules to lose.
async function ensureBackupLifecycle(token, accountId, bucket, retentionDays) {
  const path = `/accounts/${accountId}/r2/buckets/${bucket}/lifecycle`;
  try {
    const current = await cf(token, 'GET', path);
    const existingRules =
      current.success && Array.isArray(current.result?.rules) ? current.result.rules : [];
    const rules = withBackupLifecycleRule(existingRules, retentionDays);
    const put = await cf(token, 'PUT', path, { rules });
    return put.success ? 'set' : `manual (${JSON.stringify(put.errors ?? [])})`;
  } catch (err) {
    return `manual (${err?.message ?? err})`;
  }
}

// Idempotent GET-merge-PUT of one rule into a zone ruleset phase entrypoint. PUT REPLACES the
// phase's whole rule list, so we merge our rule into whatever the GET returned (preserving operator
// + sibling-app rules) and re-PUT; upsert-by-marker means a re-run never duplicates.
//
// SAFETY (differs from ensureBackupLifecycle, whose R2 bucket is kit-DEDICATED): the zone rulesets
// are SHARED across every app on cialdnb.ai. A PUT after a FAILED GET would replace the populated
// phase with JUST our rule — wiping every other app's + operator's rules. So we read with
// readPhaseRules in STRICT mode: only a real `success:true` GET yields a rule list to merge into;
// ANY error (including a not-found-WORDED authz error like CF's 7003 "could not route", which a
// write-capable-but-read-scoped token can hit) is a hard failure → we SKIP the PUT and return
// `manual`. A genuinely-empty fresh phase then needs the first rule created by hand — an accepted
// cost to make a destructive replace impossible. That case (Cloudflare 10003/10404, no entrypoint
// yet) is reported as `noEntrypoint`, never as the token-scope problem it is not.
//
// KNOWN LIMITATION (low severity): the GET→PUT is not atomic (no ruleset-version / If-Match), so
// two provisions racing on the same zone can lost-update each other's rule. Provision is a
// deliberate, infrequent action, and verify:edge:live flags a clobbered rule on the next run —
// acceptable for now; add optimistic concurrency if concurrent provisioning ever becomes real.
async function ensureEdgeRule(token, zoneId, phase, rule, marker) {
  const path = `/zones/${zoneId}/rulesets/phases/${phase}/entrypoint`;
  const got = readPhaseRules(await cf(token, 'GET', path), { strict: true });
  if (got.noEntrypoint) {
    // The phase has never held a rule. Still no PUT (DECISIONS 2026-07-13: the writer never
    // creates the first rule), and still operator-must-act — but the remedy is a first rule by
    // hand, not a token fix. main() exits non-zero over it at end of run, like `unreadable`.
    return {
      note: `manual (phase ${phase} has no entrypoint ruleset yet: ${got.error}) — provision never creates the first rule; add it by hand, then re-run`,
      unreadable: false,
      noEntrypoint: true,
    };
  }
  if (got.error !== undefined) {
    // `unreadable` marks the operator-must-act case (issue #182): the zone id IS set, so this
    // is a misconfiguration — most commonly a token minted before Zone WAF:Edit joined the
    // §8.1 recipe — not an opt-out. main() turns it into a non-zero exit at end of run.
    return {
      note: `manual (GET failed: ${got.error}) — skipped PUT so a failed/authz GET can't replace existing zone rules`,
      unreadable: true,
    };
  }
  const put = await cf(token, 'PUT', path, { rules: upsertRuleByMarker(got.rules, rule, marker) });
  return put.success
    ? { note: 'set', unreadable: false }
    : { note: `manual (${JSON.stringify(put.errors ?? [])})`, unreadable: false };
}

// Ensure the kit's edge rules exist in the zone. The `/auth/*` rate-limit is
// zone-wide (every kit app's /auth wants it; the first app to provision creates it, the rest
// find it present). The Host-pin is created ONLY on a DEDICATED zone (EDGE_REQUIRE_HOST_PIN=1):
// on the shared cialdnb.ai zone a "block host ne <domain>" rule would break sibling apps, so it
// is skipped with a note and the verify treats its absence as OK there. Never THROWS out of
// provision mid-run — but `unreadable: true` (zone id set, phases not readable/attempt failed)
// is a misconfiguration, not an opt-out, and main() exits non-zero over it at end of run
// (issue #182: three fleet apps provisioned "successfully" and then could never pass GO-LIVE
// gate 11, because only a later, different script exercised the missing scope).
async function ensureEdgeRules(token, zoneId, customDomain, dedicatedZone) {
  const out = { unreadable: false, noEntrypoint: false };
  try {
    const r = await ensureEdgeRule(
      token,
      zoneId,
      PHASES.ratelimit,
      authRateLimitRule(),
      AUTH_RL_MARKER,
    );
    out.rateLimit = r.note;
    out.unreadable ||= r.unreadable;
    out.noEntrypoint ||= r.noEntrypoint === true;
  } catch (err) {
    out.rateLimit = `manual (${err?.message ?? err})`;
    out.unreadable = true;
  }
  if (!dedicatedZone) {
    out.hostPin =
      'skipped (shared zone — would block sibling apps; set EDGE_REQUIRE_HOST_PIN=1 on a dedicated zone)';
    return out;
  }
  try {
    const r = await ensureEdgeRule(
      token,
      zoneId,
      PHASES.custom,
      hostPinRule(customDomain),
      HOST_PIN_MARKER,
    );
    out.hostPin = r.note;
    out.unreadable ||= r.unreadable;
    out.noEntrypoint ||= r.noEntrypoint === true;
  } catch (err) {
    out.hostPin = `manual (${err?.message ?? err})`;
    out.unreadable = true;
  }
  return out;
}

// PURE (pinned by test/platform/provision.test.mjs): render the edge-rules outcome into the
// RESOURCES.md cell + log line, keeping the two non-set states DISTINGUISHABLE (issue #182):
//   • no zone id      → the caller never runs this; the cell keeps its `_pending (set
//     CLOUDFLARE_ZONE_ID and re-run)_` default — an opt-out, exit 0.
//   • unreadable      → "attempted" wording naming the token scope as the likely cause, so the
//     manifest points at the fix instead of misdescribing the state as an opt-out.
//   • noEntrypoint    → "attempted" wording naming the REAL remedy (a first rule by hand): a phase
//     that never held a rule is not a token problem, and saying so sent operators to re-mint.
export function edgeRulesState(edge) {
  const base = `${edge.rateLimit} / ${edge.hostPin}`;
  const notes = [];
  if (edge.unreadable) {
    notes.push(
      '⚠ attempted, zone phases unreadable: the deploy token likely lacks Zone WAF:Edit (§8.1, issue #182); fix the token and re-run provision',
    );
  }
  if (edge.noEntrypoint) {
    notes.push(
      '⚠ attempted, a zone phase has no entrypoint ruleset yet: provision never creates the first rule (DECISIONS 2026-07-13); add it by hand, then re-run provision',
    );
  }
  return notes.length ? `${base} — ${notes.join('; ')}` : base;
}

// NOTE (AICOE-467; DECISIONS 2026-08-04): there is deliberately NO per-app secret-provisioning
// function here anymore. ANTHROPIC_API_KEY + AI_GATEWAY_TOKEN are PER-WORKER plain secrets (no
// account Secrets Store slot consumed) and are set on the FIRST deploy via `--secrets-file` — a
// per-Worker secret needs a Worker to live on, and minting a token inside provision
// would land its VALUE in CI logs/artifacts. main() prints the exact next-steps; the AI Gateway
// RESOURCE (not its token) is still created in main(). The old mint-token-and-write-to-store step
// is gone with the store bindings it targeted.

function fillPlaceholder(configPath, matcherName, id) {
  let text = readFileSync(configPath, 'utf8');
  const before = text;
  // Replace the placeholder in the object that mentions this resource name.
  const blockRe = new RegExp(
    `(\\{[^{}]*${matcherName.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}[^{}]*\\})`,
  );
  const match = text.match(blockRe);
  if (match) {
    const patched = match[1].replace('PLACEHOLDER_RUN_PROVISION', id);
    text = text.replace(match[1], patched);
  }
  if (text !== before) {
    writeFileSync(configPath, text);
    return true;
  }
  return false;
}

// ── Manifest carry-forward ──────────────────────────────────────────────────────────
// The manifest is fully regenerated on every run, but a single run cannot re-derive
// everything it renders: /new-app records the Linear row, earlier runs recorded the OTHER
// env's ids, and the "keep current!" rows may be ticked by hand. So every regeneration
// seeds state from the existing file and lets freshly derived values win — otherwise each
// run silently resets every cell it didn't itself compute to _pending_ (the wipe that hit
// status-admin's Linear row). Pinned by test/platform/provision.test.mjs.

// Split a markdown table row into cells on UNESCAPED pipes only, so a GFM-escaped \|
// inside a recorded value (legal in link text) stays in its cell instead of truncating.
// Cells are returned UNTRIMMED: a raw pipe in a value splits it into several cells, and
// rejoining them must reproduce the original spacing — callers trim at comparison points.
function rowCells(line) {
  if (!line.startsWith('|')) return null;
  const parts = line.split(/(?<!\\)\|/);
  return line.trimEnd().endsWith('|') ? parts.slice(1, -1) : parts.slice(1);
}

const LINEAR_ROW_LABEL = 'Linear project';
const LINEAR_ROW_HINT = 'ask /new-app — it links or creates one';

// Tolerant on purpose: /new-app hand-writes this row, sometimes into the TABLE-LESS
// placeholder, so real manifests carry it with two cells (status-admin did), three cells
// (this generator), or escaped pipes in the link text. Label-keyed; the generated middle
// cell (LINEAR_ROW_HINT) is skipped when present; everything after it is the value.
export function linearFromResourcesMd(text) {
  for (const line of (text ?? '').split('\n')) {
    const cells = rowCells(line);
    if (!cells || cells[0]?.trim() !== LINEAR_ROW_LABEL) continue;
    const rest = cells.slice(1);
    const value = (rest[0]?.trim() === LINEAR_ROW_HINT ? rest.slice(1) : rest).join('|').trim();
    return value && value !== '_pending_' ? value : undefined;
  }
  return undefined;
}

// Map manifest rows back to the state keys renderResourcesMd renders them from. The value
// is the THIRD cell in all three tables; rows are identified by their first cell plus the
// backticked name for resource rows — kinds repeat (D1/KV/R2 have prod+staging rows, and
// 'AI Gateway' can appear twice on a migrated app: the fleet row and the legacy per-app
// row). Worker rows are deliberately absent: nothing populates them and their default
// cells are instructions.
export function carriedFromResourcesMd(text, app, names) {
  const carried = {};
  if (!text) return carried;
  const lines = text.split('\n');
  // Identity guard: this is a security-attribution manifest — never import another app's
  // values. A repo copied from a bootstrapped app without the /new-app rename still ships
  // the origin's manifest; regenerating must not launder it under the new app's header.
  if (lines.find((l) => l.trim())?.trim() !== `# Resources — ${app}`) return carried;
  const spec = [
    ['d1Prod', 'D1', `\`${names.d1}\``],
    ['d1Staging', 'D1', `\`${names.d1Staging}\``],
    ['kvProd', 'KV', `\`${names.kvSessions}\``],
    ['kvStaging', 'KV', `\`${names.kvSessionsStaging}\``],
    ['r2Prod', 'R2', `\`${names.r2Backups}\``],
    ['r2Staging', 'R2', `\`${names.r2BackupsStaging}\``],
    ['aiGateway', 'AI Gateway', `\`${names.aiGateway}\``],
    // Migration residue: an app that predates the fleet gateway has a row for its RETIRED
    // per-app gateway (named after the app). Carry it under BOTH labels — the pre-migration
    // manifest says 'AI Gateway', regenerated ones say 'AI Gateway (legacy)' — because it
    // is a live resource until the platform owner deletes it, and this manifest is what
    // the orphan audit works from. Removing the row by hand (after deletion) retires it.
    ['aiGatewayLegacy', 'AI Gateway', `\`${app}\``],
    ['aiGatewayLegacy', 'AI Gateway (legacy)', `\`${app}\``],
    ['dnsStaging', `\`${names.dnsStaging}\``],
    ['dnsProd', `\`${names.dnsProd}\``],
    ['token', 'Scoped API token'],
    ['repo', 'GitHub repo'],
    ['ci', 'CI deploys'],
    ['email', 'Magic-link email'],
    // Recorded by hand once the platform owner adds this app's callbacks to the shared Entra
    // registration — nothing provision can re-derive, so a re-run must not reset it to _pending_.
    ['entraSso', 'Entra SSO redirect URI'],
    ['secrets', 'Secrets (per-app)'],
  ];
  for (const line of lines) {
    const cells = rowCells(line);
    if (!cells) continue;
    for (const [key, first, name] of spec) {
      if (cells[0]?.trim() !== first || (name && cells[1]?.trim() !== name)) continue;
      const value = cells[2]?.trim();
      // Italic cells are this generator's own placeholders (_pending…_, _account-wide_) —
      // nothing recorded. (The hand-written Linear cell is the one exception, handled by
      // linearFromResourcesMd with its exact-_pending_ filter.)
      if (value && !/^_.*_$/.test(value)) carried[key] = value;
    }
  }
  // The Entra row used to name only the prod callback. A status recorded against THAT row says
  // nothing about the staging URI the regenerated row now also lists, so it is carried only when
  // the recorded row already named the staging callback; otherwise it resets to _pending_.
  if (carried.entraSso !== undefined) {
    const row = lines.map(rowCells).find((c) => c?.[0]?.trim() === 'Entra SSO redirect URI');
    if (!row?.[1]?.includes(names.dnsStaging)) delete carried.entraSso;
  }
  const linear = linearFromResourcesMd(text);
  if (linear !== undefined) carried.linear = linear;
  return carried;
}

// Escape raw pipes in a dynamic cell so every row we EMIT parses back into the same cells
// on the next run (idempotent: an already-escaped \| is left alone).
function escCell(value) {
  return typeof value === 'string' ? value.replace(/(?<!\\)\|/g, '\\|') : value;
}

export function renderResourcesMd(app, names, state) {
  const row = (kind, name, id, purpose) =>
    `| ${kind} | \`${name}\` | ${escCell(id) ?? '_pending_'} | ${purpose} |`;
  // Only present on apps migrated off a per-app gateway (see carriedFromResourcesMd):
  // rendered as long as the previous manifest still carried it, dropped once the row is
  // hand-removed after the platform owner deletes the retired gateway.
  const legacyGatewayRow = state.aiGatewayLegacy
    ? `\n${row('AI Gateway (legacy)', app, state.aiGatewayLegacy, 'RETIRED per-app gateway — platform owner deletes it once both envs verify on the fleet gateway; then remove this row')}`
    : '';
  return `# Resources — ${app}

> GENERATED by \`npm run provision\` — re-run after provisioning changes. Recorded values
> survive regeneration: each run re-derives what it can and carries the rest forward, so
> to correct a wrong recorded cell (e.g. the /new-app-recorded Linear row), edit it and
> re-run. This manifest exists so every resource on the shared Cloudflare account
> (13878ca5057070dd0140af23d2d5508f) is attributable to its app at a glance, including
> the things wrangler.jsonc cannot show (DNS, tokens, gateway config, Entra URIs).

Last generated: ${new Date().toISOString()}

## Cloudflare resources

| Kind | Name | ID | Purpose |
| --- | --- | --- | --- |
${row('Worker', names.worker, state.workerProd ?? 'deployed via `npm run deploy`', 'Production app')}
${row('Worker', names.workerStaging, state.workerStaging ?? 'deployed via CI / `npm run deploy:staging`', 'Staging app (default posture)')}
${row('D1', names.d1, state.d1Prod, 'Production database (system of record)')}
${row('D1', names.d1Staging, state.d1Staging, 'Staging database')}
${row('KV', names.kvSessions, state.kvProd, 'Sessions + rate limits + heartbeat (binding: SESSIONS)')}
${row('KV', names.kvSessionsStaging, state.kvStaging, 'Staging sessions')}
${row('R2', names.r2Backups, state.r2Prod, 'Daily D1 backups (binding: BACKUPS) + expiry-lifecycle backstop')}
${row('R2', names.r2BackupsStaging, state.r2Staging, 'Staging backups')}
${row('AI Gateway', names.aiGateway, state.aiGateway, 'FLEET-SHARED gateway (every kit app; per-app attribution via cf-aig-metadata); payload logging OFF')}${legacyGatewayRow}

## DNS (zone cialdnb.ai — 56e69188863ffae4a16ee94fc4f8891b)

| Host | Created by | Status |
| --- | --- | --- |
| \`${names.dnsStaging}\` | Workers custom domain on first staging deploy | ${escCell(state.dnsStaging) ?? '_pending first deploy_'} |
| \`${names.dnsProd}\` | Workers custom domain at GO-LIVE only (sign-off required) | ${escCell(state.dnsProd) ?? '_pending go-live_'} |

## Not visible in wrangler.jsonc (keep current!)

| Item | Value / location | Status |
| --- | --- | --- |
| Scoped API token | 1Password / owner vault — "${app} provisioning token" | ${escCell(state.token) ?? '_pending — see handbook runbook_'} |
| GitHub repo | \`${names.githubRepo}\` | ${escCell(state.repo) ?? '_pending_'} |
| CI deploys | repo secret CLOUDFLARE_API_TOKEN + variable DEPLOY_ENABLED=true | ${escCell(state.ci) ?? '_pending_'} |
| Edge rules (zone WAF/rate-limit) | \`${AUTH_RL_MARKER}\` + \`${HOST_PIN_MARKER}\` on cialdnb.ai — scripted by provision (needs CLOUDFLARE_ZONE_ID), verified by \`verify:edge:live\` | ${escCell(state.edgeRules) ?? '_pending (set CLOUDFLARE_ZONE_ID and re-run)_'} |
| Magic-link email | \`wrangler email sending enable cialdnb.ai\` (one-time platform task) | ${escCell(state.email) ?? '_pending platform setup_'} |
| Entra SSO redirect URI | https://${names.dnsProd}/auth/oidc/callback + https://${names.dnsStaging}/auth/oidc/callback on the shared "CIAL Internal Apps" registration | ${escCell(state.entraSso) ?? '_pending platform setup_'} |
| Secrets (per-app) | \`ANTHROPIC_API_KEY\` + \`AI_GATEWAY_TOKEN\` — PER-WORKER plain secrets (NOT in the account store), \`required\` in the wrangler configs. Set BOTH on the first deploy: \`wrangler deploy --secrets-file .secrets.<env>.json\`; they persist for later deploys. One key per app (same value prod+staging). See handbook §8. | ${escCell(state.secrets) ?? '_pending first deploy_'} |
| Secret (shared) | \`PAVED_ROAD_ALERT_WEBHOOK_URL\` — one account-wide Slack webhook for every app, not renamed on bootstrap (per-app override in admin settings) | _account-wide_ |
| Secret (shared) | \`PAVED_ROAD_ENTRA_CLIENT_SECRET\` — client secret of the one shared "CIAL Internal Apps" Entra registration, not renamed on bootstrap (see docs/runbooks/entra-sso-setup.md) | _account-wide_ |
| Linear project | ${LINEAR_ROW_HINT} | ${escCell(state.linear) ?? '_pending_'} |
`;
}

async function main() {
  // CIAL apps only, in every mode (--plan regenerates the CIAL resource manifest). A DB Israel
  // app's resources come from the central catalog, and an unreadable deployment target is never
  // read as CIAL: scripts/deployment-target.mjs decides (DECISIONS 2026-10-27).
  const refusal = cialRefusal(resolveDeploymentTarget());
  if (refusal) {
    console.error(refusal);
    process.exit(1);
  }
  const args = process.argv.slice(2);
  const plan = args.includes('--plan');
  const envFlag = args.includes('--env') ? args[args.indexOf('--env') + 1] : null;
  const config = readWranglerConfig('wrangler.jsonc');
  const app = config.name;
  const accountId = config.account_id;
  const names = resourceNames(app);
  // Seed every regeneration from the existing manifest; fresh values assigned below win.
  const carried = carriedFromResourcesMd(readFileIfExists('docs/RESOURCES.md'), app, names);

  if (plan || !envFlag) {
    console.log(`Provisioning plan for "${app}" (account ${accountId}):`);
    for (const [kind, name] of Object.entries(names)) {
      console.log(`  ${kind.padEnd(18)} ${name}`);
    }
    console.log('\nRun with --env staging (or --env production) to create resources.');
    console.log('docs/RESOURCES.md will be regenerated either way.');
    writeFileSync('docs/RESOURCES.md', renderResourcesMd(app, names, carried));
    return;
  }

  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!token) {
    console.error(
      'CLOUDFLARE_API_TOKEN is required (per-app scoped token — see docs/IMPLEMENTATION-HANDBOOK.md).',
    );
    process.exit(1);
  }
  const staging = envFlag === 'staging';
  const configPath = staging ? 'wrangler.staging.jsonc' : 'wrangler.jsonc';
  const state = { ...carried };

  const d1Name = staging ? names.d1Staging : names.d1;
  const d1 = await ensureD1(token, accountId, d1Name);
  console.log(`D1  ${d1Name}: ${d1.created ? 'created' : 'exists'} (${d1.id})`);
  fillPlaceholder(configPath, d1Name, d1.id);
  if (staging) state.d1Staging = d1.id;
  else state.d1Prod = d1.id;

  const kvName = staging ? names.kvSessionsStaging : names.kvSessions;
  const kv = await ensureKv(token, accountId, kvName);
  console.log(`KV  ${kvName}: ${kv.created ? 'created' : 'exists'} (${kv.id})`);
  fillPlaceholder(configPath, 'SESSIONS', kv.id);
  if (staging) state.kvStaging = kv.id;
  else state.kvProd = kv.id;

  const r2Name = staging ? names.r2BackupsStaging : names.r2Backups;
  const r2 = await ensureR2(token, accountId, r2Name);
  if (r2.error) {
    console.warn(
      `R2  ${r2Name}: NOT created (${r2.error}) — backups stay pending; see RESOURCES.md`,
    );
  } else {
    console.log(`R2  ${r2Name}: ${r2.created ? 'created' : 'exists'}`);
    if (staging) state.r2Staging = 'ok';
    else state.r2Prod = 'ok';
    // Backstop retention on the bucket (idempotent; the cron is the primary). Best-effort.
    // Read THIS env's config (configPath) for BACKUP_RETENTION_DAYS — the staging cron reads
    // the staging worker's var, so the staging bucket must size off wrangler.staging.jsonc,
    // not the prod config loaded above.
    const days = backupRetentionDays(readWranglerConfig(configPath));
    const lifecycle = await ensureBackupLifecycle(token, accountId, r2Name, days);
    console.log(`R2  ${r2Name}: backup-expiry lifecycle ${lifecycle} (>${days}d, backstop)`);
    if (lifecycle.startsWith('manual')) {
      console.warn(
        `R2  ${r2Name}: lifecycle not set (${lifecycle}) — cron still prunes; set a >${days}d expiry on db-backups/ by hand if the token lacks R2 lifecycle scope.`,
      );
    }
  }

  // Edge rules (zone rulesets) — best-effort + idempotent, like the R2 lifecycle. Needs the zone
  // id (CLOUDFLARE_ZONE_ID) + the token's Zone WAF/rate-limit edit scope; skips cleanly if the
  // zone id is absent. scripts/check-edge-live.mjs verifies these same rules stay live.
  const zoneId = process.env.CLOUDFLARE_ZONE_ID;
  let edgeUnreadable = false;
  let edgeNoEntrypoint = false;
  if (zoneId) {
    const domain = staging ? names.dnsStaging : names.dnsProd;
    const edge = await ensureEdgeRules(
      token,
      zoneId,
      domain,
      process.env.EDGE_REQUIRE_HOST_PIN === '1',
    );
    console.log(`Edge  /auth rate-limit: ${edge.rateLimit}; host-pin: ${edge.hostPin}`);
    state.edgeRules = edgeRulesState(edge);
    edgeUnreadable = edge.unreadable;
    edgeNoEntrypoint = edge.noEntrypoint;
  } else {
    console.warn(
      'Edge  rules SKIPPED (set CLOUDFLARE_ZONE_ID to script the /auth rate-limit + host-pin rules).',
    );
  }

  // AI Gateway: VERIFY the fleet-shared gateway (names.aiGateway is FLEET_AI_GATEWAY_ID for
  // every app). GET-first: deploy tokens carry AI Gateway READ only — the why is DECISIONS
  // 2026-08-28 — and only a genuine HTTP 404 falls through to a create attempt, which
  // succeeds solely under a platform-owner credential. The drift check is the fleet's only
  // automated detector of an open/caching gateway, so detected hazards exit non-zero (same
  // rationale as the edge checks below — issue #182: a warn in a green run is invisible).
  const gatewayUrl = `/accounts/${accountId}/ai-gateway/gateways/${names.aiGateway}`;
  let live = await cf(token, 'GET', gatewayUrl);
  let gatewayHandled = false;
  if (!live.success && live.status === 404) {
    const gw = await cf(
      token,
      'POST',
      `/accounts/${accountId}/ai-gateway/gateways`,
      aiGatewayCreatePayload(names.aiGateway),
    );
    if (gw.success) {
      gatewayHandled = true;
      state.aiGateway = 'created';
      console.log(
        `AI Gateway ${names.aiGateway}: created (fleet-shared; payload logging stays OFF per-request)`,
      );
    } else if (/already exists|duplicate/i.test(JSON.stringify(gw.errors ?? []))) {
      // Lost a race with another provision run or bruno 03 — it exists now; re-read and
      // fall through to the same verification as the normal path.
      live = await cf(token, 'GET', gatewayUrl);
    } else {
      gatewayHandled = true;
      state.aiGateway = 'MISSING — platform owner must create it (bruno 03)';
      console.warn(
        `AI Gateway ${names.aiGateway}: MISSING, and this token cannot create it (${JSON.stringify(gw.errors ?? [])})\n` +
          '       The platform owner creates the fleet gateway via tools/bruno/cf-provisioning 03\n' +
          '       (or the dashboard followed by 03b to enforce authenticate-only).',
      );
      process.exitCode = 1;
    }
  }
  if (!gatewayHandled) {
    if (live.success) {
      const drift = aiGatewayDrift(live.result);
      if (drift.length === 0) {
        state.aiGateway = 'exists (settings verified)';
        console.log(`AI Gateway ${names.aiGateway}: exists (fleet-shared — settings verified)`);
      } else {
        state.aiGateway = `exists — SETTINGS DRIFTED: ${drift.join('; ')} — repair via bruno 03b`;
        console.warn(
          `AI Gateway ${names.aiGateway}: SETTINGS DRIFTED — ${drift.join('; ')}\n` +
            '       Fleet-wide hazard: repair via tools/bruno/cf-provisioning 03b (platform owner).',
        );
        process.exitCode = 1;
      }
    } else if (live.status === 404) {
      // Deleted again between the create race check and the re-read — genuinely missing.
      state.aiGateway = 'MISSING — platform owner must create it (bruno 03)';
      console.warn(
        `AI Gateway ${names.aiGateway}: MISSING — platform owner creates it (bruno 03).`,
      );
      process.exitCode = 1;
    } else {
      // Unknown read failure: a transient API fault, a rate limit, OR a token missing
      // AI Gateway:Read — don't assert one cause. Still non-zero: with the read dead, the
      // fleet's only drift detector did not run this cycle, and a transient clears on re-run.
      state.aiGateway = 'unverified — gateway config could not be read';
      console.warn(
        `AI Gateway ${names.aiGateway}: could not be read to verify it (HTTP ${live.status}: ${JSON.stringify(live.errors ?? [])})\n` +
          '       If this persists, check the deploy token carries AI Gateway:Read (handbook §8.1;\n' +
          '       re-mint via bruno 01→02). A transient API fault clears on re-run.',
      );
      process.exitCode = 1;
    }
  }

  // Per-app runtime secrets (ANTHROPIC_API_KEY + AI_GATEWAY_TOKEN) are PER-WORKER plain secrets
  // (AICOE-467), set on the first deploy via `--secrets-file` or onto the platform owner's
  // placeholder Worker (bruno 05b/05c) — provision does not touch them (see the note where the
  // old token-minting step was, and the next-steps below). The fleet AI Gateway
  // RESOURCE was VERIFIED just above (never created per-app); its runtime token is a
  // per-Worker secret.
  state.secrets = 'per-Worker plain secrets (set on first deploy — see next steps)';
  console.log(
    'Per-app secrets: per-Worker (ANTHROPIC_API_KEY + AI_GATEWAY_TOKEN) — set on first deploy',
  );

  writeFileSync('docs/RESOURCES.md', renderResourcesMd(app, names, state));
  const cfgFile = staging ? 'wrangler.staging.jsonc' : 'wrangler.jsonc';
  const envTag = staging ? 'staging' : 'prod';
  console.log('\nNext steps:');
  console.log(`  1. npm run db:apply${staging ? ':staging' : ''}`);
  console.log(
    '  2. Set this app’s per-app secrets, then deploy (they are per-Worker + `required`,',
  );
  console.log('     so the deploy fails closed until BOTH exist). Carry them on the FIRST deploy');
  console.log('     with --secrets-file. NOT `wrangler secret put` first: on a missing Worker it');
  console.log('     silently creates a stub one (defaults to yes, even in CI), workers.dev ON.');
  console.log(`       ANTHROPIC_API_KEY = this app’s Anthropic API key`);
  console.log('       AI_GATEWAY_TOKEN  = a Cloudflare API token scoped "AI Gateway Run"');
  console.log(
    `       printf '{"ANTHROPIC_API_KEY":"<key>","AI_GATEWAY_TOKEN":"<token>"}' > .secrets.${envTag}.json  # gitignored`,
  );
  console.log(
    `       npx wrangler deploy --config ${cfgFile} --secrets-file .secrets.${envTag}.json`,
  );
  console.log(
    '       rm .secrets.*.json   # values persist on the Worker; later CI deploys need no file',
  );
  console.log('     Or, with no values on disk: the platform owner creates the Worker as an inert');
  console.log(
    `     placeholder and sets both on it (kit tools/bruno/cf-provisioning, scriptName ${staging ? names.workerStaging : names.worker}:`,
  );
  console.log(
    '     05 → 05b → 05c, then 05 → 06 / 07). The first deploy keeps them (secrets.required).',
  );
  console.log(`  3. Check https://${staging ? names.dnsStaging : names.dnsProd}/_health`);
  console.log(
    `  (Later deploys: \`npm run deploy${staging ? ':staging' : ''}\` — secrets already set.)`,
  );
  console.log('  docs/RESOURCES.md regenerated.');

  // Issue #182: a zone id that WAS set but whose ruleset phases the token couldn't read is a
  // misconfiguration, not an opt-out — and it used to read as success here, only to surface at
  // GO-LIVE gate 11 in a different script (verify:edge:live), days later, with no pointer back
  // to the cause. Fail LOUDLY at the source instead — but only after everything above completed:
  // resources are idempotent, RESOURCES.md is written, and a re-run after fixing the token
  // converges. The ::warning:: prefix makes a GitHub Actions annotation; locally it's just text.
  if (edgeUnreadable) {
    console.error('\n::warning::Edge rules ATTEMPTED but the zone ruleset phases were unreadable.');
    console.error(
      'Everything else provisioned, but this run must not read as success: with the zone id set,',
    );
    console.error(
      'an unreadable phase means GO-LIVE gate 11 (verify:edge:live) can NEVER pass with this',
    );
    console.error(
      'token. Most common cause: the deploy token predates Zone WAF:Edit in the §8.1 recipe',
    );
    console.error(
      '(issue #182) — EDIT the account-owned token to add it (value unchanged), then re-run',
    );
    console.error('provision (idempotent). Exiting non-zero so CI and operators see it NOW.');
    process.exitCode = 1;
  }
  // Same loudness, different remedy: the token reached the phase, and Cloudflare says it has
  // never held a rule (10003). Re-minting the token would change nothing.
  if (edgeNoEntrypoint) {
    console.error(
      '\n::warning::Edge rules ATTEMPTED but a zone phase has no entrypoint ruleset yet.',
    );
    console.error(
      'Provision never creates the first rule on a phase (it will not PUT after a failed GET on',
    );
    console.error(
      'the shared zone, DECISIONS 2026-07-13). Create the first rule by hand (docs/SECURITY-EDGE.md',
    );
    console.error(
      'per-fork checklist 2-3), then re-run provision: with the phase readable it upserts the kit',
    );
    console.error('rule by its marker. Exiting non-zero: GO-LIVE gate 11 cannot pass until then.');
    process.exitCode = 1;
  }
}

// Run only as a CLI; importing the module (e.g. the pin test) must not provision anything.
// isMainModule compares REALPATHS — see scripts/kit-checks/main-module.mjs for why the obvious
// pathToFileURL(argv[1]) comparison fails open through a symlinked path.
if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error(err.message ?? err);
    process.exit(1);
  });
}

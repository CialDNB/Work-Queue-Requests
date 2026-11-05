// Fleet self-report: once a day this app POSTs its own live status AND its governance manifest to
// the App Registry's /api/apps/ingest, so the registry's catalogue shows health/version/staleness
// (AICOE-355) and a cross-app governance map — permission matrix, audit vocabulary, route surface
// (AICOE-356). The registry URL is BAKED INTO THE KIT (so it rides /kit-upgrade — no per-app var
// to set); PRODUCTION AND STAGING both report as soon as the REGISTRY_TOKEN secret is set. Staging
// counts because most kit apps live in staging for months before go-live — a prod-only registry
// simply cannot see most of the fleet, which is the opposite of what a fleet catalogue is for. The
// two are kept apart by an env-qualified `source_key` ('my-app' vs 'my-app-staging'), so a staging
// row never clobbers its prod twin. The token is the real gate; the opt-in shape mirrors EMAIL /
// DEPLOY_ENABLED. Best-effort: the registry being unreachable is never this app's problem, so a
// failure only logs (the ops loop calls it last, after the heartbeat + any failure alert — see
// src/cron/index.ts).
import { appDisplayName } from '../auth/interstitial';
import { type Db, makeDb } from '../data';
import { type ActivityDigest, splitForRegistry } from '../data/activity';
import { migrationNamesHash } from '../data/meta';
import { type AppEnvName, type Env, getSecret } from '../env';
import { type AppManifest, buildManifest, type ManifestRoute } from '../framework/manifest';
import { readAuditArmed } from '../framework/readAudit';
import { APP_MATURITY, KIT_VERSION } from '../framework/version';
import { computeHealth } from '../health';
import { logEvent } from '../platform/logEvent';
import { allRoutes } from '../routes';

const TIMEOUT_MS = 5_000;

// The one fleet registry every CIAL app reports to. Baked in (NOT a per-app var) so /kit-upgrade
// carries it and turning an app on needs only the REGISTRY_TOKEN secret. An app overrides via the
// REGISTRY_URL var only to point at a different registry (a staging instance, or a fork's own).
const DEFAULT_REGISTRY_URL = 'https://app-registry.cialdnb.ai';

// Trailing window for the AI-spend tripwire below. 30 days because that is the unit the owner
// reasons about the fleet's AI bill in ("~$129/month"), and it is long enough that a single
// bursty day doesn't read as a trend.
const AI_SPEND_WINDOW_DAYS = 30;

// Envs that report to the BAKED-IN fleet registry — the two that are real deployments. 'test' and
// 'development' are NOT here and can only opt in via an explicit REGISTRY_URL (e.g. a throwaway
// registry). NOTE this is not a guard against local runs: `npm run dev` loads wrangler.jsonc, so a
// laptop reports as APP_ENV 'production'. What actually keeps a laptop out of the catalogue is
// REGISTRY_TOKEN being unset locally (.dev.vars) — do not set it there.
const REPORTING_ENVS: readonly AppEnvName[] = ['production', 'staging'];

// Append the env marker for a non-prod report, unless the display name already carries it —
// appDisplayName only strips '(staging)'/'(test)', so a '(development)' marker survives and would
// otherwise be duplicated ("Acme (development) (development)").
function envQualified(display: string, appEnv: AppEnvName): string {
  if (appEnv === 'production') return display;
  const suffix = `(${appEnv})`;
  return display.toLowerCase().endsWith(suffix.toLowerCase()) ? display : `${display} ${suffix}`;
}

// The registry's own cap on `migrations.applied` per report — a 51st entry would 400 the WHOLE
// report, status and manifest with it. Comfortably above any real fork's history, but a fork that
// somehow exceeds it sends the NEWEST 50 names and an honest `count`, rather than a rejected
// payload. The consequence is deliberate and known: the registry's `app_migrations` union ledger
// would never learn the truncated oldest names, so its row count can legitimately sit BELOW the
// `count` this app self-reports. Anything reasoning about "how many migrations does this app
// have" must reconcile the two rather than trust either scalar alone.
const MIGRATIONS_APPLIED_CAP = 50;

/**
 * The SPA view that renders this app's read ledger — the "who read record X" page (Fleet Ledger
 * K2b). The registry stores VOLUMES; the answer to who touched a specific record lives here, in
 * the app that owns the data, and `activity_url` is the deep link the fleet console follows to
 * reach it.
 *
 * ⚠ THIS MUST MATCH THE SPA VIEW in web/src/views.ts. The kit's router derives the view from
 * the first path segment (web/src/useRoute.ts), so the view registered as `reads` is served at
 * `/reads` — and web/ cannot import from src/, so the two spellings are kept in step by
 * test/web/views.test.ts (this constant must equal the path of the view gated by `readLog.read`),
 * not by the type system. Renaming the view without renaming this constant leaves every app in
 * the fleet publishing a dead deep link, and the registry keeps whatever it was last told.
 */
export const READ_LOG_VIEW_PATH = '/reads';

export type Fetcher = (input: string, init: RequestInit) => Promise<Response>;

function numeric(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/**
 * Run one optional report block, or give up on it quietly.
 *
 * EVERY ledger block is optional forever on the registry side, and this is the kit half of that
 * contract: a block whose read fails is OMITTED, and the rest of the report — status, manifest,
 * the health snapshot the fleet staleness check depends on — still goes. The failure mode this
 * exists to prevent is a single broken aggregate taking down an app's entire daily report, which
 * would present to an operator as the app going dark rather than as one missing chart.
 */
async function optionalBlock<T>(name: string, read: () => Promise<T>): Promise<T | undefined> {
  try {
    return await read();
  } catch (err) {
    logEvent('registry_report_block_failed', { block: name, err });
    return undefined;
  }
}

/**
 * The migrations block: which migration files this database has run, plus the two fingerprints
 * that make drift detectable. `schema_hash` is what turns "no new migrations" into a positive
 * statement — DDL that moved without one is the unreviewed change the fleet wants to see.
 *
 * Fields are omitted rather than sent as null when they could not be computed, because the
 * registry's drift rule compares two NON-null hashes: a null suppresses the comparison for a day
 * instead of fabricating a diff against a hash nobody computed.
 */
async function migrationsBlock(db: Db) {
  const applied = await db.meta.appliedMigrations();
  const schemaHash = await db.meta.schemaHash();
  // Newest LAST in wrangler's own ordering, so a truncation keeps the recent history.
  const trimmed = applied.slice(-MIGRATIONS_APPLIED_CAP);
  return {
    count: applied.length,
    names_hash: await migrationNamesHash(applied.map((m) => m.name)),
    ...(schemaHash ? { schema_hash: schemaHash } : {}),
    applied: trimmed.map((m) => ({
      name: m.name,
      ...(m.applied_at ? { applied_at: m.applied_at } : {}),
    })),
  };
}

/**
 * The deep link to this app's own read-log page, or undefined when the app has no dashboard host
 * to build one from. Capped at the registry's 500-character limit — a URL longer than that is a
 * misconfigured host, and a truncated link is worse than none.
 */
function activityUrl(env: Env): string | undefined {
  // DASHBOARD_HOST is a bare hostname by convention (`acme.cialdnb.ai`), but every other
  // URL-shaped var in the kit is a full URL, so an operator writing `https://acme.cialdnb.ai`
  // here is a plausible mistake — and one nothing would catch: the registry stores this as a
  // plain string with no URL validation, so `https://https://acme…/reads` would sail through and
  // render as a dead link in the console for as long as the app keeps reporting it.
  const host = (env.DASHBOARD_HOST ?? '')
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/+$/, '');
  if (!host) return undefined;
  const url = `https://${host}${READ_LOG_VIEW_PATH}`;
  return url.length <= 500 ? url : undefined;
}

/**
 * Manifest fields the governance slice DROPS — the only way a field escapes the daily report.
 *
 * These two lists are the whole safety mechanism. `GovernanceManifest` and `GovRoute` below are
 * derived by SUBTRACTION (`Omit`), never by listing what is kept (`Pick`), so a field added to
 * `AppManifest` or `ManifestRoute` lands in the projection's declared type immediately and the
 * object literal that no longer satisfies it stops compiling. A `Pick` would have read the same
 * and protected nothing — a new field simply would not be picked, which is exactly how
 * `checks_version` reported NULL fleet-wide from #199 to #209. Dropping a field now costs a line
 * here and a code-owner review; forgetting one is a red build.
 *
 * EXACTLY WHAT THE TYPES CATCH, so nobody trusts them further than they go:
 * - A field added to `AppManifest`/`ManifestRoute` and not projected — caught, both levels. The
 *   `Required<…>` is load-bearing for this: `Omit` PRESERVES optionality, so an `mcp_tools?:`
 *   added as optional would otherwise compile clean and be dropped silently — a verbatim repeat of
 *   `checks_version`. `Required` collapses that back to a hard error.
 * - An extra key written explicitly into either literal — caught (excess-property checking).
 * - An extra key arriving via a SPREAD (`.map((r): GovRoute => ({ ...r }))`) — NOT caught.
 *   TypeScript does not excess-property-check spread properties, so that one edit would ship
 *   `input_schema` for every route, which is the bulk of the manifest and the reason this slice
 *   exists. Do not write a spread here; the runtime pins in test/cron/reportToRegistry.test.ts
 *   are what stand behind that gap.
 *
 * A stale key in either list is harmless (`Omit` tolerates a key the source type no longer has,
 * and a RENAMED field still fails to compile because its new name is not omitted). An over-broad
 * list can never cause a silent drop — only an explicit, reviewed one.
 *
 * ONE CONSEQUENCE WORTH STATING: this flips the default for a new manifest field from "silently
 * not sent" to "the build breaks until you decide", and the one-line way to make it green is to
 * send it. THIS LITERAL IS THE LAST GATE BEFORE AN OUTBOUND POST to a host a fork can repoint
 * (REGISTRY_URL). The manifest is STRUCTURE, never data or secrets, so the risk is bounded — but
 * when a new field's governance value is not obvious, name it a drop rather than export it.
 *
 * What is dropped, and why:
 * - `app` — name/env/build_version already ride the payload as `source_key`/`name`/`status`, and
 *   two copies of one fact are two answers that can disagree.
 * - `input_schema` — request shapes, the bulk of the manifest and the reason this slice exists.
 * - `summary` — prose written for a human reading `GET /api/meta/manifest`. SETTLED, not pending:
 *   it is not governance and it is not coming (DECISIONS 2026-08-20).
 * - `rate_limited` — the one drop that is a real GAP, and it is DEFERRED, not settled. "Which
 *   write routes are unthrottled?" is a governance question the fleet cannot answer at all today
 *   because the registry has never received this field. It ships as a coordinated kit+registry
 *   pair (the shape of #209/#68), because a per-route field multiplies by the route count and the
 *   registry has to agree to ingest it. That PR is four edits: delete `'rate_limited'` from
 *   `DroppedRouteField`, add the line to the projection, bump `MANIFEST_VERSION` to the NEXT
 *   number (5 — 3 shipped with the agent exposure below and 4 with B9's `machine`; the slice is in
 *   scope of that number, see its comment), and record the new slice shape as a NEW entry 5 in the
 *   pin in test/cron/reportToRegistry.test.ts, never by editing the shipped entry 4.
 * - `agent` — the per-route agent exposure (manifest_version 3). DEFERRED, for the same reason as
 *   `rate_limited`: app-registry's ingest schema has no per-route field for it (its Zod objects
 *   STRIP unknown keys, so sending it today would reach nobody), and a per-route field ships as a
 *   coordinated kit+registry pair. What the fleet needs first is carried instead, at the top level
 *   where it costs two numbers per report: `agent_exposed` and `agent_client_egress` (the routes
 *   that must carry a DPO egress ruling). Those two are SENT from version 3 on; the registry
 *   strips them until it adds them to its schema (optional forever), so the report is accepted
 *   either way — the handshake in DECISIONS 2026-09-25. The per-route block stays in
 *   `GET /api/meta/manifest`. Its pair is the same four edits as `rate_limited`; if both ship
 *   together they share one bump.
 * - `machine` — DEFERRED, for the same reason as `rate_limited`, and it would ship in the same
 *   kind of coordinated kit+registry pair. "Which routes can no person reach?" is governance, but
 *   the registry's ingest schema has no field for it (a Zod object strips unknown keys, so sending
 *   it today would reach nobody) and the registry has to agree to take a per-route field. Added in
 *   manifest_version 4 (B9, insights D1 growth plan); until the pair lands it is visible in
 *   `GET /api/meta/manifest` only. The slice under version 4 is therefore the slice under 3. Its
 *   pair is the same four edits (`'machine'` out of `DroppedRouteField`, bump to 5, entry 5); if
 *   it ships with `rate_limited` or `agent`, they share one bump.
 */
type DroppedManifestField = 'app';
type DroppedRouteField = 'summary' | 'rate_limited' | 'agent' | 'machine' | 'input_schema';

/**
 * One route exactly as the registry receives it: `ManifestRoute` minus the per-route drops.
 *
 * A REAL declared type, not another inferred object literal — the per-route `.map()` has the same
 * inference hole the top-level projection had, and the containment pin from #209 never covered
 * this level. Typing only the outer shape would have moved the hole, not closed it.
 */
type GovRoute = Omit<Required<ManifestRoute>, DroppedRouteField>;

/** The governance slice: `AppManifest` minus the top-level drops, routes narrowed to `GovRoute`. */
type GovernanceManifest = Omit<Required<AppManifest>, DroppedManifestField | 'routes'> & {
  routes: GovRoute[];
};

// The governance slice of the app manifest — the ontology (permissions, roles, audit vocabulary,
// route surface). The registry stores who-can-do-what, not request shapes, so the leaner slice
// keeps the daily report small. What it drops and why is documented on the two drop lists above;
// keep docs/MANIFEST.md in step with them. Say what is dropped; a projection whose comment
// undersells it is how `checks_version` went missing between #199 (2026-08-14) and #209
// (2026-08-20). This line claimed "six months" until now — it was six days, and six daily
// reports; corrected rather than repeated, because the whole point of it is that a projection's
// prose has to be true.
//
// `needs` rides along because it IS governance: it is the per-route answer to "which route can
// touch which table", and a few repository names per route cost far less than the schemas the
// slice drops. Null (undeclared → the whole data layer) is carried as null, not flattened to an
// empty list — see ManifestRoute.needs; conflating them would report the widest routes in the
// fleet as the narrowest.
//
// Key order carries no contract: the registry parses JSON. (An earlier version of this comment
// claimed the order was preserved and that new fields are appended — neither was true, since
// `checks_version` was inserted third in #209.) The pins compare key SETS, sorted.
function governanceManifest(env: Env): GovernanceManifest {
  const m = buildManifest(env, allRoutes);
  return {
    manifest_version: m.manifest_version,
    kit_version: m.kit_version,
    // The CI-gate stamp. This projection (#105) is OLDER than the field (#199): #199 added
    // `checks_version` to `AppManifest` and to `GET /api/meta/manifest` but never touched this
    // list, so every app in the fleet reported the column as NULL on every daily report until #209
    // caught it — which reads identically to "this app runs no checks". Nothing caught it
    // because the projection's type
    // was inferred FROM the projection, so omitting a field compiled clean. That is now a compile
    // error (see the drop lists above); the containment pins in test/ are the runtime half.
    checks_version: m.checks_version,
    roles: m.roles,
    permissions: m.permissions,
    audit_actions: m.audit_actions,
    // The in-app agent's reach, as two counts (manifest_version 3): how many routes a model can
    // call, and how many of those let client-class data or any data leave toward a third party.
    // Zero on every kit app (default deny). The per-route exposure is a deferred drop (above).
    agent_exposed: m.agent_exposed,
    agent_client_egress: m.agent_client_egress,
    routes: m.routes.map(
      (r): GovRoute => ({
        method: r.method,
        path: r.path,
        permission: r.permission,
        audit: r.audit,
        needs: r.needs,
      }),
    ),
  };
}

export async function runReportToRegistry(
  env: Env,
  fetcher: Fetcher = (url, init) => fetch(url, init),
): Promise<string> {
  const token = await getSecret(env.REGISTRY_TOKEN);
  if (!token) return 'skipped: REGISTRY_TOKEN not set';
  // Production and staging both use the baked-in registry; the env-qualified source_key below
  // keeps their rows distinct. Any other env (test/development) stays silent unless it opts in
  // with an explicit REGISTRY_URL, which wins in every env.
  const raw = (env.REGISTRY_URL ?? '').trim();
  const explicit = raw.replace(/\/+$/, '');
  // A REGISTRY_URL that was SET but normalizes to nothing ('/', '//', whitespace) must DISARM, not
  // fall through to the baked-in default: the operator said "report somewhere else", and silently
  // reinterpreting that as "report to the fleet registry" would ship the bearer token and the full
  // governance manifest to a host they deliberately pointed away from. Fail closed, like the
  // https guard below.
  if (raw && !explicit) return 'skipped: REGISTRY_URL is set but empty after normalization';
  const base = explicit || (REPORTING_ENVS.includes(env.APP_ENV) ? DEFAULT_REGISTRY_URL : '');
  if (!base) return 'skipped: env does not report and no explicit REGISTRY_URL';

  // A bearer token rides this request, so require HTTPS (mirrors the alert-webhook gate in
  // alert.ts). An http:// or malformed REGISTRY_URL DISARMS the report — never send the
  // credential in cleartext over an operator's scheme typo.
  try {
    if (new URL(base).protocol !== 'https:') return 'skipped: REGISTRY_URL is not https';
  } catch {
    return 'skipped: REGISTRY_URL is not a valid URL';
  }

  // Snapshot our own health the same way /_health does (shared computeHealth). Called after the
  // heartbeat writes, so heartbeat_age reflects this run, not the previous day.
  const { status, checks } = await computeHealth(env);
  // Fleet AI-spend tripwire: ONE aggregate scalar, read only after the token/URL gates above so a
  // dormant app does no extra work. What it is NOT is as load-bearing as what it is — no per-user
  // rows, no hashed actor ids, no roll-up table, no fleet cost page. The measurement that scoped
  // this (fleet ≈ $129/month across 17 apps, 87% of it one app) killed all of that; what survives
  // is the alarm that tells the owner when the measurement stops holding. `actor_email` never
  // leaves the app.
  const db = makeDb(env);
  const aiSpend30d = await db.aiBudget.spendUsdSinceDays(AI_SPEND_WINDOW_DAYS);

  // ---- Fleet Ledger blocks (K1). SIBLINGS of status/manifest, never folded into
  // buildManifest: the manifest is pure and deterministic by documented invariant (no clock, no
  // I/O, snapshot-testable), and these are three database reads. Putting them there would make
  // GET /api/meta/manifest hit D1 on every request and break the snapshot test that guards the
  // ontology. Each is best-effort and independently omissible — see optionalBlock.
  const digests: ActivityDigest[] | undefined = await optionalBlock('activity', () =>
    db.activity.dailyDigests(),
  );
  // `activity[]` carries only the five streams the registry's ingest pins (a sixth stream name, or
  // a 41st row, would 400 the whole report). `reads_upstream` (PIA C15) rides `activity_upstream`
  // instead: today's registry strips an unknown key and keeps the rest of the report — pinned
  // there by "ingest STRIPS unknown keys rather than rejecting them" — and a registry that learns
  // the block ingests it. No handshake to get wrong, and never folded into `reads_aurora`.
  const split = digests ? splitForRegistry(digests) : undefined;
  const activity = split?.activity;
  const activity_upstream = split && split.upstream.length > 0 ? split.upstream : undefined;
  const migrations = await optionalBlock('migrations', () => migrationsBlock(db));
  const activity_url = activityUrl(env);

  const payload = {
    // Env-qualified so a prod deploy ('my-app') and its staging twin ('my-app-staging') never
    // collide on the registry's upsert key. This is what makes staging reporting safe.
    source_key: env.APP_ENV === 'production' ? env.APP_NAME : `${env.APP_NAME}-${env.APP_ENV}`,
    // Env-qualified for the same reason as source_key, but this is the HUMAN-facing field:
    // appDisplayName deliberately STRIPS the "(staging)"/"(test)" marker from MAIL_FROM_NAME so the
    // login interstitial and emails read "Acme", not "Acme (staging)". Harmless while only prod
    // reported — now that both do, an unqualified name would list every app twice under one
    // identical label, leaving source_key as the only way to tell the rows apart.
    // envQualified re-adds the marker WITHOUT double-suffixing: appDisplayName's strip list is
    // narrower than AppEnvName (no 'development'), so "Acme (development)" survives it intact.
    name: envQualified(appDisplayName(env.APP_NAME, env.MAIL_FROM_NAME), env.APP_ENV),
    status: {
      env: env.APP_ENV,
      build_version: env.APP_BUILD_VERSION,
      kit_version: KIT_VERSION,
      health: status,
      backup_age_hours: numeric(checks.last_backup_age_hours),
      heartbeat_age_hours: numeric(checks.cron_heartbeat_age_hours),
      maturity_mode: APP_MATURITY,
      // Trailing-30-day AI cost in USD, this app only. Appended after the original keys so their
      // shape and order stay put for consumers that already read this payload — the same reason
      // `read_audit` sits below rather than beside `health`. New scalars go at the BOTTOM.
      ai_spend_30d: aiSpend30d,
      // Has this app ARMED read attribution? STATED, never inferred — and stated by the one
      // predicate the framework itself branches on (`readAuditArmed`), so the report and the
      // runtime cannot drift apart. The registry previously read arming off `activity_url`, which
      // was a workable proxy only while that field was rare; K1 made it universal (every app with
      // a DASHBOARD_HOST publishes one) while `READ_AUDIT` ships OFF by design, so the inference
      // now says "armed" about the entire fleet. Always a boolean, never omitted: absent would be
      // indistinguishable from "an older kit that cannot answer", which is the ambiguity this
      // field exists to end.
      //
      // SCOPE, precisely: this is the ARMING DECLARATION, which gates the ordinary-D1 stream. It
      // is not "this app records no reads" — `src/data/aurora.ts` records private-database reads
      // unconditionally and that is not a thing an app can switch off (src/env.ts), and neither
      // is the upstream seam (`src/data/upstream.ts`, PIA C15). An app with an internal-class
      // Hyperdrive binding and READ_AUDIT unset therefore reports `false` while still writing
      // `read_log` rows. A receiver rendering this as "read-attribution coverage" must say so.
      // `false` does not even mean "reads no client data": `verify:edge` refuses a CLIENT-class
      // Hyperdrive binding without arming, but a CLIENT-class upstream source needs no arming —
      // the seam records it (write-ahead, fail-closed) whatever this says — so an app reading
      // client data from an upstream can report `false`. What it reads upstream is in
      // `activity_upstream`, not here.
      read_audit: readAuditArmed(env),
    },
    manifest: governanceManifest(env),
    // Optional ledger blocks, appended LAST so every key above keeps its shape and order for
    // consumers that already read this payload. Spread-when-present rather than sent as null:
    // the registry's schema strips unknown keys but still type-checks known ones, and "absent"
    // is the state it was built to accept.
    ...(activity ? { activity } : {}),
    ...(migrations ? { migrations } : {}),
    ...(activity_url ? { activity_url } : {}),
    // The `reads_upstream` digests (see above), appended after every existing key. Omitted when
    // the digests could not be read, or when read_log cannot hold upstream rows yet (0005 not
    // applied): absent means "not reporting", never zero.
    ...(activity_upstream ? { activity_upstream } : {}),
  };

  const res = await fetcher(`${base}/api/apps/ingest`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) return `reported to registry: HTTP ${res.status}`;
  return `reported to registry: health=${status}`;
}

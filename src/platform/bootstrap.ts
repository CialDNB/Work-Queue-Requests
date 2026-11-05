// Bootstrap rename helpers (single source of truth). scripts/new-app.mjs mirrors this
// logic in plain JS — keep both in sync; test/platform/bootstrap.test.ts pins it so drift
// fails CI. Same convention as src/platform/naming.ts ↔ scripts/provision.mjs.
//
// Why this exists: turning the template into an app is a string rename, but two failure
// modes slip past a naive find/replace —
//   1. an app-identifier `paved-road` left in a file the rename list forgot, and
//   2. the template's REAL staging resource ids surviving the rename. D1 and KV bind by
//      ID, not by the human-readable name, so renaming only the `database_name` label
//      leaves the `DB`/`SESSIONS` bindings pointed at paved-road's own staging DB +
//      session KV (cross-app data + session contamination). provision.mjs can't rewire
//      them either — it only fills the `PLACEHOLDER_RUN_PROVISION` sentinel.
// The bootstrap resets the staging ids to that sentinel and a tripwire greps for any
// residual identifier; both checks are the pure functions below.

/** The template's kebab-case identity — the form that appears in resource names, hosts,
 * package name, and the repo slug. Narrative prose uses "Paved Road" / "the paved road"
 * (display/space form), which is deliberately NOT matched so kit docs keep reading right. */
export const TEMPLATE_KEBAB = 'paved-road';
export const TEMPLATE_DISPLAY = 'Paved Road';
/** SCREAMING_SNAKE form, used for the PER-APP Secrets Store names that remain — e.g.
 * `PAVED_ROAD_AUDIT_API_TOKEN` → `<APP>_AUDIT_API_TOKEN`. NOTE: `ANTHROPIC_API_KEY` and
 * `AI_GATEWAY_TOKEN` are no longer store secrets — they are per-Worker secrets, whose names are
 * the binding names themselves (no app prefix, since the namespace is the Worker). The alert
 * webhook keeps its `PAVED_ROAD_ALERT_WEBHOOK_URL` name — the shared account-wide channel — via
 * the SHARED_SECRET_NAMES allowlist below, so the rename + tripwire leave it alone. See
 * DECISIONS 2026-06-17 and 2026-08-04. */
export const TEMPLATE_CONSTANT = 'PAVED_ROAD';

/** Secrets Store names that are deliberately SHARED across every app — NOT renamed per-app and
 * NOT flagged by the residual tripwire, even though they carry the `PAVED_ROAD` token. The alert
 * webhook is one account-wide channel (`PAVED_ROAD_ALERT_WEBHOOK_URL`); a per-app channel is an
 * in-app Alerting override, never a secret. See DECISIONS 2026-06-17. The Entra client secret
 * belongs to the one shared "CIAL Internal Apps" registration every kit app signs in through —
 * one secret to rotate, per-app cost is a redirect URI (DECISIONS 2026-07-01). The Turnstile
 * siteverify secret pairs with ONE fleet-wide Turnstile widget (`PAVED_ROAD_TURNSTILE_SECRET`);
 * the per-app cost is adding the app's hostnames to that widget's allowlist, not a new secret
 * (DECISIONS 2026-07-13). */
export const SHARED_SECRET_NAMES = [
  'PAVED_ROAD_ALERT_WEBHOOK_URL',
  'PAVED_ROAD_ENTRA_CLIENT_SECRET',
  'PAVED_ROAD_TURNSTILE_SECRET',
] as const;

/** The kit's own GitHub repository, a deliberately SHARED name like SHARED_SECRET_NAMES: never
 * renamed and never flagged. Carried kit files name it as the upstream an app syncs from
 * (`CANON_REPO` in scripts/sync-checks.mjs and the `source` of scripts/kit-checks/checks.sync.json)
 * and in issue links (`CialDNB/paved-road#256`). An app built on the kit still comes from the kit,
 * so renaming the slug would be wrong, and every /kit-upgrade would bring it back anyway. Only the
 * exact slug is exempt: a longer repository name (`CialDNB/paved-road-x`) is still flagged. */
export const KIT_REPOSITORY = 'CialDNB/paved-road';
// The slug, not followed by a character that would make it a longer repository name.
const KIT_REPOSITORY_RE = new RegExp(`${KIT_REPOSITORY}(?![\\w-])`);

/** kebab → SCREAMING_SNAKE (`arena-go` → `ARENA_GO`). */
export function constantCase(kebab: string): string {
  return kebab.toUpperCase().replaceAll('-', '_');
}

/** Sentinel that scripts/provision.mjs replaces with the freshly-created resource id. */
export const PROVISION_PLACEHOLDER = 'PLACEHOLDER_RUN_PROVISION';

/** The template's concrete STAGING resource ids (D1 + SESSIONS KV). Prod ships as the
 * placeholder, so only staging can carry real template ids. The DURABLE contamination check
 * looks for these: their presence in a non-template app means a rename carried over
 * paved-road's own bindings — cross-app data/session contamination no provisioning fixes
 * (fillPlaceholder is a no-op once a real id exists). */
export const TEMPLATE_STAGING_IDS: readonly string[] = [
  '358e2840-8dd7-45c4-b59d-18c48b10cb57', // paved-road-db-staging (D1)
  '02ab99a8697840d79c0e04b2919d518e', // paved-road-sessions-staging (SESSIONS KV)
];

/** Swap the template's identity for the new app's: kebab (`paved-road`), display
 * (`Paved Road`), and the SCREAMING_SNAKE secret prefix (`PAVED_ROAD`). Kebab + display use
 * split/join so the replacement is inserted LITERALLY (a `--display` value containing `$`
 * isn't read as a special pattern). The prefix is renamed everywhere EXCEPT where it begins a
 * deliberately-shared secret name (`PAVED_ROAD_ALERT_WEBHOOK_URL` stays put) — a negative
 * lookahead on the shared suffixes, with a function replacement so `$` stays safe there too.
 * SHARED_SECRET_NAMES are SCREAMING_SNAKE ids (no regex metacharacters). The kit's repository
 * name (KIT_REPOSITORY) is split out first and put back unchanged. */
export function renameTemplateRefs(text: string, name: string, display: string): string {
  const sharedSuffixes = SHARED_SECRET_NAMES.map((n) => n.slice(TEMPLATE_CONSTANT.length));
  const constantRe = new RegExp(
    TEMPLATE_CONSTANT + (sharedSuffixes.length ? `(?!${sharedSuffixes.join('|')})` : ''),
    'g',
  );
  return text
    .split(KIT_REPOSITORY_RE)
    .map((part) =>
      part
        .split(TEMPLATE_KEBAB)
        .join(name)
        .split(TEMPLATE_DISPLAY)
        .join(display)
        .replace(constantRe, () => constantCase(name)),
    )
    .join(KIT_REPOSITORY);
}

export interface StagingIdReset {
  text: string;
  /** Whether at least one D1 `database_id` slot was found and reset (a format-drift guard). */
  resetD1: boolean;
  /** Whether at least one KV `id` slot (inside kv_namespaces) was found and reset. */
  resetKv: boolean;
  /** Count of every staging id slot reset (D1 `database_id` + KV `id`). */
  resetCount: number;
}

/** Reset EVERY staging D1 `database_id` and KV namespace `id` to the provisioning sentinel,
 * leaving every other id (account_id, store_id, the `database_name` label) untouched. Resets
 * by STRUCTURE — all matches, globally — not an enumerated two-key list, so a second D1 or the
 * optional CACHE kv_namespace can't silently keep a template id. `database_id` is D1-specific;
 * the bare KV `"id"` reset is SCOPED to the kv_namespaces array so it can't clobber another
 * binding's `"id"` (e.g. a Hyperdrive/Vectorize config id an app adds) — provision only refills
 * DB/SESSIONS, so blanking a foreign id would strand it. Byte-preserving, the rewrite stays
 * textual. */
export function resetStagingResourceIds(text: string): StagingIdReset {
  let d1 = 0;
  let kv = 0;
  const withD1 = text.replace(/("database_id"\s*:\s*)"[^"]*"/g, (_m, prefix) => {
    d1++;
    return `${prefix}"${PROVISION_PLACEHOLDER}"`;
  });
  // Scope the bare-`"id"` reset to the kv_namespaces array via `[^\]]*` (stop at the first
  // `]`). Runs on RAW text: a `]` inside a COMMENT within the array would truncate the scope
  // early — fail-safe (a surviving template id is caught by the drift guard / contamination
  // check, never silently shipped). KV ids are hex and the template array is comment-free, so
  // the real flow is unaffected. Resets every `"id"` inside it (SESSIONS + an optional CACHE).
  const withKv = withD1.replace(
    /("kv_namespaces"\s*:\s*\[)([^\]]*)(\])/,
    (_m: string, open: string, inner: string, close: string) => {
      const reset = inner.replace(/("id"\s*:\s*)"[^"]*"/g, (_x, prefix) => {
        kv++;
        return `${prefix}"${PROVISION_PLACEHOLDER}"`;
      });
      return `${open}${reset}${close}`;
    },
  );
  return { text: withKv, resetD1: d1 > 0, resetKv: kv > 0, resetCount: d1 + kv };
}

/** Strip `//` line + block comments from JSONC WITHOUT touching comment-like sequences inside
 * string values — a `//` in a URL value must survive (the naive regex strip corrupted it,
 * breaking parsing for any app carrying such a value). A tiny char scanner tracking string +
 * escape state. Trailing commas are NOT handled (the kit's configs don't use them; JSON.parse
 * rejects them and parseJsonc fails closed → null). */
export function stripJsoncComments(text: string): string {
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

/** JSONC → object, tolerating `//` + block comments (wrangler configs carry both). Read-only
 * callers parse structurally so a key reorder can't fool them (the byte-preserving rewrites
 * stay textual). Returns null on malformed input (fail closed). */
export function parseJsonc(text: string): Record<string, unknown> | null {
  try {
    return JSON.parse(stripJsoncComments(text)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Pre-provision (bootstrap-path-only) check: after the rename every staging D1 + KV id must
 * be the placeholder. A concrete value here is the carried-over-id bug. Parsed structurally so
 * a key reorder can't yield a spurious failure. A config with no D1 or no KV id also fails
 * (both slots must be present + reset). This is the pre-provision gate, NOT ongoing hygiene —
 * once an app provisions, its ids are concrete and fine; use contaminatingTemplateIds() for
 * the durable post-provision detector. */
export function stagingIdsArePlaceholders(stagingConfigText: string): boolean {
  const config = parseJsonc(stagingConfigText);
  if (!config) return false;
  // Array.isArray, not `?? []`: a parseable-but-malformed config where d1_databases /
  // kv_namespaces is an object or string must fail CLOSED (→ false), not throw `.map`.
  const slots = (v: unknown): { database_id?: unknown; id?: unknown }[] =>
    Array.isArray(v) ? v : [];
  const d1 = slots(config.d1_databases).map((db) => db.database_id);
  const kv = slots(config.kv_namespaces).map((ns) => ns.id);
  if (d1.length === 0 || kv.length === 0) return false;
  return [...d1, ...kv].every((id) => id === PROVISION_PLACEHOLDER);
}

/** The DURABLE contamination detector: which of the template's own staging ids appear in this
 * text. Safe to run any time — unlike the placeholder check it never false-positives on a
 * correctly-provisioned app (an app's own ids differ from the template's). A substring scan,
 * so it catches the ids wherever they sit, independent of JSON shape. */
export function contaminatingTemplateIds(text: string): string[] {
  return TEMPLATE_STAGING_IDS.filter((id) => text.includes(id));
}

// Files/dirs where the kebab identity legitimately survives a bootstrap: kit narrative (it
// describes "the paved road" as a concept), kit machinery (the bootstrap + agent-guidance
// tooling and their tests must name the template they detect), the version stamp
// (`src/framework/version.ts` records which KIT the fork synced from — it names "paved-road" on
// purpose, like CLAUDE.md/CHANGELOG.md, and must NOT be renamed to the app's own identity), and
// the agent-guidance mirror (`.cursor/rules/paved-road.mdc` is a fixed kit filename, referenced
// by name). Everything else that still carries the kebab token after a rename is a forgotten
// app-identifier — the tripwire's quarry.
//
// EXPORTED so the tests can hold both copies together: test/platform/new-app.test.mjs reads this
// literal and checks the hand-duplicated mirror in scripts/new-app.mjs is EQUAL to it, and both
// test files check that every entry the kit needs is present. A fork may add entries of its own to
// both copies. The .mjs mirror can't be cross-imported here (it pulls node:child_process, which the
// Workers test pool can't load), which is why the parity check reads text.
//
// Two entries name files the kit does not have: the DB Israel release caller (whose fixed bytes
// name the central `il-paved-road-deployment` repository and so can never be renamed), which only
// a DB Israel app has, and the central-proposal script, which a later version adds. The
// deployment-target reader beside them holds the caller's bytes and the deployment marker's path.
// The three were added in one batch so the allowlist does not change again for that series.
export const SELF_REFERENCE_FILES = new Set([
  'CLAUDE.md',
  'CHANGELOG.md',
  'GUIDEBOOK.md',
  '.github/workflows/il-paved-road-release.yml',
  'scripts/new-app.mjs',
  'scripts/check-agent-guidance-sync.mjs',
  'scripts/central-proposal.mjs',
  'scripts/deployment-target.mjs',
  'src/framework/version.ts',
  'src/platform/bootstrap.ts',
  'test/auth/interstitial.test.ts',
  'test/platform/naming.test.ts',
  'test/platform/bootstrap.test.ts',
  'test/platform/new-app.test.mjs',
  'test/platform/provision.test.mjs',
  'test/platform/agent-guidance-sync.test.mjs',
]);
// tools/ = platform-maintainer content (the cf-provisioning Bruno collection) that
// legitimately names PAVED_ROAD_* fleet-shared secrets — found tripping a fork's
// residual scan during the 0.2.0 rollout (invisible on the template: the scan is
// inert here by design).
const SELF_REFERENCE_PREFIXES = ['docs/', '.claude/', '.cursor/', 'tools/'];

/** True when `paved-road` may legitimately remain in this path after a bootstrap. */
export function isTemplateSelfReference(path: string): boolean {
  const p = path.replace(/^\.\//, '');
  return SELF_REFERENCE_FILES.has(p) || SELF_REFERENCE_PREFIXES.some((dir) => p.startsWith(dir));
}

export interface RepoFile {
  path: string;
  content: string;
}

/** The bootstrap tripwire: every non-self-reference file that still carries the kebab
 * identity OR the SCREAMING_SNAKE secret token, sorted. Empty means the rename was complete.
 * Matching is case-sensitive, so display/space-form prose ("Paved Road", "the paved road")
 * is left alone — app identifiers are lowercase kebab by the naming rule (see naming.ts).
 * The PAVED_ROAD check catches a forgotten per-app secret name (which would otherwise make a
 * fresh app silently share the template's Anthropic key / gateway token); SHARED_SECRET_NAMES
 * are stripped first, so the deliberately-shared `PAVED_ROAD_ALERT_WEBHOOK_URL` never trips it.
 * The kit's repository name (KIT_REPOSITORY) is stripped first too. */
export function residualTemplateRefs(files: RepoFile[]): string[] {
  return files
    .filter((f) => {
      if (isTemplateSelfReference(f.path)) return false;
      const content = f.content.split(KIT_REPOSITORY_RE).join('');
      if (content.includes(TEMPLATE_KEBAB)) return true;
      // Ignore the deliberately-shared secret names before checking the SCREAMING_SNAKE token.
      const withoutShared = SHARED_SECRET_NAMES.reduce(
        (c, shared) => c.split(shared).join(''),
        content,
      );
      return withoutShared.includes(TEMPLATE_CONSTANT);
    })
    .map((f) => f.path)
    .sort();
}

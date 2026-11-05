// The runtime vocabulary: every variable and secret the Worker's `Env` (src/env.ts) reads, with
// the feature it belongs to, the variables that turn that feature on, how a CIAL app sets it, and
// what a DB Israel app's registration proposal does with it (scripts/central-proposal.mjs).
//
// A DB Israel app's Worker gets its variables and secrets only from its central catalog entry,
// and the release reads them back exactly, so the proposal must name the whole set. The app's
// wrangler configs are advisory there; this list is what the proposal cross-checks them against.
// test/platform/runtime-config.test.mjs pins it to src/env.ts in both directions (in the kit).
//
// `israel` is one of ISRAEL_DEFAULTS:
//   app-name            the catalog app name (= APP_NAME, and the app_identity row schema.sql seeds)
//   stage               the stage's name: "staging" for the proposal
//   staging-host        <app>.staging.dbisrael.ai
//   placeholder-sender  auth@invalid.example, central's placeholder until it sends mail (ILOPS-8950)
//   config              the value in the app's wrangler.staging.jsonc
//   default             unset: the code's own default applies (the proposal lists it as a decision)
//   test-only           a test knob, never set in a real environment
//   omit                left out of the proposal; `note` says why
//   optional            a Worker secret the owner may declare, for a feature they turn on
//   required-if-enabled a Worker secret the feature needs once its variables turn it on
//
// Plain data, dependency-free, so a plain-node script and a test read it without a build (the
// src/ai/policyVocabulary.mjs pattern). Not imported by the Worker.

/** @typedef {'var' | 'secret'} SettingKind */
/**
 * @typedef {'app-name' | 'stage' | 'staging-host' | 'placeholder-sender' | 'config' | 'default'
 *   | 'test-only' | 'omit' | 'optional' | 'required-if-enabled'} IsraelDefault
 */
/**
 * @typedef {{
 *   readonly name: string,
 *   readonly kind: SettingKind,
 *   readonly feature: string,
 *   readonly enabledBy: readonly string[],
 *   readonly cial: string,
 *   readonly israel: IsraelDefault,
 *   readonly note?: string,
 * }} RuntimeSetting
 */

/** @type {readonly SettingKind[]} */
export const SETTING_KINDS = Object.freeze(['var', 'secret']);

/** @type {readonly IsraelDefault[]} */
export const ISRAEL_DEFAULTS = Object.freeze([
  'app-name',
  'stage',
  'staging-host',
  'placeholder-sender',
  'config',
  'default',
  'test-only',
  'omit',
  'optional',
  'required-if-enabled',
]);

const WRANGLER = 'wrangler config vars';

/** @type {readonly RuntimeSetting[]} */
export const RUNTIME_SETTINGS = Object.freeze([
  // ---- variables ----
  {
    name: 'APP_NAME',
    kind: 'var',
    feature: 'core',
    enabledBy: [],
    cial: WRANGLER,
    israel: 'app-name',
  },
  { name: 'APP_ENV', kind: 'var', feature: 'core', enabledBy: [], cial: WRANGLER, israel: 'stage' },
  {
    name: 'APP_BUILD_VERSION',
    kind: 'var',
    feature: 'health',
    enabledBy: [],
    cial: 'wrangler deploy --var, from the deploy commit',
    israel: 'default',
    note: 'never set centrally, ILOPS-8868',
  },
  {
    name: 'MCP_WAITUNTIL_CAP_MS',
    kind: 'var',
    feature: 'mcp',
    enabledBy: [],
    cial: 'unset (a test knob)',
    israel: 'test-only',
  },
  {
    name: 'READ_AUDIT_STREAM_MAX_MS',
    kind: 'var',
    feature: 'read audit',
    enabledBy: [],
    cial: 'unset (a test knob)',
    israel: 'test-only',
  },
  {
    name: 'DASHBOARD_HOST',
    kind: 'var',
    feature: 'core',
    enabledBy: [],
    cial: WRANGLER,
    israel: 'staging-host',
  },
  {
    name: 'WORKERS_DEV_HOST',
    kind: 'var',
    feature: 'edge probe',
    enabledBy: [],
    cial: 'unset (dormant)',
    israel: 'default',
  },
  {
    name: 'MAIL_FROM',
    kind: 'var',
    feature: 'email',
    enabledBy: [],
    cial: WRANGLER,
    israel: 'placeholder-sender',
  },
  {
    name: 'MAIL_FROM_NAME',
    kind: 'var',
    feature: 'email',
    enabledBy: [],
    cial: WRANGLER,
    israel: 'config',
  },
  {
    name: 'CF_ACCOUNT_ID',
    kind: 'var',
    feature: 'ai',
    enabledBy: [],
    cial: WRANGLER,
    israel: 'omit',
    note: 'only with AI approved: the platform account, which the catalog requires',
  },
  {
    name: 'AI_GATEWAY_ID',
    kind: 'var',
    feature: 'ai',
    enabledBy: [],
    cial: WRANGLER,
    israel: 'omit',
    note: 'only with AI approved (ILOPS-8949): unset is the AI kill switch',
  },
  {
    name: 'AI_DEFAULT_MODEL',
    kind: 'var',
    feature: 'ai',
    enabledBy: ['AI_GATEWAY_ID'],
    cial: WRANGLER,
    israel: 'omit',
    note: 'only with AI approved',
  },
  {
    name: 'AI_LARGE_MODEL',
    kind: 'var',
    feature: 'ai',
    enabledBy: ['AI_GATEWAY_ID'],
    cial: WRANGLER,
    israel: 'omit',
    note: 'only with AI approved',
  },
  {
    name: 'AI_MAX_CALL_USD',
    kind: 'var',
    feature: 'ai',
    enabledBy: ['AI_GATEWAY_ID'],
    cial: WRANGLER,
    israel: 'omit',
    note: 'only with AI approved',
  },
  {
    name: 'AI_DAILY_USER_CAP_USD',
    kind: 'var',
    feature: 'ai',
    enabledBy: ['AI_GATEWAY_ID'],
    cial: WRANGLER,
    israel: 'omit',
    note: 'only with AI approved',
  },
  {
    name: 'AI_DAILY_GLOBAL_CAP_USD',
    kind: 'var',
    feature: 'ai',
    enabledBy: ['AI_GATEWAY_ID'],
    cial: WRANGLER,
    israel: 'omit',
    note: 'only with AI approved',
  },
  {
    name: 'AI_INFERENCE_GEO',
    kind: 'var',
    feature: 'ai',
    enabledBy: ['AI_GATEWAY_ID'],
    cial: 'unset ("us", the PIA C6 pin)',
    israel: 'omit',
    note: 'only with AI approved',
  },
  {
    name: 'SESSION_TTL_SEC',
    kind: 'var',
    feature: 'auth',
    enabledBy: [],
    cial: WRANGLER,
    israel: 'config',
  },
  {
    name: 'ALLOWED_EMAIL_DOMAINS',
    kind: 'var',
    feature: 'auth',
    enabledBy: [],
    cial: WRANGLER,
    israel: 'config',
  },
  {
    name: 'MAGIC_LINK_OUTBOX',
    kind: 'var',
    feature: 'auth',
    enabledBy: [],
    cial: 'a Worker secret on staging (wrangler secret put)',
    israel: 'omit',
    note: 'reading the outbox takes a Cloudflare token, which a DB Israel app has none of',
  },
  {
    name: 'ALERT_EMAIL',
    kind: 'var',
    feature: 'alerting',
    enabledBy: [],
    cial: WRANGLER,
    israel: 'omit',
    note: 'nothing sends mail centrally until ILOPS-8950',
  },
  {
    name: 'BACKUP_RETENTION_DAYS',
    kind: 'var',
    feature: 'backups',
    enabledBy: [],
    cial: 'unset (30 days)',
    israel: 'default',
  },
  {
    name: 'READ_AUDIT',
    kind: 'var',
    feature: 'read audit',
    enabledBy: [],
    cial: 'unset (dormant; "on" arms)',
    israel: 'default',
  },
  {
    name: 'READ_LOG_RETENTION_DAYS',
    kind: 'var',
    feature: 'read audit',
    enabledBy: ['READ_AUDIT'],
    cial: 'unset (60 days)',
    israel: 'default',
  },
  {
    name: 'MACHINE_SYNC_RUN',
    kind: 'var',
    feature: 'machine routes',
    enabledBy: [],
    cial: 'unset (enforcing)',
    israel: 'default',
  },
  {
    name: 'MACHINE_LIVENESS_HOURS',
    kind: 'var',
    feature: 'machine routes',
    enabledBy: [],
    cial: 'unset (6 hours)',
    israel: 'default',
  },
  {
    name: 'MACHINE_LIVENESS_ARMED',
    kind: 'var',
    feature: 'machine routes',
    enabledBy: [],
    cial: 'unset (silent until the first machine batch)',
    israel: 'default',
  },
  {
    name: 'AGENT_ENABLED',
    kind: 'var',
    feature: 'agent',
    enabledBy: [],
    cial: `${WRANGLER} ("off")`,
    israel: 'config',
  },
  {
    name: 'AGENT_TRANSCRIPT_RETENTION_DAYS',
    kind: 'var',
    feature: 'agent',
    enabledBy: ['AGENT_ENABLED'],
    cial: 'unset (required once armed)',
    israel: 'default',
  },
  {
    name: 'VAULT_RETENTION_DAYS',
    kind: 'var',
    feature: 'agent',
    enabledBy: ['AGENT_ENABLED'],
    cial: 'unset (required once armed with VAULT)',
    israel: 'default',
  },
  {
    name: 'AGENT_ARMING_RECORD',
    kind: 'var',
    feature: 'agent',
    enabledBy: ['AGENT_ENABLED'],
    cial: 'unset (required once armed)',
    israel: 'default',
  },
  {
    name: 'TURNSTILE_SITE_KEY',
    kind: 'var',
    feature: 'turnstile',
    enabledBy: [],
    cial: `${WRANGLER} ("" = off)`,
    israel: 'config',
  },
  {
    name: 'ENTRA_CLIENT_ID',
    kind: 'var',
    feature: 'sign-in',
    enabledBy: [],
    cial: `${WRANGLER} ("" = off)`,
    israel: 'config',
  },
  {
    name: 'ENTRA_ALLOWED_TENANTS',
    kind: 'var',
    feature: 'sign-in',
    enabledBy: [],
    cial: `${WRANGLER} ("" = off)`,
    israel: 'config',
  },
  {
    name: 'ENTRA_EMAIL_DOMAINS',
    kind: 'var',
    feature: 'sign-in',
    enabledBy: ['ENTRA_CLIENT_ID'],
    cial: WRANGLER,
    israel: 'config',
  },
  {
    name: 'REGISTRY_URL',
    kind: 'var',
    feature: 'registry',
    enabledBy: [],
    cial: 'unset (the URL is built in)',
    israel: 'default',
  },
  {
    name: 'AUDIT_DEPLOY_ACTORS',
    kind: 'var',
    feature: 'control-plane tripwire',
    enabledBy: [],
    cial: WRANGLER,
    israel: 'config',
  },
  {
    name: 'AUDIT_MATCH',
    kind: 'var',
    feature: 'control-plane tripwire',
    enabledBy: [],
    cial: 'unset (APP_NAME)',
    israel: 'default',
  },
  // ---- secrets ----
  {
    name: 'ANTHROPIC_API_KEY',
    kind: 'secret',
    feature: 'ai',
    enabledBy: ['AI_GATEWAY_ID'],
    cial: 'a per-Worker secret (secrets.required)',
    israel: 'required-if-enabled',
    note: 'with AI approved: a required runtime secret, beside AI_GATEWAY_TOKEN',
  },
  {
    name: 'AI_GATEWAY_TOKEN',
    kind: 'secret',
    feature: 'ai',
    enabledBy: ['AI_GATEWAY_ID'],
    cial: 'a per-Worker secret (secrets.required)',
    israel: 'required-if-enabled',
    note: 'with AI approved: a required runtime secret',
  },
  {
    name: 'TURNSTILE_SECRET',
    kind: 'secret',
    feature: 'turnstile',
    enabledBy: ['TURNSTILE_SITE_KEY'],
    cial: 'the shared Secrets Store',
    israel: 'required-if-enabled',
  },
  {
    name: 'ALERT_WEBHOOK_URL',
    kind: 'secret',
    feature: 'alerting',
    enabledBy: [],
    cial: 'the shared Secrets Store',
    israel: 'optional',
  },
  {
    name: 'ENTRA_CLIENT_SECRET',
    kind: 'secret',
    feature: 'sign-in',
    enabledBy: ['ENTRA_CLIENT_ID', 'ENTRA_ALLOWED_TENANTS'],
    cial: 'the shared Secrets Store',
    israel: 'required-if-enabled',
  },
  {
    name: 'REGISTRY_TOKEN',
    kind: 'secret',
    feature: 'registry',
    enabledBy: [],
    cial: 'the shared Secrets Store',
    israel: 'optional',
    note: 'reports to the CIAL fleet registry, a cross-organization data flow (ILOPS-8968)',
  },
  {
    name: 'SEAL_KEY',
    kind: 'secret',
    feature: 'sensitive-data protection',
    enabledBy: [],
    cial: 'a per-app secret (docs/runbooks/sensitive-data-key.md)',
    israel: 'optional',
  },
  {
    name: 'AUDIT_API_TOKEN',
    kind: 'secret',
    feature: 'control-plane tripwire',
    enabledBy: [],
    cial: 'a per-app Secrets Store secret',
    israel: 'omit',
    note: "reads a Cloudflare account's audit log: the platform's decision",
  },
]);

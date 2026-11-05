// THE AI CLIENT'S CONFIGURATION VOCABULARY — which models may be called and which inference region
// a config may pin — one definition, imported by both sides.
//
// Both sides read the same configuration and never meet at runtime:
//
//   - The RUNTIME honours it. src/ai/policy.ts refuses, on every call and before any secret is
//     read or any budget reserved, a model off this list (503 `ai_model_not_allowed`) and a region
//     this vocabulary does not admit (503 `ai_unconfigured`).
//   - The GATE enforces it. scripts/check-edge-hardening.mjs (`npm run verify:edge`) refuses a
//     deploying wrangler config whose AI_DEFAULT_MODEL, AI_LARGE_MODEL or AI_INFERENCE_GEO the
//     runtime would refuse. Without it, a fork whose production config names `claude-haiku-4-5`
//     (it rejects `inference_geo`) keeps a green CI and then answers every AI call in production
//     with a 503; and a config that sets `"global"` in production drops the PIA C6 pin with no
//     review at all.
//
// PLAIN JAVASCRIPT ON PURPOSE, for the reason src/framework/readAuditVocabulary.mjs gives: the gate
// runs under plain `node` and cannot import TypeScript; esbuild bundles a `.mjs` into the worker
// happily; and tsconfig's `allowJs` + `checkJs` hold this file to the same `strict` as every .ts.
// Two lists that merely agree today are how the gate ends up passing a model the runtime refuses.
//
// NO IMPORTS, EVER — every consumer must be able to load this file on its own. Keep it data and
// pure functions over data.

/**
 * The models the client may call, with the two ways they differ (documented on `ModelPolicy` in
 * src/ai/policy.ts): `forcedToolChoice` — accepts `tool_choice` `any` / `tool`; `hiddenThinking` —
 * thinks by default without streaming it. Exact ids of Claude 4.6+ models the kit prices; see
 * policy.ts for why each exclusion (Haiku 4.5, the Covered Models, Opus 4.6 / 4.7) exists. Adding
 * a model is one reviewed edit here plus its rate row and effort row (a test pins all three).
 */
export const ALLOWED_MODELS = Object.freeze({
  'claude-opus-5-5': Object.freeze({ forcedToolChoice: false, hiddenThinking: true }),
  'claude-sonnet-5': Object.freeze({ forcedToolChoice: true, hiddenThinking: true }),
  'claude-opus-5': Object.freeze({ forcedToolChoice: true, hiddenThinking: true }),
  'claude-opus-4-8': Object.freeze({ forcedToolChoice: true, hiddenThinking: false }),
  'claude-sonnet-4-6': Object.freeze({ forcedToolChoice: true, hiddenThinking: false }),
});

/**
 * Whether `model` is on the allowlist. Own keys only: `constructor` or `__proto__` must never read
 * as a row, and a non-string (a number in a JSONC vars block) is never a model.
 *
 * @param {unknown} model
 * @returns {model is keyof typeof ALLOWED_MODELS}
 */
export function isAllowedModel(model) {
  return typeof model === 'string' && Object.hasOwn(ALLOWED_MODELS, model);
}

/** The wrangler `vars` keys / `Env` fields that name a model the client will call. */
export const MODEL_VARS = Object.freeze(['AI_DEFAULT_MODEL', 'AI_LARGE_MODEL']);

/**
 * The wrangler `vars` key / `Env` field that pins the inference region. policy.ts reads
 * `env[INFERENCE_GEO_VAR]`, so renaming it here fails `npm run typecheck` until `Env` follows.
 */
export const INFERENCE_GEO_VAR = 'AI_INFERENCE_GEO';

/**
 * THE region rule, for a configured AI_INFERENCE_GEO and the APP_ENV beside it:
 *   - unset or empty → 'us' (the pin PIA C6 requires);
 *   - 'us' → 'us';
 *   - 'global' → 'global' outside production; in production → 'global_in_production', a refusal:
 *     "any location" is a DPO-assessed exception, and a var anyone can set from the dashboard is
 *     not where that decision lives;
 *   - anything else → 'invalid', a refusal.
 * Exact comparisons only: `'US'` or `' us'` is a misconfiguration, not a region.
 *
 * @param {unknown} value the configured AI_INFERENCE_GEO, however the caller got hold of it
 * @param {unknown} appEnv the same configuration's APP_ENV
 * @returns {'us' | 'global' | 'global_in_production' | 'invalid'}
 */
export function resolveInferenceGeo(value, appEnv) {
  if (value === undefined || value === '' || value === 'us') return 'us';
  if (value === 'global') return appEnv === 'production' ? 'global_in_production' : 'global';
  return 'invalid';
}

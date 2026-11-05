// THE VOCABULARY OF "THE READ LEDGER IS ARMED" — one definition, imported by both sides.
//
// Arming is asserted in two places that never meet at runtime:
//
//   - The RUNTIME honours it. `readAuditArmed(env)` in readAudit.ts is what `executeRoute`
//     branches on to wrap `ctx.db`, and — since the governance projection — what the daily
//     fleet report sends as `status.read_audit`.
//   - The GATE enforces it. `scripts/check-edge-hardening.mjs` refuses a client-class private
//     database binding in a deploying config that has not armed the ledger, because read
//     attribution is the compensating control that makes client data on a shared Cloudflare
//     account acceptable at all.
//
// Both used to spell the vocabulary out for themselves. Two spellings that merely agree today
// is the shape of a control that fails silently later: change the word on the runtime side and
// `verify:edge` goes on enforcing a value nothing honours, while the app REPORTS arming to the
// fleet registry that CI never actually checked. The gate would be green, the registry row
// would say `read_audit: true`, and no read would be recorded. So there is one definition and
// the disagreement is unrepresentable rather than merely tested for.
//
// PLAIN JAVASCRIPT ON PURPOSE — and this is the whole reason the file exists as its own module.
// The gate runs under `node --test` / plain `node`, so it cannot import TypeScript; the worker
// is bundled by esbuild, which happily inlines a `.mjs`. A `.mjs` with no dependencies is the
// only artifact both can literally import. (`tsconfig.json` carries `allowJs` + `checkJs` for
// this file: TypeScript reads it, infers the string-literal types, and type-checks it under the
// same `strict` as everything else — no `.d.mts` mirror, which would have reintroduced the
// second declaration this file exists to remove.)
//
// NOTHING ELSE BELONGS HERE, and "nothing else" means no DEPENDENCIES — not a cap on the three
// exports. Every consumer imports from a module that imports nothing itself, so it can never pull
// the framework into the plain-node gate or a node builtin into the worker. Keep it these three
// exports and no imports; in particular the comparison BELONGS here (see `isReadAuditArmed`) and
// moving it back to the callers as "not a constant" would re-open the drift this file closes.

/**
 * The wrangler `vars` key / `Env` field an app sets to declare it has adopted the ledger.
 * Renaming it here moves BOTH the runtime read and the gate's config lookup, and fails
 * `npm run typecheck` until `Env` (src/env.ts) declares the new name — the rename cannot land
 * half-done.
 */
export const READ_AUDIT_VAR = 'READ_AUDIT';

/** `READ_AUDIT` is armed with exactly this value; anything else (including unset) is off. */
export const READ_AUDIT_ARMED = 'on';

/**
 * THE comparison. Sharing the two constants would still have left each side writing its own
 * `===`, and that is a live drift axis of its own: one side made tolerant — trimmed, lowercased,
 * `'true'` accepted as a kindness — and the gate and the runtime disagree again about a config
 * they both read correctly. Exactness is the property (an app is armed because it said the word,
 * not because it said something armed-ish), so the exactness lives in one function.
 *
 * What each caller still owns is only WHERE the value comes from — `env` at runtime, a parsed
 * wrangler config in the gate — which is irreducibly different and is the reason each keeps its
 * own one-line `readAuditArmed` wrapper.
 *
 * @param {unknown} value the raw `READ_AUDIT` value, however the caller got hold of it
 * @returns {boolean}
 */
export function isReadAuditArmed(value) {
  return value === READ_AUDIT_ARMED;
}

// A REPOSITORY DECLARES ITS OWN WRITES, so the read ledger stops filing them as reads.
//
// The framework's read-attribution proxy (src/framework/readAudit.ts) records every repository
// method it does not know to be a write. Its own list, `WRITE_METHOD_NAMES`, names the KIT's
// write methods and nothing else, by design: unknown methods count as reads, because a read that
// quietly records nothing is the failure nobody ever sees. The cost of that default landed on the
// forks. Every fork's `upsertBatch`, `upsertRegistry` or `upsertManifest` was filed as a read, one
// spare `read_log` row per call, and on an ingest route that is most of the ledger.
//
// The fix is a declaration that travels WITH the repository object, rather than a second name
// list somewhere else that has to be kept in step with it:
//
//   export function subscriberDecisionsRepo(db: D1Database) {
//     return {
//       [DECLARED_WRITES]: ['upsertBatch'],
//       async upsertBatch(rows) { ... },
//       async bySubscriberNumber(n) { ... },
//     };
//   }
//
// The recording proxy reads it off the object it is about to wrap, so `scopeDb`, a spread, or any
// other composition that keeps the object's own properties keeps the declaration too. The kit's
// older repositories do not use it: their writes stay on `WRITE_METHOD_NAMES`, which is why their
// `makeDb()` output, and so the unarmed path, is unchanged by this file. The agent transcript store
// (src/data/agent.ts, src/data/agentErasure.ts) DOES declare its writes here: names such as
// `eraseThreads` or `pruneTranscripts` are generic enough that a fork may have a same-named READ,
// which a global entry would silently stop attributing.
//
// ── WHY A COMPUTED KEY INSIDE THE LITERAL, AND NOT A WRAPPER FUNCTION ─────────────────────────
// `return declareWrites([...], { ... })` would read well and could even be type-checked, but
// `npm run verify:core` finds a repository's methods by parsing the object literal after
// `return {` (scripts/kit-checks/check-core-reachability.mjs, `repoMembers`). A wrapper call hides
// that literal and makes the gate parse the wrong object, which is a false red in every fork that
// adopts it. A computed member leaves the literal where the gate expects it, and the gate already
// skips it (it is not a `name(` or `name:` member).
//
// What a typo in the list costs: nothing is excluded that should not be, and the misspelled write
// keeps recording as a read. The kit test that walks every `makeDb()` repository
// (test/isolation/declared-writes.test.ts) fails on a declared name that is not a method, and on
// a write-named method (`upsert*`, `insert*`, `delete*`, `replace*`, `bulk*`) that nobody declared.
//
// ── A DECLARATION IS A DECISION TO STOP ATTRIBUTING ───────────────────────────────────────────
// A declared method is never recorded again, for ANY caller: an ETL's ingest and a person's click
// alike. For a real write that is the point. For a read it is a silent gap in the trail, and
// nothing checks what a declared method does: the tripwire proves a declared name is a method, not
// that it writes. So declare only methods that write and hand no stored rows back. A
// `bulkExport(ids)` that returns client rows is a read whatever its name: rename it, never declare
// it. Treat each entry as the same reviewed decision as an entry on `WRITE_METHOD_NAMES`.
// `src/data/` is protected core (CODEOWNERS), so a declaration rides the code-owner review every
// change there already needs. That review is the check.

/**
 * The key a repository declares its write methods under. A `unique symbol`, so it cannot collide
 * with a method name, is skipped by `Object.keys` / `JSON.stringify` / `for…in`, and does not
 * appear in anything that enumerates a repository's methods.
 */
export const DECLARED_WRITES: unique symbol = Symbol('kit.declaredWrites');

const NONE: ReadonlySet<string> = new Set();

/**
 * The method names a repository declared as writes, or an empty set.
 *
 * A malformed declaration (not an array, or an array holding something other than strings)
 * yields only its string entries, or nothing, and never throws on its own account. The failure
 * direction is deliberate: a write that is not recognised is recorded as a read, which is a spare
 * row, never a read that goes missing. A getter on the key that throws is the caller's to catch;
 * the read-audit proxy does, and degrades to "no declaration".
 */
export function declaredWritesOf(repo: object): ReadonlySet<string> {
  const declared: unknown = Reflect.get(repo, DECLARED_WRITES);
  if (!Array.isArray(declared)) return NONE;
  return new Set(declared.filter((name): name is string => typeof name === 'string'));
}

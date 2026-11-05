// Zod → JSON Schema, the way the kit's consumers want it. Shared by the app manifest
// (src/framework/manifest.ts) and the MCP tool generator (src/mcp/tools.ts) so there is
// exactly one converter with one set of semantics.
import { z } from 'zod';
import { logEvent } from '../platform/logEvent';

/**
 * The JSON Schema of the INPUT a caller sends. `io:'input'` is load-bearing: a field with
 * `.default()` is OPTIONAL for the caller (the default fills it in), so it must NOT land in
 * `required`. Zod's default (output view) marks defaulted fields required, which would tell the
 * codegen consumers (MCP tools, web client) to force optional inputs — the opposite of the
 * route contract. An exotic schema (a transform/effect JSON Schema can't express) yields a
 * marker object rather than throwing, so one odd input never breaks a whole manifest/tool list.
 *
 * The catch is NARROW on purpose. A type JSON Schema genuinely can't represent (z.date(),
 * z.bigint(), z.symbol(), z.map(), …) is expected and benign → return the marker silently. ANY
 * OTHER throw (a schema cycle, a duplicate `$id`, an internal Zod bug, or a future Zod API rename
 * that changes how conversion fails) is NOT benign: it would silently blank the input_schema of
 * potentially EVERY route fleet-wide. We still return the marker (staying fail-safe — one route
 * must never break the whole manifest), but log a warn-level event so the degradation is observable
 * instead of swallowed.
 */
export function toInputJsonSchema(input: z.ZodTypeAny): unknown {
  try {
    return z.toJSONSchema(input, { io: 'input' });
  } catch (err) {
    if (!isNotRepresentableError(err)) {
      // Emitting the not-representable marker instead of a schema; investigate. The error's
      // category only — a Zod message can quote the schema, and this lands in Workers Logs.
      logEvent('jsonSchema_unexpected_conversion_error', { err });
    }
    return { $comment: 'input not representable as JSON Schema' };
  }
}

/**
 * True when Zod threw because a schema has no JSON Schema form. Zod v4 signals this several ways,
 * all matched here (verified against the full throw set in zod's json-schema-processors):
 *   - the per-type `"<Type> cannot be represented in JSON Schema"` throws (Date, BigInt, Symbol,
 *     Map, Set, Transforms, NaN, Function, Custom, Undefined, Void, …),
 *   - `"Dynamic catch values are not supported in JSON Schema"` — same `"… in JSON Schema"` tail,
 *   - the generic `"[toJSONSchema]: Non-representable type encountered: <type>"` fallback,
 *   - `"Pattern not found in template literal"` — the one benign message with no shared phrasing.
 * Everything else Zod can throw is a DIFFERENT class that must surface, not be swallowed: "Cycle
 * detected: …", `Duplicate schema id "…" detected during JSON Schema conversion` (note: "during",
 * not "in", JSON Schema — so it does NOT match), "Schema is missing an `id` property", "Unprocessed
 * schema. This is a bug in Zod.", "Error converting schema to JSON." The match fails SAFE: if a
 * future Zod renames these strings the classification errs toward the warn event (loud), and the
 * end-to-end tests in jsonSchema.test.ts exercise real not-representable types so such a rename
 * fails CI rather than silently degrading.
 */
export function isNotRepresentableError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return (
    err.message.includes('in JSON Schema') ||
    err.message.includes('Non-representable type') ||
    err.message.includes('template literal')
  );
}

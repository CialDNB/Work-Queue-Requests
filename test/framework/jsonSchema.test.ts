import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { isNotRepresentableError, toInputJsonSchema } from '../../src/framework/jsonSchema';
import { eventNames } from '../helpers/logs';

const MARKER = { $comment: 'input not representable as JSON Schema' };

describe('toInputJsonSchema', () => {
  afterEach(() => vi.restoreAllMocks());

  it('emits input-view JSON Schema — a defaulted field is optional, not required', () => {
    const schema = toInputJsonSchema(
      z.object({ title: z.string(), body: z.string().default('') }),
    ) as { type?: string; required?: string[]; properties?: Record<string, unknown> };
    expect(schema.type).toBe('object');
    expect(schema.required).toEqual(['title']); // body defaults → NOT required of the caller
    expect(schema.properties && 'body' in schema.properties).toBe(true);
  });

  it('returns the marker SILENTLY for every type JSON Schema genuinely cannot represent', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Real not-representable Zod types, each throwing a distinct "… in JSON Schema" message. Driving
    // the ACTUAL converter (not hand-written messages) is the safety net for the classifier's
    // forward-brittleness: a future Zod that renames these throws would make the warn fire here and
    // FAIL CI, rather than silently degrading every manifest in production.
    const exotics = [
      z.date(),
      z.bigint(),
      z.symbol(),
      z.map(z.string(), z.number()),
      z.set(z.string()),
      z.nan(),
      z.object({ when: z.date() }), // nested — the whole route input collapses to the marker
    ];
    for (const exotic of exotics) {
      expect(toInputJsonSchema(exotic)).toEqual(MARKER);
    }
    expect(warn).not.toHaveBeenCalled(); // narrow catch → zero noise for the expected/benign case
  });

  it('returns the marker BUT warns on an UNEXPECTED conversion error (never swallowed)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Two DIFFERENT schemas sharing an id makes Zod throw a duplicate-id error — a different class
    // from "not representable" (a cycle, an internal Zod bug, or a future API rename look the same).
    // The converter must stay fail-safe (still return the marker) yet make the degradation visible.
    const dupId = z.object({
      a: z.string().meta({ id: 'dup' }),
      b: z.number().meta({ id: 'dup' }),
    });
    expect(toInputJsonSchema(dupId)).toEqual(MARKER);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(eventNames(warn.mock.calls)).toEqual(['jsonSchema_unexpected_conversion_error']);
    // The error's category only: Zod's message quotes the schema, and this lands in Workers Logs.
    expect(JSON.parse(String(warn.mock.calls[0]?.[0]))).toEqual({
      event: 'jsonSchema_unexpected_conversion_error',
      err: { name: 'Error' },
    });
  });
});

describe('isNotRepresentableError', () => {
  it('recognizes every Zod "not representable" phrasing (per-type + not-supported + fallback + template)', () => {
    for (const msg of [
      'Date cannot be represented in JSON Schema',
      'BigInt cannot be represented in JSON Schema',
      'Symbols cannot be represented in JSON Schema',
      'Transforms cannot be represented in JSON Schema',
      'Map cannot be represented in JSON Schema',
      'Set cannot be represented in JSON Schema',
      'Undefined cannot be represented in JSON Schema',
      'NaN cannot be represented in JSON Schema',
      'Dynamic catch values are not supported in JSON Schema', // "not supported", not "cannot be represented"
      'Pattern not found in template literal', // the one benign message with no shared phrasing
      '[toJSONSchema]: Non-representable type encountered: custom',
    ]) {
      expect(isNotRepresentableError(new Error(msg)), msg).toBe(true);
    }
  });

  it('does NOT classify unexpected Zod errors as representable (they must surface)', () => {
    for (const msg of [
      'Cycle detected: #/',
      'Duplicate schema id "x" detected during JSON Schema conversion.',
      'Unprocessed schema. This is a bug in Zod.',
      'Schema is missing an `id` property',
      'Error converting schema to JSON.',
    ]) {
      expect(isNotRepresentableError(new Error(msg)), msg).toBe(false);
    }
  });

  it('is false for a non-Error throw (defensive)', () => {
    expect(isNotRepresentableError('Date cannot be represented in JSON Schema')).toBe(false);
    expect(isNotRepresentableError(undefined)).toBe(false);
    expect(isNotRepresentableError({ message: 'Date cannot be represented in JSON Schema' })).toBe(
      false,
    );
  });
});

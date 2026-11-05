// batchAudit() and the key fingerprint (src/framework/batchAudit.ts), lifted from the insights
// pilot (CialDNB/insights#272) with its review fixes: counts that add up, an exact byte-level
// recipe for any key, hash-only person keys, and a hard 1 KB bound. The framework half (runId
// stamping, the oversize backstop) is test/framework/machine-routes.test.ts.
//
// No hash literal appears here: each expected hash is computed independently from the exact TEXT
// the recipe hashes, and that text is pinned to what the published Python one-liner produces
//   json.dumps(sorted(keys), separators=(",", ":"))
// (checked against Python on 600 fuzzed batches while this was written). All keys are synthetic.
import { describe, expect, it, vi } from 'vitest';
import {
  BATCH_AUDIT_MAX_REJECTED_KEYS,
  type BatchAuditInput,
  batchAudit,
  fingerprintText,
  keyFingerprint,
  sortByCodePoint,
} from '../../src/framework/batchAudit';
import { MACHINE_AUDIT_PAYLOAD_MAX_BYTES, utf8Bytes } from '../../src/framework/machine';
import { loggedEvents } from '../helpers/logs';

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

const base: BatchAuditInput = {
  table: 'orders',
  received: 0,
  written: 0,
  unchanged: 0,
  rejected: 0,
  keys: [],
  runId: 'run-1',
};

const bytesOf = (payload: unknown): number => utf8Bytes(JSON.stringify(payload));

describe('batchAudit: the row shape', () => {
  it('carries table, counts, the fingerprint and the run id — and never the key list', async () => {
    const payload = await batchAudit({
      ...base,
      received: 3,
      written: 1,
      unchanged: 1,
      rejected: 1,
      keys: ['K-2', 'K-1', 'K-3'],
      rejectedKeys: ['K-3'],
    });
    expect(payload).toEqual({
      table: 'orders',
      received: 3,
      written: 1,
      unchanged: 1,
      rejected: 1,
      keys: {
        count: 3,
        keysSha256: await sha256Hex('["K-1","K-2","K-3"]'),
        firstKey: 'K-1',
        lastKey: 'K-3',
      },
      rejectedKeys: ['K-3'],
      runId: 'run-1',
    });
  });

  it('carries duplicates when the write reports them, so the counts add up', async () => {
    const keys = [...Array.from({ length: 8 }, (_, i) => `K-${i}`), 'K-0', 'K-1'];
    const payload = await batchAudit({
      ...base,
      received: 10,
      written: 3,
      unchanged: 5,
      rejected: 0,
      duplicates: 2,
      keys,
    });
    expect(payload.duplicates).toBe(2);
    expect(payload.received).toBe(
      payload.written + payload.unchanged + payload.rejected + (payload.duplicates ?? 0),
    );
    expect(payload.keys.count).toBe(10); // the fingerprint counts what was SENT
  });

  it('omits duplicates, suppressed and rejectedKeys when there is nothing to say', async () => {
    const payload = await batchAudit({ ...base, received: 1, written: 1, keys: ['K-1'] });
    expect(payload).not.toHaveProperty('duplicates');
    expect(payload).not.toHaveProperty('suppressed');
    expect(payload).not.toHaveProperty('rejectedKeys');
  });

  it(`names at most ${BATCH_AUDIT_MAX_REJECTED_KEYS} refused keys, a prefix, while rejected keeps the true count`, async () => {
    const keys = Array.from({ length: 60 }, (_, i) => `K-REJ-${i}`);
    const payload = await batchAudit({
      ...base,
      received: 60,
      rejected: 60,
      keys,
      rejectedKeys: keys,
    });
    expect(payload.rejected).toBe(60);
    expect(payload.rejectedKeys).toEqual(keys.slice(0, BATCH_AUDIT_MAX_REJECTED_KEYS));
  });

  it('a SUPPRESSED batch keeps suppressed: true and names no refused key (the hash names them all)', async () => {
    const keys = ['K-2', 'K-1'];
    const payload = await batchAudit({
      ...base,
      received: 2,
      rejected: 2,
      suppressed: true,
      keys,
      rejectedKeys: keys,
    });
    expect(payload).toMatchObject({ suppressed: true, rejected: 2 });
    expect(payload).not.toHaveProperty('rejectedKeys');
  });

  it('stores a valid run id and nulls anything else', async () => {
    expect((await batchAudit({ ...base, runId: null })).runId).toBeNull();
    for (const bad of ['', 'x'.repeat(65), 'run 1', 'run/1']) {
      expect((await batchAudit({ ...base, runId: bad })).runId).toBeNull();
    }
    expect((await batchAudit({ ...base, runId: 'A-z_0.9:x' })).runId).toBe('A-z_0.9:x');
  });

  it('refuses a table that is not a short identifier (a literal in the calling code)', async () => {
    for (const table of ['', 'x'.repeat(65), 'orders; drop', 'a b']) {
      await expect(batchAudit({ ...base, table })).rejects.toThrow(/table/);
    }
  });
});

describe('keyFingerprint: identity of a batch', () => {
  it('the same keys in any order give the same fingerprint', async () => {
    const keys = ['D-3', 'D-1', 'D-2', 'D-10'];
    const a = await keyFingerprint(keys);
    expect(await keyFingerprint([...keys].reverse())).toEqual(a);
    expect(await keyFingerprint(['D-2', 'D-10', 'D-3', 'D-1'])).toEqual(a);
  });

  it('different keys give a different hash; so do the same keys with a duplicate', async () => {
    const a = await keyFingerprint(['D-1', 'D-2']);
    expect((await keyFingerprint(['D-1', 'D-3'])).keysSha256).not.toBe(a.keysSha256);
    const dup = await keyFingerprint(['D-1', 'D-1', 'D-2']);
    expect(dup.count).toBe(3);
    expect(dup.keysSha256).not.toBe(a.keysSha256);
  });

  it('firstKey and lastKey are the ends of the SORTED list, so they bound the batch', async () => {
    expect(await keyFingerprint(['D-M', 'D-A', 'D-Z', 'D-C'])).toMatchObject({
      count: 4,
      firstKey: 'D-A',
      lastKey: 'D-Z',
    });
  });

  it('an empty batch: count 0, the hash of [], no ends', async () => {
    expect(await keyFingerprint([])).toEqual({
      count: 0,
      keysSha256: await sha256Hex('[]'),
      firstKey: null,
      lastKey: null,
    });
  });

  it('the hash is lowercase hex SHA-256', async () => {
    expect((await keyFingerprint(['a'])).keysSha256).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('the recipe, byte for byte (what Python prints)', () => {
  // Each pair: the keys, and the exact text json.dumps(sorted(keys), separators=(",", ":"))
  // produces for them. The hash must be the SHA-256 of that ASCII text.
  const PINS: Array<[string, string[], string]> = [
    ['ASCII: sha256 of ["a","b","c"]', ['b', 'c', 'a'], '["a","b","c"]'],
    [
      'code point order, not UTF-16 code unit order (U+FF01 before U+1F600)',
      ['\u{1F600}b', '\uFF01a'],
      '["\\uff01a","\\ud83d\\ude00b"]',
    ],
    ['a newline inside a key (1 of 2)', ['a\nb', 'c'], '["a\\nb","c"]'],
    ['a newline inside a key (2 of 2)', ['a', 'b\nc'], '["a","b\\nc"]'],
    [
      'a lone surrogate, DEL, a line separator and an accented letter',
      ['plain', '\uD800-lone', 'del\u007F', 'line\u2028sep', 'caf\u00E9'],
      '["caf\\u00e9","del\\u007f","line\\u2028sep","plain","\\ud800-lone"]',
    ],
    [
      'quote, backslash, slash and control characters',
      ['q"', 'b\\', 's/', 't\t', 'n\u0000', 'u\u001f'],
      '["b\\\\","n\\u0000","q\\"","s/","t\\t","u\\u001f"]',
    ],
  ];

  for (const [name, keys, text] of PINS) {
    it(name, async () => {
      expect(fingerprintText(sortByCodePoint(keys))).toBe(text);
      expect([...text].every((ch) => ch.charCodeAt(0) < 0x80)).toBe(true); // pure ASCII
      const fp = await keyFingerprint(keys);
      expect(fp.keysSha256).toBe(await sha256Hex(text));
    });
  }

  it('is injective where a newline join is not', async () => {
    // Joined with "\n", both of these are the text "a\nb\nc".
    const one = await keyFingerprint(['a\nb', 'c']);
    const two = await keyFingerprint(['a', 'b\nc']);
    expect(one.keysSha256).not.toBe(two.keysSha256);
  });

  it('sorts a key above U+FFFF after one in U+E000-U+FFFF (JavaScript default sort gets this wrong)', () => {
    const keys = ['\u{1F600}', '\uFF01'];
    expect([...keys].sort()).toEqual(['\u{1F600}', '\uFF01']); // UTF-16 code units: wrong for us
    expect(sortByCodePoint(keys)).toEqual(['\uFF01', '\u{1F600}']); // code points: Python's order
  });
});

describe('batchAudit: counts that do not add up are flagged, never corrected (B9-R4)', () => {
  // The kit's identity is received = written + unchanged + rejected + (duplicates ?? 0), where
  // `written` EXCLUDES unchanged rows. The #272 pilot counted differently (unchanged was part of
  // `updated`), so mapping its result straight across — written = inserted + updated — counts
  // every unchanged row twice in a write-once log. batchAudit cannot know which number is wrong,
  // so it stores what it was given and says so, once, with no key or count in the line.
  const keys = Array.from({ length: 10 }, (_, i) => `K-${i}`);

  it('warns once, content-free, when received is not the sum; the row keeps the counts as given', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // The pilot's { received: 10, inserted: 3, updated: 7, unchanged: 7 } mapped naively.
      const payload = await batchAudit({
        ...base,
        received: 10,
        written: 10,
        unchanged: 7,
        rejected: 0,
        duplicates: 0,
        keys,
      });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(loggedEvents(warn.mock.calls)).toEqual([
        { event: 'batch_audit_counts_mismatch', table: 'orders' },
      ]);
      expect(payload).toMatchObject({ received: 10, written: 10, unchanged: 7, rejected: 0 });

      // Short of the total is the same fault (a write that collapsed repeats but did not say so).
      warn.mockClear();
      await batchAudit({ ...base, received: 10, written: 3, unchanged: 5, keys });
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('is silent when the counts add up: plain, with duplicates, suppressed, and empty', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // The same pilot batch mapped correctly: written = inserted + updated - unchanged.
      await batchAudit({ ...base, received: 10, written: 3, unchanged: 7, keys });
      await batchAudit({ ...base, received: 10, written: 3, unchanged: 5, duplicates: 2, keys });
      await batchAudit({
        ...base,
        received: 10,
        rejected: 10,
        suppressed: true,
        keys,
        rejectedKeys: keys,
      });
      await batchAudit(base);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe('person keys: hash only, no key text anywhere in the row', () => {
  const people = ['D-2::ACC-9::approver', 'D-1::ACC-7::approver'];

  it('firstKey and lastKey are null; the hash still covers the full composite keys', async () => {
    const payload = await batchAudit({
      ...base,
      table: 'decision_people',
      received: 2,
      written: 2,
      keys: people,
      personKeys: true,
    });
    expect(payload.keys).toEqual({
      count: 2,
      keysSha256: await sha256Hex(JSON.stringify([...people].sort())),
      firstKey: null,
      lastKey: null,
    });
    expect(JSON.stringify(payload)).not.toContain('ACC-');
  });

  it('refused keys are not named either — the kit cannot tell whether they carry the person id', async () => {
    const payload = await batchAudit({
      ...base,
      received: 2,
      written: 1,
      rejected: 1,
      keys: people,
      rejectedKeys: [people[0] as string],
      personKeys: true,
    });
    expect(payload.rejected).toBe(1);
    expect(payload).not.toHaveProperty('rejectedKeys');
    expect(JSON.stringify(payload)).not.toContain('ACC-');
  });

  it('on a suppressed batch too', async () => {
    const payload = await batchAudit({
      ...base,
      received: 2,
      rejected: 2,
      suppressed: true,
      keys: people,
      rejectedKeys: people,
      personKeys: true,
    });
    expect(payload).toMatchObject({ suppressed: true, rejected: 2 });
    expect(JSON.stringify(payload)).not.toContain('ACC-');
  });
});

describe(`batchAudit: bounded at ${MACHINE_AUDIT_PAYLOAD_MAX_BYTES} bytes by construction`, () => {
  it('a clean 100-row batch of UUID-shaped keys is a few hundred bytes', async () => {
    const keys = Array.from(
      { length: 100 },
      (_, i) => `0f8e2d4c-5b6a-4f3e-9d2c-${i.toString(16).padStart(12, '0')}`,
    );
    const payload = await batchAudit({
      ...base,
      received: 100,
      written: 3,
      unchanged: 97,
      keys,
      runId: 'etl-2026-09-24T10:00:00Z',
    });
    expect(bytesOf(payload)).toBeLessThan(400);
  });

  it('adversarial keys never push it over the cap: samples go first, then the range; counts and hash stay', async () => {
    // Keys built from the character JSON escapes most expensively (a control character is six
    // bytes), all rejected.
    const evil = (i: number) => `${String(i).padStart(3, '0')}${'\u0001'.repeat(197)}`;
    const keys = Array.from({ length: 100 }, (_, i) => evil(i));
    const payload = await batchAudit({
      ...base,
      received: 100,
      rejected: 100,
      keys,
      rejectedKeys: keys,
    });
    expect(bytesOf(payload)).toBeLessThanOrEqual(MACHINE_AUDIT_PAYLOAD_MAX_BYTES);
    expect(payload).toMatchObject({ received: 100, rejected: 100 });
    expect(payload).not.toHaveProperty('rejectedKeys');
    expect(payload.keys).toMatchObject({ count: 100, firstKey: null, lastKey: null });
    expect(payload.keys.keysSha256).toBe(await sha256Hex(fingerprintText(sortByCodePoint(keys))));
  });

  it('refused-key samples are dropped from the END, and the range survives while it fits', async () => {
    const long = (i: number) => `${String(i).padStart(3, '0')}${'x'.repeat(120)}`;
    const keys = Array.from({ length: 20 }, (_, i) => long(i));
    const payload = await batchAudit({
      ...base,
      received: 20,
      rejected: 20,
      keys,
      rejectedKeys: keys,
    });
    expect(bytesOf(payload)).toBeLessThanOrEqual(MACHINE_AUDIT_PAYLOAD_MAX_BYTES);
    expect(payload.keys.firstKey).toBe(keys[0]);
    expect(payload.keys.lastKey).toBe(keys[19]);
    const kept = payload.rejectedKeys ?? [];
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.length).toBeLessThan(BATCH_AUDIT_MAX_REJECTED_KEYS);
    expect(kept).toEqual(keys.slice(0, kept.length));
  });

  it('when the key range ALONE is over the cap, the range goes and the samples that then fit stay', async () => {
    // One very long key at the end of the sorted list: the range by itself is over 1 KB, while
    // ten short refused keys fit once it is gone. They are what an operator investigates, so
    // giving them up first, and then the range anyway, would lose them for nothing.
    const rejected = Array.from({ length: 10 }, (_, i) => `K-${i}`);
    const keys = [...rejected, 'Z'.repeat(900)];
    const payload = await batchAudit({
      ...base,
      received: 11,
      written: 1,
      rejected: 10,
      keys,
      rejectedKeys: rejected,
    });
    expect(bytesOf({ ...payload, runId: 'r'.repeat(64) })).toBeLessThanOrEqual(
      MACHINE_AUDIT_PAYLOAD_MAX_BYTES,
    );
    expect(payload.keys).toMatchObject({ count: 11, firstKey: null, lastKey: null });
    expect(payload.rejectedKeys).toEqual(rejected);
  });

  it('fits with room for the longest run id, so the framework stamp can never push it over', async () => {
    const long = (i: number) => `${String(i).padStart(3, '0')}${'x'.repeat(120)}`;
    const keys = Array.from({ length: 20 }, (_, i) => long(i));
    // Built with NO run id; the framework then stamps a 64-character one.
    const payload = await batchAudit({
      ...base,
      received: 20,
      rejected: 20,
      keys,
      rejectedKeys: keys,
      runId: null,
    });
    expect(bytesOf({ ...payload, runId: 'r'.repeat(64) })).toBeLessThanOrEqual(
      MACHINE_AUDIT_PAYLOAD_MAX_BYTES,
    );
  });
});

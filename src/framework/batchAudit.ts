// batchAudit() — the counts-only audit payload for a machine batch (a `machine: true` route that
// writes many rows per request). Lifted from the insights pilot (CialDNB/insights#272, plan item
// A1.3), including its review fixes. A handler builds it and hands it to the framework's single
// declared row:
//
//   const payload = await batchAudit({ table: 'orders', received, written, unchanged, rejected,
//     keys, rejectedKeys, runId: ctx.syncRunId });
//   ctx.setAuditTarget(`${companyId}:${received}`, payload);
//
// WHAT THE ROW SAYS, AND WHAT IT GAVE UP. The row carries what the write did (counts), the
// `suppressed` flag when an erasure interlock refused the batch, the caller's sync run id, and a
// fingerprint of the keys — NOT the keys. A key list per row made insights' staging audit rows
// ~1.9 KB each (~22 MB/day of append-only audit_log). The fingerprint still identifies the batch:
// `keysSha256` can be recomputed from the caller's own run log to prove which batch a row was, and
// `firstKey`/`lastKey` are the ends of the SORTED list, so they bound it as a range (a key outside
// them was not in the batch). Up to BATCH_AUDIT_MAX_REJECTED_KEYS refused keys are named, because
// a refusal is what an operator investigates. What a row no longer says is every key it touched;
// the caller's run log, matched by fingerprint and `runId`, is that record (Decision D13).
//
// PERSON KEYS ARE HASHED, NEVER WRITTEN. When a key contains a person identifier (insights'
// decision-people key is `decision_id::account_id::role`), pass `personKeys: true`. audit_log is
// WORM, readable through GET /api/audit and copied into every backup, so a person id written here
// outlives any erasure of that person's data. The row then keeps the count and the hash — which is
// pseudonymous, not anonymous: it is derived from the ids — and writes NO key text: `firstKey` and
// `lastKey` are null and `rejectedKeys` is left out (the kit cannot tell whether a refused key
// carries the person id, so it names none).
//
// THE FINGERPRINT RECIPE, byte for byte — publish it to the caller (docs/API-CONVENTIONS.md):
//   1. Take the FULL key list the request carried, duplicates included.
//   2. Sort it by Unicode code point (Python's `sorted()`, and UTF-8 byte order) — NOT
//      JavaScript's default sort, which compares UTF-16 code units and disagrees once a character
//      above U+FFFF meets one in U+E000–U+FFFF. A lone surrogate sorts by its own value.
//   3. Serialize it as a compact JSON array (no spaces), escaping `"` `\` and U+0000–U+001F as
//      JSON does (`\b \t \n \f \r` short forms, the rest `\u00XX`), and EVERY character from U+007F
//      up as `\uXXXX` per UTF-16 code unit (a pair above U+FFFF), hex in lowercase. The text is
//      pure ASCII, so there is no encoding step for two sides to disagree on (TextEncoder turns a
//      lone surrogate into U+FFFD; Python's .encode() raises on one).
//   4. SHA-256 those ASCII bytes; lowercase hex.
// In Python that is exactly
//   hashlib.sha256(json.dumps(sorted(keys), separators=(",", ":")).encode()).hexdigest()
// because json.dumps escapes that way by default (ensure_ascii). For ASCII keys it is the SHA-256
// of `["k1","k2",...]`. JSON rather than a join because JSON is injective: ["a\nb","c"] and
// ["a","b\nc"] join with newlines to the same text.
//
// THE COUNTS — AND WHY THEY ARE NOT THE PILOT'S. Every received row is counted exactly once:
//   received = written + unchanged + rejected + (duplicates ?? 0)
// where `written` is rows the write INSERTED OR CHANGED, so it EXCLUDES `unchanged`. The #272
// pilot counted differently: received = inserted + updated + rejected + duplicates, with
// `unchanged` a PART of `updated`, and its rows carried no `table` or `runId`. Mapping a pilot
// write result across therefore takes a subtraction, not a rename:
//   written   = inserted + updated - unchanged   (unchanged = 0 when the write does not report it)
//   unchanged = unchanged
//   rejected  = rejected;  duplicates = duplicates
// `written = inserted + updated` counts every unchanged row twice in a write-once log. batchAudit
// cannot tell which number is wrong, so it stores the counts as given and logs one content-free
// `batch_audit_counts_mismatch` warning (a registered logEvent carrying the table name only) when
// they do not add up.
//
// BOUNDED. The payload fits MACHINE_AUDIT_PAYLOAD_MAX_BYTES by construction: over it, refused-key
// samples go first (from the end, so what survives is a prefix), then the key range — unless the
// range alone is over the cap, in which case the range goes and the samples that then fit stay
// (fitToCap). What is left at worst is numbers, a short table name, a 64-character hash and a
// ≤ 64-character run id. The framework's cap (./machine.ts) is only the backstop for payloads
// built some other way.
import { logEvent } from '../platform/logEvent';
import { isValidSyncRunId, MACHINE_AUDIT_PAYLOAD_MAX_BYTES, utf8Bytes } from './machine';

/** How many refused keys a batch audit row names at most. */
export const BATCH_AUDIT_MAX_REJECTED_KEYS = 10;

const TABLE_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/;

/** A bounded fingerprint of a batch's keys. See the recipe in the module header. */
export interface KeyFingerprint {
  /** How many keys the request carried, duplicates included. */
  count: number;
  /** SHA-256 (lowercase hex) of the code-point-sorted keys as an ASCII-escaped compact JSON array. */
  keysSha256: string;
  /** The smallest key in code-point order; null for an empty batch, person keys, or when the cap needed the room. */
  firstKey: string | null;
  /** The largest key in code-point order; null for an empty batch, person keys, or when the cap needed the room. */
  lastKey: string | null;
}

export interface BatchAuditInput {
  /** The table the batch wrote: a short literal identifier (1–64 of [A-Za-z0-9_.:-]). */
  table: string;
  /** Rows the request carried. */
  received: number;
  /** Rows the write inserted or changed — NOT unchanged ones. From a #272-style result: inserted + updated - unchanged. */
  written: number;
  /** Rows that matched and were left as they were (a skip-unchanged upsert). */
  unchanged: number;
  /** Rows the write refused. */
  rejected: number;
  /** In-batch repeats the write collapsed, when it reports them: received = written + unchanged + rejected + duplicates. */
  duplicates?: number;
  /** True when an erasure interlock (or similar) refused the whole batch. Kept on the row, always. */
  suppressed?: boolean;
  /** EVERY key the request carried, in any order, duplicates included. Only its fingerprint is stored. */
  keys: readonly string[];
  /** The keys the write refused, in the write's order; at most BATCH_AUDIT_MAX_REJECTED_KEYS are named. */
  rejectedKeys?: readonly string[];
  /** The request's validated sync run id — pass `ctx.syncRunId`. Anything that is not a valid id is stored as null. */
  runId: string | null;
  /** The keys carry a person identifier: store the count and hash only, no key text. See the header. */
  personKeys?: boolean;
}

// A type alias, not an interface: setAuditTarget takes Record<string, unknown>, and only an alias
// is assignable to that index signature.
export type BatchAuditPayload = {
  table: string;
  received: number;
  written: number;
  unchanged: number;
  rejected: number;
  duplicates?: number;
  /** Present ONLY when the batch was suppressed. */
  suppressed?: true;
  keys: KeyFingerprint;
  /** At most BATCH_AUDIT_MAX_REJECTED_KEYS, a prefix of the write's list; absent when none, when suppressed, or for person keys. */
  rejectedKeys?: string[];
  runId: string | null;
};

/** Lexicographic order over code point sequences. */
function compareCodePoints(a: readonly number[], b: readonly number[]): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return a.length - b.length;
}

/**
 * Sort by Unicode code point. A string's iterator yields code points, and a lone surrogate as
 * itself, so a lone surrogate sorts by its own value — as it does in Python.
 */
export function sortByCodePoint(keys: readonly string[]): string[] {
  return keys
    .map((key) => ({ key, points: Array.from(key, (ch) => ch.codePointAt(0) ?? 0) }))
    .sort((a, b) => compareCodePoints(a.points, b.points))
    .map((entry) => entry.key);
}

/**
 * The exact text keysSha256 is taken over, for keys ALREADY sorted by code point: Python's
 * `json.dumps(sorted_keys, separators=(",", ":"))`, byte for byte. JSON.stringify already escapes
 * what Python does below U+007F (quote, backslash, control characters, same short forms, lowercase
 * hex) and every lone surrogate. What it leaves raw is U+007F and above, which the replace escapes
 * per UTF-16 code unit (the regex has no `u` flag, so it matches code units). The result is ASCII.
 */
export function fingerprintText(sortedKeys: readonly string[]): string {
  return JSON.stringify(sortedKeys).replace(
    /[\u007f-\uffff]/g,
    (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** The fingerprint of a batch's keys (recipe in the module header). */
export async function keyFingerprint(
  keys: readonly string[],
  options: { personKeys?: boolean } = {},
): Promise<KeyFingerprint> {
  const sorted = sortByCodePoint(keys);
  const keyText = options.personKeys !== true;
  return {
    count: sorted.length,
    keysSha256: await sha256Hex(fingerprintText(sorted)),
    firstKey: keyText ? (sorted[0] ?? null) : null,
    lastKey: keyText ? (sorted[sorted.length - 1] ?? null) : null,
  };
}

/**
 * Build the counts-only audit payload for one machine batch. Throws only on a table name that is
 * not a short identifier — a literal in the calling code, so a test catches it.
 */
export async function batchAudit(input: BatchAuditInput): Promise<BatchAuditPayload> {
  if (!TABLE_PATTERN.test(input.table)) {
    throw new TypeError('batchAudit: table must be 1-64 characters of [A-Za-z0-9_.:-]');
  }
  // Stored as given either way — the handler's write is done and only it knows the true numbers —
  // but a row whose counts do not add up is said so, once, with no key or count in the line.
  const accounted = input.written + input.unchanged + input.rejected + (input.duplicates ?? 0);
  if (accounted !== input.received) {
    logEvent('batch_audit_counts_mismatch', { table: input.table });
  }
  const suppressed = input.suppressed === true;
  const personKeys = input.personKeys === true;
  const payload: BatchAuditPayload = {
    table: input.table,
    received: input.received,
    written: input.written,
    unchanged: input.unchanged,
    rejected: input.rejected,
    ...(typeof input.duplicates === 'number' ? { duplicates: input.duplicates } : {}),
    ...(suppressed ? { suppressed: true as const } : {}),
    keys: await keyFingerprint(input.keys, { personKeys }),
    runId: isValidSyncRunId(input.runId) ? input.runId : null,
  };
  // A suppressed batch refused every key, and the fingerprint already names them all; person keys
  // write no key text at all.
  const rejectedKeys = input.rejectedKeys ?? [];
  if (!suppressed && !personKeys && rejectedKeys.length > 0) {
    payload.rejectedKeys = rejectedKeys.slice(0, BATCH_AUDIT_MAX_REJECTED_KEYS);
  }
  return fitToCap(payload);
}

// Measured as if the run id were the longest one allowed, so the framework's stamp of the request's
// own run id (./machine.ts) can never push a payload this function fitted over the cap.
const LONGEST_RUN_ID = 'x'.repeat(64);

function cappedBytes(payload: BatchAuditPayload): number {
  return utf8Bytes(JSON.stringify({ ...payload, runId: LONGEST_RUN_ID }));
}

/**
 * Fit MACHINE_AUDIT_PAYLOAD_MAX_BYTES. The counts, the flag and the hash are what the row exists
 * for, so they always stay. Refused-key samples give way first (from the end) when that is enough
 * to keep the key range. When the range ALONE is over the cap — with no sample at all — the range
 * goes first instead, and the samples that then fit stay: dropping them all and then the range
 * anyway would lose them for nothing.
 */
function fitToCap(payload: BatchAuditPayload): BatchAuditPayload {
  if (cappedBytes(payload) <= MACHINE_AUDIT_PAYLOAD_MAX_BYTES) return payload;
  const samples = payload.rejectedKeys;
  delete payload.rejectedKeys;
  if (cappedBytes(payload) > MACHINE_AUDIT_PAYLOAD_MAX_BYTES) {
    payload.keys.firstKey = null;
    payload.keys.lastKey = null;
  }
  // Re-added last, so the stored key order is the one batchAudit built.
  if (samples) payload.rejectedKeys = samples;
  while (cappedBytes(payload) > MACHINE_AUDIT_PAYLOAD_MAX_BYTES && payload.rejectedKeys) {
    payload.rejectedKeys.pop();
    if (payload.rejectedKeys.length === 0) delete payload.rejectedKeys;
  }
  return payload;
}

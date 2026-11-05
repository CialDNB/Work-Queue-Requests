/* At-rest field sealing (Sensitive-Data Protection capability, opt-in).
 *
 * D1 has no per-row access control, so a *high-sensitivity, display-only* field
 * (a salary, a national id, a per-record secret) is sealed with AES-256-GCM
 * before it touches the database — the D1 console, an R2 backup, and a leaked
 * read-only DB credential see only ciphertext. The Worker is the sole decryptor,
 * and only AFTER the permission gate (the RBAC serializer owns that check; this
 * module is just the cipher).
 *
 * THE DECISION RULE — "payload, never predicate." Seal a field only if it is
 * high-sensitivity AND display-only behind a permission gate AND never used in a
 * WHERE / ORDER BY / GROUP BY / JOIN. A fresh random IV per value means the same
 * input seals to different ciphertext every time (no equality leakage across
 * rows) — which makes the column unqueryable/unsortable/unjoinable. That is the
 * constraint, not a bug: all aggregation happens in-Worker after open(). The
 * capability is OPT-IN and dormant by default; most columns must NOT be sealed.
 * See docs/sensitive-data-capability-PLAN.md and the runbook.
 *
 * Stored form: base64( iv(12 bytes) || ciphertext+tag ). Key from env.SEAL_KEY
 * (64 hex chars = 32 bytes), resolved via getSecret() so it works as a plain
 * Worker secret OR a Secrets Store binding. LOSE THE KEY → LOSE THE DATA: there
 * is no envelope/escrow scheme. Generate-and-vault-first (scripts/seal-key.mjs)
 * makes backing it up impossible to skip; rotation = decrypt-old/re-seal-new
 * (docs/runbooks/sensitive-data-key.md).
 */

import { type Env, getSecret } from '../env';

// Module-scoped key cache. In a Workers isolate this persists across requests;
// it holds ONLY the imported key (derived from env, never request data) and
// re-imports when the key rotates (hex mismatch), so it's safe global state.
let cachedKey: { hex: string; key: CryptoKey } | null = null;

const IV_BYTES = 12;
const KEY_HEX_RE = /^[0-9a-fA-F]{64}$/;

async function importKey(env: Env): Promise<CryptoKey> {
  const hex = await getSecret(env.SEAL_KEY);
  // A missing/malformed key is a deployment-wide config fault (the capability is
  // enabled but the secret isn't provisioned), distinct from a per-row data
  // fault — it throws OUTSIDE the per-value catch in every open* below.
  if (!hex || !KEY_HEX_RE.test(hex)) {
    throw new Error(
      'SEAL_KEY must be set to 64 hex chars (32 bytes); see the sensitive-data key runbook',
    );
  }
  if (cachedKey && cachedKey.hex === hex) return cachedKey.key;
  const raw = new Uint8Array(32);
  for (let i = 0; i < 32; i++) raw[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  const key = await crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ]);
  cachedKey = { hex, key };
  return key;
}

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function fromBase64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Encrypt UTF-8 bytes → packed base64(iv || ct+tag) with a fresh random IV. */
async function sealBytes(plaintext: string, env: Env): Promise<string> {
  const key = await importKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext)),
  );
  const packed = new Uint8Array(iv.length + ct.length);
  packed.set(iv, 0);
  packed.set(ct, iv.length);
  return toBase64(packed);
}

/** Decrypt a value produced by {@link sealBytes}. Caller wraps the integrity throw. */
async function openBytes(sealed: string, env: Env): Promise<string> {
  const key = await importKey(env);
  const packed = fromBase64(sealed);
  if (packed.length <= IV_BYTES) throw new Error('truncated');
  const iv = packed.slice(0, IV_BYTES);
  const ct = packed.slice(IV_BYTES);
  return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct));
}

/* ── number ──────────────────────────────────────────────────────────────── */

/** Seal a finite number for storage. null/undefined pass through as null — an
 *  absent value is not the same as an encrypted zero, and 0 IS a real value, so
 *  it is sealed. Throws on a non-finite input (a programming error, not data). */
export async function sealNumber(
  value: number | null | undefined,
  env: Env,
): Promise<string | null> {
  if (value === null || value === undefined) return null;
  if (!Number.isFinite(value)) throw new Error('sealNumber expects a finite number');
  return sealBytes(String(value), env);
}

/** Open a value sealed by {@link sealNumber}. Throws on a tampered/wrong-key/
 *  truncated ciphertext or a non-numeric plaintext — callers must NEVER silently
 *  substitute a wrong number for a sealed amount; the integrity failure surfaces
 *  instead of a plausible-but-wrong value. No decrypted bytes escape in the error. */
export async function openNumber(
  sealed: string | null | undefined,
  env: Env,
): Promise<number | null> {
  if (sealed === null || sealed === undefined) return null;
  // importKey() throws here for a config fault, deliberately OUTSIDE the catch.
  await importKey(env);
  try {
    const num = Number(await openBytes(sealed, env));
    if (!Number.isFinite(num)) throw new Error('non-numeric');
    return num;
  } catch {
    // Collapse every per-value failure — bad base64, truncation, GCM-tag tamper,
    // wrong key, non-numeric plaintext — into one clean throw. No internal detail
    // (which could include decrypted bytes) escapes.
    throw new Error('openNumber: sealed value failed to decrypt or validate');
  }
}

/* ── text ────────────────────────────────────────────────────────────────── */

/** Seal an arbitrary UTF-8 string (same key + packed form as {@link sealNumber}). */
export async function sealText(value: string | null | undefined, env: Env): Promise<string | null> {
  if (value === null || value === undefined) return null;
  return sealBytes(value, env);
}

/** Open a string sealed by {@link sealText}. Every per-value failure collapses
 *  into one clean throw — no decrypted bytes escape in the error. */
export async function openText(
  sealed: string | null | undefined,
  env: Env,
): Promise<string | null> {
  if (sealed === null || sealed === undefined) return null;
  await importKey(env); // config fault throws distinctly, outside the catch
  try {
    return await openBytes(sealed, env);
  } catch {
    throw new Error('openText: sealed value failed to decrypt');
  }
}

/* ── JSON ────────────────────────────────────────────────────────────────── */

/** Seal a JSON-serializable value (an object/array of sensitive figures) on top
 *  of {@link sealText}. null/undefined pass through as null. */
export async function sealJson<T>(value: T | null | undefined, env: Env): Promise<string | null> {
  if (value === null || value === undefined) return null;
  return sealText(JSON.stringify(value), env);
}

/** Open a value sealed by {@link sealJson}. Returns null for a null/absent blob;
 *  propagates the integrity throw from {@link openText} on tamper/wrong-key, and
 *  collapses a parse failure the same way its siblings do — no decrypted bytes
 *  escape in the error. */
export async function openJson<T>(sealed: string | null | undefined, env: Env): Promise<T | null> {
  const text = await openText(sealed, env);
  if (text === null) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    // MUST stay wrapped: a SyntaxError embeds the offending input verbatim, so an
    // authentic-but-non-JSON plaintext (a sealText column read back through the wrong
    // opener, or migrated data) would carry the decrypted value into every caller that
    // logs the error — defeating the whole module. Collapse it like openNumber/openText.
    throw new Error('openJson: sealed value failed to decrypt or validate');
  }
}

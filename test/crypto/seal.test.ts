import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
  openJson,
  openNumber,
  openText,
  sealJson,
  sealNumber,
  sealText,
} from '../../src/crypto/seal';

// The test SEAL_KEY (wrangler.test.jsonc) is a throwaway all-zeros 64-hex value; the suite
// only proves round-trips + safety properties, never key strength. `env` carries it.

describe('seal/open — number', () => {
  it('round-trips finite numbers, including 0 and negatives', async () => {
    for (const v of [0, 1, -1, 42, 123456.789, -987.654, Number.MAX_SAFE_INTEGER]) {
      const sealed = await sealNumber(v, env);
      expect(sealed).toBeTypeOf('string');
      expect(await openNumber(sealed, env)).toBe(v);
    }
  });

  it('passes null/undefined through as null (absent ≠ encrypted zero)', async () => {
    expect(await sealNumber(null, env)).toBeNull();
    expect(await sealNumber(undefined, env)).toBeNull();
    expect(await openNumber(null, env)).toBeNull();
    expect(await openNumber(undefined, env)).toBeNull();
  });

  it('rejects a non-finite number (programming error, not data)', async () => {
    await expect(sealNumber(Number.NaN, env)).rejects.toThrow(/finite/);
    await expect(sealNumber(Number.POSITIVE_INFINITY, env)).rejects.toThrow(/finite/);
  });
});

describe('seal/open — text', () => {
  it('round-trips arbitrary UTF-8 (empty, unicode, long)', async () => {
    const big = 'x'.repeat(10_000);
    for (const v of ['', 'hello', 'שלום', '😀🔐', 'a,b;c\nd', big]) {
      const sealed = await sealText(v, env);
      expect(sealed).toBeTypeOf('string');
      expect(await openText(sealed, env)).toBe(v);
    }
  });

  it('passes null/undefined through as null', async () => {
    expect(await sealText(null, env)).toBeNull();
    expect(await sealText(undefined, env)).toBeNull();
    expect(await openText(null, env)).toBeNull();
    expect(await openText(undefined, env)).toBeNull();
  });
});

describe('seal/open — JSON', () => {
  it('round-trips objects and arrays', async () => {
    const recipe = { hireUnitCost: 12345, envelopes: [1, 2, 3], note: 'שכר' };
    const sealed = await sealJson(recipe, env);
    expect(await openJson(sealed, env)).toEqual(recipe);

    const arr = [{ a: 1 }, { b: 2 }];
    expect(await openJson(await sealJson(arr, env), env)).toEqual(arr);
  });

  it('passes null/undefined through as null', async () => {
    expect(await sealJson(null, env)).toBeNull();
    expect(await sealJson(undefined, env)).toBeNull();
    expect(await openJson(null, env)).toBeNull();
    expect(await openJson(undefined, env)).toBeNull();
  });
});

describe('safety properties', () => {
  it('produces a different ciphertext every call (fresh random IV — no equality leakage)', async () => {
    const a = await sealNumber(50000, env);
    const b = await sealNumber(50000, env);
    expect(a).not.toBe(b); // same plaintext, different sealed bytes
    expect(await openNumber(a, env)).toBe(50000);
    expect(await openNumber(b, env)).toBe(50000);

    // Same for text.
    const t1 = await sealText('secret', env);
    const t2 = await sealText('secret', env);
    expect(t1).not.toBe(t2);
  });

  it('stores in the packed base64(iv || ct+tag) form (decodes, longer than the IV)', async () => {
    const sealed = (await sealText('hi', env)) as string;
    const bytes = Uint8Array.from(atob(sealed), (c) => c.charCodeAt(0));
    // 12-byte IV + ciphertext + 16-byte GCM tag for a 2-byte plaintext → well past 12.
    expect(bytes.length).toBeGreaterThan(12 + 16);
  });

  it('throws (never substitutes) on a tampered ciphertext — GCM auth tag fails', async () => {
    const sealed = (await sealNumber(99999, env)) as string;
    const bytes = Uint8Array.from(atob(sealed), (c) => c.charCodeAt(0));
    const last = bytes.length - 1;
    bytes[last] = (bytes[last] ?? 0) ^ 0xff; // flip a tag bit
    const tampered = btoa(String.fromCharCode(...bytes));
    await expect(openNumber(tampered, env)).rejects.toThrow(/failed to decrypt or validate/);
  });

  it('throws on a truncated ciphertext (shorter than the IV)', async () => {
    await expect(openText('AAAA', env)).rejects.toThrow(/failed to decrypt/);
    await expect(openNumber('AAAA', env)).rejects.toThrow(/failed to decrypt or validate/);
  });

  it('throws on garbage / non-base64 input', async () => {
    await expect(openText('@@@not base64@@@', env)).rejects.toThrow(/failed to decrypt/);
  });

  it('throws when a value sealed under a DIFFERENT key is opened (wrong-key integrity)', async () => {
    // Seal under the test key, then open under a different key by swapping env.SEAL_KEY.
    const sealed = (await sealText('salary:123', env)) as string;
    const otherEnv = {
      ...env,
      SEAL_KEY: 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
    };
    await expect(openText(sealed, otherEnv)).rejects.toThrow(/failed to decrypt/);
    // And the original key still opens it (the module key-cache re-imported on mismatch,
    // then re-imports back — proves the rotation-aware cache doesn't corrupt either key).
    expect(await openText(sealed, env)).toBe('salary:123');
  });

  it('leaks no plaintext in the error message', async () => {
    const secret = 'TOP-SECRET-SALARY-987654';
    const sealed = (await sealText(secret, env)) as string;
    const bytes = Uint8Array.from(atob(sealed), (c) => c.charCodeAt(0));
    const last = bytes.length - 1;
    bytes[last] = (bytes[last] ?? 0) ^ 0x01;
    const tampered = btoa(String.fromCharCode(...bytes));
    try {
      await openText(tampered, env);
      throw new Error('expected a throw');
    } catch (err) {
      expect(String(err)).not.toContain(secret);
      expect(String(err)).not.toContain('SALARY');
    }
  });

  // The tamper case above only covers open*'s decrypt failure. openJson has a SECOND way to
  // throw that the cipher never sees: an AUTHENTIC ciphertext whose plaintext isn't JSON (a
  // sealText column read back through the wrong opener, or migrated data). GCM passes, then
  // JSON.parse throws — and V8 embeds the offending input verbatim in the SyntaxError, so an
  // unwrapped parse puts the decrypted salary into every caller that logs the error
  // (defineRoute's route_error console.error ships it straight to Workers observability).
  it('openJson leaks no plaintext when an AUTHENTIC value fails to parse', async () => {
    const secret = 'TOP-SECRET-SALARY-987654';
    // Authentic: sealed with the real key, never tampered with. Only the shape is wrong.
    const sealed = (await sealText(secret, env)) as string;
    try {
      await openJson(sealed, env);
      throw new Error('expected a throw');
    } catch (err) {
      expect(String(err)).not.toContain(secret);
      expect(String(err)).not.toContain('SALARY');
      expect(String(err)).toMatch(/failed to decrypt or validate/);
    }
  });
});

describe('key configuration faults (deployment-wide, not per-row)', () => {
  it('throws distinctly when SEAL_KEY is absent (capability enabled but unprovisioned)', async () => {
    const noKey = { ...env, SEAL_KEY: undefined } as typeof env;
    await expect(sealNumber(1, noKey)).rejects.toThrow(/SEAL_KEY must be set/);
    // The config fault is OUTSIDE the per-value catch on open*, so it surfaces as the config
    // error (not the generic per-value integrity message).
    await expect(openNumber('whatever', noKey)).rejects.toThrow(/SEAL_KEY must be set/);
    await expect(openText('whatever', noKey)).rejects.toThrow(/SEAL_KEY must be set/);
  });

  it('throws on a malformed key (wrong length / non-hex)', async () => {
    await expect(sealText('x', { ...env, SEAL_KEY: 'tooshort' })).rejects.toThrow(/64 hex chars/);
    await expect(
      sealText('x', { ...env, SEAL_KEY: 'z'.repeat(64) }), // 64 chars but not hex
    ).rejects.toThrow(/64 hex chars/);
  });
});

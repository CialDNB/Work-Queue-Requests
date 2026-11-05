import { describe, expect, it } from 'vitest';
import { isAllowedDomain, TRUSTED_DOMAINS } from '../../src/auth/magicLink';
import type { Env } from '../../src/env';

// Pure-function tests for the per-app domain policy (A3, DECISIONS 2026-06-13).
const envWith = (v?: string) => ({ ALLOWED_EMAIL_DOMAINS: v }) as unknown as Env;

describe('isAllowedDomain — per-app domain policy', () => {
  it('empty / unset / whitespace = open (invite-only is the real gate)', () => {
    expect(isAllowedDomain(envWith(undefined), 'anyone@anywhere.com')).toBe(true);
    expect(isAllowedDomain(envWith(''), 'anyone@anywhere.com')).toBe(true);
    expect(isAllowedDomain(envWith('   '), 'someone@external.io')).toBe(true);
  });

  it('an explicit list allows only the listed domains', () => {
    const e = envWith('cialdnb.com, example.org');
    expect(isAllowedDomain(e, 'a@cialdnb.com')).toBe(true);
    expect(isAllowedDomain(e, 'a@example.org')).toBe(true);
    expect(isAllowedDomain(e, 'a@evil.com')).toBe(false);
  });

  it('"trusted" expands to the canonical internal set', () => {
    const e = envWith('trusted');
    for (const d of TRUSTED_DOMAINS) {
      expect(isAllowedDomain(e, `user@${d}`)).toBe(true);
    }
    expect(isAllowedDomain(e, 'user@not-in-set.com')).toBe(false);
  });

  it('"trusted" composes with extra explicit domains', () => {
    const e = envWith('trusted, partnerco.com');
    expect(isAllowedDomain(e, 'u@cialdnb.com')).toBe(true); // from the trusted set
    expect(isAllowedDomain(e, 'u@partnerco.com')).toBe(true); // explicit extra
    expect(isAllowedDomain(e, 'u@nope.com')).toBe(false);
  });

  it('is case-insensitive on both the policy and the address domain', () => {
    expect(isAllowedDomain(envWith('CIALDNB.com'), 'a@cialdnb.COM')).toBe(true);
    expect(isAllowedDomain(envWith('Trusted'), 'a@TrustedPartners.com')).toBe(true);
  });

  it('rejects malformed addresses when a gate is set', () => {
    expect(isAllowedDomain(envWith('trusted'), 'no-at-sign')).toBe(false);
  });

  it('rejects multi-@ addresses that would smuggle a trusted suffix', () => {
    // lastIndexOf-style extraction would read "cialdnb.com" and wrongly pass.
    expect(isAllowedDomain(envWith('trusted'), 'a@evil.com@cialdnb.com')).toBe(false);
    expect(isAllowedDomain(envWith('cialdnb.com'), 'a@x@cialdnb.com')).toBe(false);
  });

  it('does not match subdomains implicitly', () => {
    expect(isAllowedDomain(envWith('cialdnb.com'), 'a@sub.cialdnb.com')).toBe(false);
  });
});

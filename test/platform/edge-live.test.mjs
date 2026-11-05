// Pins the verify:edge:live logic — scripts/edge-rules.mjs (rule definitions + drift verifiers,
// shared by provision + the check) and scripts/check-edge-live.mjs (pure evaluation + config
// derivation). Run by `node --test` (these import node:fs / node:url), so it's a *.test.mjs
// outside the vitest Workers-pool glob, like edge-hardening.test.mjs.
//
// The live script's I/O (Cloudflare API + HTTP) never runs in CI — no token, no network — so the
// value is here: every DRIFT branch (identity AND effectiveness) is exercised with fixtures, and
// create/verify share one source of rule identity so they can't diverge.
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { evaluate, readTargetConfig, run } from '../../scripts/check-edge-live.mjs';
import { resolveDeploymentTarget } from '../../scripts/deployment-target.mjs';
import {
  AUTH_RL_MARKER,
  authRateLimitRule,
  findByMarker,
  HOST_PIN_MARKER,
  hostPinRule,
  MANAGED_WAF_RULESET_IDS,
  PHASES,
  readPhaseRules,
  upsertRuleByMarker,
  verifyAuthRateLimit,
  verifyHostPin,
  verifyManagedWaf,
  verifySecurityHeaders,
  verifyTurnstile,
  verifyWorkersDevDisabled,
} from '../../scripts/edge-rules.mjs';
import { parseJsonc } from '../../scripts/new-app.mjs';

const DOMAIN = 'staging-test-app.cialdnb.ai';
// Read a repo wrangler config, for pinning tests against the repo's OWN identity and posture —
// never the template's. Every fork runs this file after a /kit-upgrade, so a hardcoded template
// name or kit-default posture here reds CI in every fork that diverges (kit PR #170).
const config = (file) =>
  parseJsonc(readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8'));
// A valid managed-WAF execute rule: enabled, referencing a recognised Cloudflare managed ruleset.
const managedExecute = {
  action: 'execute',
  enabled: true,
  action_parameters: { id: MANAGED_WAF_RULESET_IDS[0] },
};
// Realistic, EFFECTIVE security-header values.
const HEADERS = {
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
  'x-frame-options': 'DENY',
  'x-content-type-options': 'nosniff',
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
};
const headerGetFrom = (h) => (name) => h[name] ?? null;

describe('PHASES — the Cloudflare phase-name strings (a wrong one perma-reds the daily check)', () => {
  it('pins the exact phase entrypoints', () => {
    assert.equal(PHASES.custom, 'http_request_firewall_custom');
    assert.equal(PHASES.ratelimit, 'http_ratelimit');
    assert.equal(PHASES.managed, 'http_request_firewall_managed'); // NOT 'http_request_managed'
  });
});

describe('verifyWorkersDevDisabled', () => {
  it('flags an enabled subdomain or enabled previews, passes when both off', () => {
    assert.match(verifyWorkersDevDisabled({ enabled: true }), /ENABLED/);
    assert.match(verifyWorkersDevDisabled({ enabled: false, previews_enabled: true }), /preview/);
    assert.equal(verifyWorkersDevDisabled({ enabled: false, previews_enabled: false }), null);
  });
  it('treats a result with no boolean `enabled` as UNVERIFIABLE (a finding), never a silent pass', () => {
    assert.match(verifyWorkersDevDisabled({}), /could not verify/);
    assert.match(verifyWorkersDevDisabled(null), /could not verify/);
    assert.match(verifyWorkersDevDisabled({ enabled: 'false' }), /could not verify/);
  });
});

describe('verifyHostPin — identity AND effectiveness', () => {
  const good = [hostPinRule(DOMAIN)];
  it('is advisory when absent (shared zone) but required when asked', () => {
    assert.equal(verifyHostPin([], DOMAIN), null);
    assert.match(verifyHostPin([], DOMAIN, true), /MISSING/);
  });
  it('passes a correct, enabled, blocking, negating rule pinned to the domain', () => {
    assert.equal(verifyHostPin(good, DOMAIN), null);
  });
  it('flags disabled / wrong-action / wrong-domain', () => {
    assert.match(verifyHostPin([{ ...good[0], enabled: false }], DOMAIN), /DISABLED/);
    assert.match(verifyHostPin([{ ...good[0], action: 'log' }], DOMAIN), /action/);
    assert.match(verifyHostPin(good, 'other.cialdnb.ai'), /no longer pins/);
  });
  it('flags a non-string or INVERTED expression (block-when-host-EQUALS is a neutered pin)', () => {
    assert.match(verifyHostPin([{ ...good[0], expression: 42 }], DOMAIN), /non-string/);
    // action:block but `http.host eq "<domain>"` blocks the RIGHT host — includes(domain) alone
    // passes it; the negation-tied-to-http.host check catches the inversion.
    assert.match(
      verifyHostPin([{ ...good[0], expression: `(http.host eq "${DOMAIN}")` }], DOMAIN),
      /inverted/,
    );
    // The negation must be tied to http.host: a domain with a word-bounded `ne` (app-NE-1) must
    // NOT let an inverted eq slip through on a stray `ne` match.
    const neDomain = 'app-ne-1.cialdnb.ai';
    assert.match(
      verifyHostPin(
        [{ ...hostPinRule(neDomain), expression: `(http.host eq "${neDomain}")` }],
        neDomain,
      ),
      /inverted/,
    );
    // ...and the correct `http.host ne` form for that same domain still passes.
    assert.equal(verifyHostPin([hostPinRule(neDomain)], neDomain), null);
  });
});

describe('verifyAuthRateLimit — identity AND effectiveness', () => {
  it('passes the kit rule; flags missing / disabled', () => {
    assert.equal(verifyAuthRateLimit([authRateLimitRule()]), null);
    assert.match(verifyAuthRateLimit([]), /MISSING/);
    assert.match(verifyAuthRateLimit([{ ...authRateLimitRule(), enabled: false }]), /DISABLED/);
  });
  it('flags a neutered rule — non-enforcing action, wrong path, or a giant threshold', () => {
    assert.match(verifyAuthRateLimit([{ ...authRateLimitRule(), action: 'log' }]), /not enforcing/);
    assert.match(
      verifyAuthRateLimit([{ ...authRateLimitRule(), expression: '(http.host eq "x")' }]),
      /no longer targets \/auth/,
    );
    assert.match(
      verifyAuthRateLimit([
        { ...authRateLimitRule(), ratelimit: { period: 60, requests_per_period: 1_000_000 } },
      ]),
      /too loose/,
    );
    assert.match(
      verifyAuthRateLimit([{ ...authRateLimitRule(), ratelimit: {} }]),
      /no valid ratelimit threshold/,
    );
  });
});

describe('verifyManagedWaf — a recognised managed ruleset, actually executing', () => {
  it('passes an enabled execute of a known Cloudflare managed ruleset', () => {
    assert.equal(verifyManagedWaf([managedExecute]), null);
  });
  it('absence is ADVISORY by default (may be account-scoped), a HARD finding only when required', () => {
    // A zone-phase read that shows nothing may just mean the managed WAF is deployed at ACCOUNT
    // scope — so don't hard-red every armed fork; only `required` (confirmed zone-level) flags it.
    assert.equal(verifyManagedWaf([]), null);
    assert.equal(verifyManagedWaf([{ ...managedExecute, enabled: false }]), null);
    assert.match(
      verifyManagedWaf([], true),
      /no managed WAF ruleset is deployed in the zone phase/,
    );
  });
  it('flags a present-but-NEUTERED ruleset regardless of `required`', () => {
    // A non-recognised execute IS present → someone swapped the managed ruleset for a custom one.
    assert.match(
      verifyManagedWaf([{ action: 'execute', enabled: true, action_parameters: { id: 'custom' } }]),
      /none deploy a recognised/,
    );
    const override = (o) => [
      { ...managedExecute, action_parameters: { id: MANAGED_WAF_RULESET_IDS[0], overrides: o } },
    ];
    assert.match(verifyManagedWaf(override({ enabled: false })), /DISABLED via an override/);
    assert.match(verifyManagedWaf(override({ action: 'log' })), /non-enforcing action/);
  });
});

describe('verifySecurityHeaders — VALUE checks, not just presence', () => {
  it('passes effective values', () => {
    assert.deepEqual(verifySecurityHeaders(headerGetFrom(HEADERS)), []);
  });
  it('flags a missing header', () => {
    const { 'content-security-policy': _drop, ...rest } = HEADERS;
    const f = verifySecurityHeaders(headerGetFrom(rest));
    assert.equal(f.length, 1);
    assert.match(f[0], /content-security-policy.*missing/);
  });
  it('flags WEAKENED values a presence-only check would pass', () => {
    const weak = (over) => verifySecurityHeaders(headerGetFrom({ ...HEADERS, ...over }))[0];
    assert.match(weak({ 'strict-transport-security': 'max-age=0' }), /HSTS max-age/); // CLAUDE.md-forbidden
    assert.match(weak({ 'x-frame-options': 'ALLOWALL' }), /X-Frame-Options/);
    assert.match(weak({ 'x-content-type-options': 'sniff' }), /X-Content-Type-Options/);
    assert.match(weak({ 'content-security-policy': 'default-src *' }), /permissive default-src/);
    // Removing default-src entirely drops the fallback restriction (weakens the kit's 'none').
    assert.match(weak({ 'content-security-policy': "script-src 'self'" }), /no default-src/);
  });
});

describe('verifyTurnstile', () => {
  it('flags only a mismatch between config and the live /auth/config', () => {
    assert.equal(verifyTurnstile(true, { turnstile_site_key: '0xABC' }), null);
    assert.equal(verifyTurnstile(false, { turnstile_site_key: '' }), null);
    assert.match(verifyTurnstile(true, { turnstile_site_key: '' }), /bot challenge is off/);
    assert.match(verifyTurnstile(false, { turnstile_site_key: '0xABC' }), /config drift/);
  });
});

describe('upsertRuleByMarker + findByMarker', () => {
  it('replaces our rule by marker (never duplicates) and preserves others', () => {
    const operatorRule = { description: 'operator: allow office', action: 'skip' };
    const first = upsertRuleByMarker([operatorRule], authRateLimitRule(), AUTH_RL_MARKER);
    assert.equal(first.length, 2);
    assert.ok(first.includes(operatorRule));
    const second = upsertRuleByMarker(first, authRateLimitRule(), AUTH_RL_MARKER);
    assert.equal(second.length, 2);
    assert.equal(second.filter((r) => r.description?.startsWith(AUTH_RL_MARKER)).length, 1);
    assert.ok(findByMarker(second, AUTH_RL_MARKER));
    assert.ok(findByMarker(second, HOST_PIN_MARKER) === undefined);
  });
});

describe('readPhaseRules — reader (code-based not-found) vs writer (strict)', () => {
  it('reader: success → rules; a 10404 OR "could not be found" → empty; any OTHER error → {error}', () => {
    assert.deepEqual(readPhaseRules({ success: true, result: { rules: [{ id: 'x' }] } }), {
      rules: [{ id: 'x' }],
    });
    assert.deepEqual(readPhaseRules({ success: true, result: {} }), { rules: [] });
    assert.deepEqual(readPhaseRules({ success: false, errors: [{ code: 10404 }] }), { rules: [] });
    // Belt-and-suspenders: the precise "could not be found" wording also reads as an empty phase
    // (in case the code ever differs) — but NOT a broad "not found" an authz error might carry.
    assert.deepEqual(
      readPhaseRules({ success: false, errors: [{ message: 'ruleset could not be found' }] }),
      { rules: [] },
    );
    // A 7003 "could not route" authz error must NOT read as empty (no 10404, no "could not be found").
    assert.ok(
      readPhaseRules({ success: false, errors: [{ code: 7003, message: 'could not route' }] })
        .error,
    );
    assert.ok(
      readPhaseRules({ success: false, errors: [{ code: 1000, message: 'not found here' }] }).error,
    );
    assert.ok(readPhaseRules({ success: false }).error !== undefined);
  });
  it('reader: 10003 "could not find entrypoint ruleset" is an EMPTY phase, not an unreadable one', () => {
    // What the entrypoint GET returns on a zone whose http_ratelimit phase never held a rule
    // (db-talents staging bring-up, 2026-10-10). It used to read as "could not read the
    // rate-limit phase" — a token-scope-looking finding for what is really "rule MISSING".
    const noEntrypoint = {
      success: false,
      errors: [
        { code: 10003, message: 'could not find entrypoint ruleset in the http_ratelimit phase' },
      ],
    };
    assert.deepEqual(readPhaseRules(noEntrypoint), { rules: [] });
    // Each signal stands alone (code-first, wording as backstop) …
    assert.deepEqual(readPhaseRules({ success: false, errors: [{ code: 10003 }] }), { rules: [] });
    assert.deepEqual(
      readPhaseRules({
        success: false,
        errors: [{ message: 'could not find entrypoint ruleset in the http_ratelimit phase' }],
      }),
      { rules: [] },
    );
    // … and the authz codes stay errors (unverifiable), whatever they say.
    assert.ok(
      readPhaseRules({ success: false, errors: [{ code: 10000, message: 'Authentication error' }] })
        .error,
    );
    // Every error must be a not-found signal: an authz error alongside it means unreadable …
    assert.ok(readPhaseRules({ success: false, errors: [{ code: 10000 }, { code: 10003 }] }).error);
    // … and a 10003 that is about something other than the entrypoint stays an error.
    assert.ok(
      readPhaseRules({ success: false, errors: [{ code: 10003, message: 'invalid zone' }] }).error,
    );
    // An empty rate-limit phase is then a MISSING /auth rule — a real finding, never a pass.
    assert.match(verifyAuthRateLimit(readPhaseRules(noEntrypoint).rules), /MISSING/);
  });
  it('writer (strict): NEVER empty on any failure — even a 10404 — so a PUT cannot wipe the shared phase', () => {
    assert.deepEqual(readPhaseRules({ success: true, result: { rules: [] } }, { strict: true }), {
      rules: [],
    });
    assert.ok(
      readPhaseRules({ success: false, errors: [{ code: 10404 }] }, { strict: true }).error,
    );
    assert.ok(readPhaseRules({ success: false, errors: [{ code: 7003 }] }, { strict: true }).error);
  });
  it('writer (strict): a missing entrypoint is still an error — flagged noEntrypoint for diagnosis only', () => {
    // DECISIONS 2026-07-13: the writer never creates the first rule on a phase. The flag only lets
    // provision name the real remedy instead of blaming the token (issue #182).
    for (const code of [10003, 10404]) {
      const got = readPhaseRules({ success: false, errors: [{ code }] }, { strict: true });
      assert.ok(got.error, `${code} stays an error for the writer`);
      assert.equal(got.rules, undefined, `${code} never yields rules to PUT over`);
      assert.equal(got.noEntrypoint, true, `${code} is diagnosed as no-entrypoint`);
    }
    for (const code of [10000, 7003]) {
      const got = readPhaseRules({ success: false, errors: [{ code }] }, { strict: true });
      assert.equal(got.noEntrypoint, undefined, `${code} is NOT a missing entrypoint`);
    }
    // Mixed with an authz error, the token remedy must win — never hidden behind "no entrypoint".
    const mixed = readPhaseRules(
      { success: false, errors: [{ code: 10000 }, { code: 10003 }] },
      { strict: true },
    );
    assert.equal(mixed.noEntrypoint, undefined);
  });
});

describe('readTargetConfig (real repo wrangler configs)', () => {
  // Pins the MAPPING (name -> scriptName, vars.DASHBOARD_HOST -> customDomain) against the
  // repo's own configs via the module-scope `config` helper — never against a fixed identity.
  it('takes the custom domain from the config, and the worker script name from name', () => {
    const stagingCfg = config('wrangler.staging.jsonc');
    const staging = readTargetConfig('staging');
    assert.equal(staging.scriptName, stagingCfg.name);
    assert.equal(staging.customDomain, stagingCfg.vars.DASHBOARD_HOST);
    assert.equal(typeof staging.siteKeyConfigured, 'boolean');

    const prodCfg = config('wrangler.jsonc');
    const prod = readTargetConfig('production');
    assert.equal(prod.scriptName, prodCfg.name);
    assert.equal(prod.customDomain, prodCfg.vars.DASHBOARD_HOST);

    // …and that both actually resolved to something (a mapping bug that returned undefined on
    // both sides would otherwise satisfy the equalities above). A DB Israel app's production
    // config names no host by design: central grants it at go-live, and edge-live's check skips
    // such an app (scripts/new-app.mjs --target dbisrael).
    assert.ok(staging.scriptName?.length > 0 && staging.customDomain?.length > 0);
    assert.ok(prod.scriptName?.length > 0);
    const root = join(import.meta.dirname, '..', '..');
    const target = resolveDeploymentTarget({ root, env: {} }).target;
    if (target === 'dbisrael') assert.equal(prod.customDomain, '');
    else assert.ok(prod.customDomain?.length > 0);
  });
});

describe('evaluate — composes findings, skips ungathered fields', () => {
  it('returns [] when everything present is correct', () => {
    const findings = evaluate({
      customDomain: DOMAIN,
      subdomain: { enabled: false },
      customRules: [hostPinRule(DOMAIN)],
      rateLimitRules: [authRateLimitRule()],
      managedRules: [managedExecute],
      headerGet: headerGetFrom(HEADERS),
      authConfig: { turnstile_site_key: '' },
      siteKeyConfigured: false,
    });
    assert.deepEqual(findings, []);
  });
  it('collects a finding per drifted control and skips undefined inputs', () => {
    const findings = evaluate({
      customDomain: DOMAIN,
      subdomain: { enabled: true }, // drift
      rateLimitRules: [], // drift (missing)
    });
    assert.equal(findings.length, 2);
    assert.ok(findings.some((f) => /workers\.dev/.test(f)));
    assert.ok(findings.some((f) => /rate-limit/.test(f)));
  });
  it('honours requireHostPin', () => {
    const base = { customDomain: DOMAIN, customRules: [] };
    assert.deepEqual(evaluate(base), []); // advisory: absent host-pin is fine
    assert.equal(evaluate({ ...base, requireHostPin: true }).length, 1);
  });
});

describe('run — HTTP guards + skip visibility (injected fetch, no CF token)', () => {
  // The /auth/config fixture echoes the repo's OWN Turnstile posture. run('staging') reads the
  // real wrangler.staging.jsonc for siteKeyConfigured, so a fixture hardcoding the kit default
  // ('' = Turnstile off) makes verifyTurnstile report drift — failing the []-findings asserts —
  // in any fork that enables Turnstile. Same fork-coupling class kit PR #170 removed from
  // readTargetConfig; on a Turnstile-off checkout this echo is byte-identical to the old ''.
  const SITE_KEY = config('wrangler.staging.jsonc').vars?.TURNSTILE_SITE_KEY ?? '';
  const healthy = async (url) =>
    url.endsWith('/_health')
      ? new Response('', { status: 200, headers: HEADERS })
      : new Response(JSON.stringify({ data: { turnstile_site_key: SITE_KEY } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });

  it('reports the CF-API checks as SKIPPED (not silently passed) when unarmed', async () => {
    const { findings, checked, skipped } = await run('staging', { fetchImpl: healthy });
    assert.deepEqual(findings, []);
    assert.deepEqual(checked, ['headers', 'turnstile']);
    // workers.dev + WAF/rate-limit didn't run — visibly skipped, not counted as a pass.
    assert.equal(skipped.length, 2);
    assert.ok(skipped.some((s) => /workers\.dev/.test(s)));
    assert.ok(skipped.some((s) => /WAF/.test(s)));
  });

  it('flags a non-2xx /auth/config instead of feeding an error body to the Turnstile check', async () => {
    const fetchImpl = async (url) =>
      url.endsWith('/_health')
        ? new Response('', { status: 200, headers: HEADERS })
        : new Response('bad gateway', { status: 502 });
    const { findings } = await run('staging', { fetchImpl });
    assert.ok(findings.some((f) => /could not verify Turnstile.*502/.test(f)));
    assert.ok(!findings.some((f) => /security header/.test(f)));
    assert.ok(!findings.some((f) => /config drift/.test(f)));
  });

  // The workers.dev check is ungated to a TOKEN alone (no zone id). Inject cfFetch to cover the
  // armed path — the one that runs in the daily Action (not the HTTP-only deploy gate).
  it('ARMS workers.dev with a token alone (zone rulesets still skipped)', async () => {
    const cfFetch = async () =>
      new Response(
        JSON.stringify({ success: true, result: { enabled: false, previews_enabled: false } }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      );
    const { findings, checked, skipped } = await run('staging', {
      token: 't_x',
      fetchImpl: healthy,
      cfFetch,
    });
    assert.deepEqual(findings, []);
    assert.ok(checked.includes('workers.dev')); // armed with just a token
    assert.equal(skipped.length, 1); // only the zone rulesets (no CLOUDFLARE_ZONE_ID)
    assert.ok(skipped.some((s) => /WAF/.test(s)));
  });

  it('a rate-limit phase with no entrypoint (10003) reports the /auth rule MISSING, not unreadable', async () => {
    // A zone whose http_ratelimit phase never held a rule (db-talents staging bring-up,
    // 2026-10-10). The finding used to be "could not read the rate-limit phase" — which reads
    // as a token-scope problem (issue #182) when the token is fine and the rule is just absent.
    const json = (status, body) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    const cfFetch = async (url) => {
      if (url.includes('/subdomain'))
        return json(200, { success: true, result: { enabled: false, previews_enabled: false } });
      if (url.includes('/http_ratelimit/'))
        return json(404, {
          success: false,
          errors: [
            {
              code: 10003,
              message: 'could not find entrypoint ruleset in the http_ratelimit phase',
            },
          ],
        });
      return json(200, { success: true, result: { rules: [] } });
    };
    const { findings, checked } = await run('staging', {
      token: 't_x',
      zoneId: 'zone-fixture',
      fetchImpl: healthy,
      cfFetch,
    });
    assert.ok(checked.includes('auth-rate-limit'), 'the phase counts as read');
    assert.ok(
      !findings.some((f) => /could not read the rate-limit phase/.test(f)),
      findings.join('\n'),
    );
    assert.ok(
      findings.some((f) => /rate-limit rule .*MISSING/.test(f)),
      findings.join('\n'),
    );
  });

  it('FLAGS (never silently passes) when the armed workers.dev GET fails', async () => {
    const cfFetch = async () =>
      new Response(
        JSON.stringify({ success: false, errors: [{ code: 9109, message: 'unauthorized' }] }),
        {
          status: 403,
        },
      );
    const { findings } = await run('staging', { token: 't_x', fetchImpl: healthy, cfFetch });
    assert.ok(findings.some((f) => /could not read the worker subdomain/.test(f)));
  });
});

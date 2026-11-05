// The two per-fork edge rules the kit OWNS, defined ONCE so `scripts/provision.mjs` creates
// them and `scripts/check-edge-live.mjs` verifies them with the same expressions + markers —
// no drift between "what we created" and "what we check for". See docs/SECURITY-EDGE.md.
//
// Both rules live in Cloudflare rulesets (the "phases" model): custom WAF rules in the
// http_request_firewall_custom phase, rate-limit rules in http_ratelimit. Each rule carries a
// stable `description` MARKER so we can find OUR rule by identity across re-runs (never by
// index or by matching the whole expression, which an operator might reword in the dashboard).
//
// Plain Node module (imported by two Node scripts); no worker/runtime imports.

/** Ruleset phase entrypoints we read/write. (These exact strings are the Cloudflare phase names —
 *  a wrong one GETs a non-existent phase and perma-reds the daily check, so test/platform pins them.) */
export const PHASES = {
  custom: 'http_request_firewall_custom',
  ratelimit: 'http_ratelimit',
  managed: 'http_request_firewall_managed',
};

// Stable identity markers — the description PREFIX by which we recognise our own rule. Keep
// these constant forever: changing one orphans the old rule (a duplicate on the next provision)
// and makes the verifier miss it (a false "missing" drift alert).
export const HOST_PIN_MARKER = 'kit:host-pin';
export const AUTH_RL_MARKER = 'kit:auth-rate-limit';

/**
 * Host-pin custom rule: BLOCK any request whose Host header isn't the app's own custom domain.
 * The custom domain is the only sanctioned ingress (workers.dev is off), so a request arriving
 * with any other Host is either a Host-confusion probe or a direct-to-worker attempt — block it.
 */
export function hostPinRule(customDomain) {
  return {
    action: 'block',
    expression: `(http.host ne "${customDomain}")`,
    description: `${HOST_PIN_MARKER} ${customDomain}`,
    enabled: true,
  };
}

/**
 * `/auth/*` rate-limit rule: Managed Challenge once an IP exceeds 10 requests/min to any
 * `/auth/` path. This is the PRE-worker throttle the in-app KV limiter can't be (the worker has
 * already run by the time that fires). Keyed on client IP; counted per Cloudflare data center
 * (the API's default characteristic set) — generous enough for a whole office behind one NAT,
 * tight enough to blunt credential-spray / magic-link-bombing.
 */
export function authRateLimitRule() {
  return {
    action: 'managed_challenge',
    expression: '(starts_with(http.request.uri.path, "/auth/"))',
    description: AUTH_RL_MARKER,
    enabled: true,
    ratelimit: {
      characteristics: ['ip.src', 'cf.colo.id'],
      period: 60,
      requests_per_period: 10,
      mitigation_timeout: 60,
    },
  };
}

/** Find our rule in a phase's rule list by its description marker (identity, not index). */
export function findByMarker(rules, marker) {
  return (rules ?? []).find(
    (r) => typeof r.description === 'string' && r.description.startsWith(marker),
  );
}

/**
 * Idempotent upsert: return a NEW rules array with `rule` replacing any existing rule that
 * carries `marker`, else appended. Preserves every other rule on the phase (an operator's own
 * rules are never dropped) and never duplicates ours across re-runs. Used by provision's PUT.
 */
export function upsertRuleByMarker(existingRules, rule, marker) {
  const rest = (existingRules ?? []).filter(
    (r) => !(typeof r.description === 'string' && r.description.startsWith(marker)),
  );
  return [...rest, rule];
}

/** Cloudflare error code for a ruleset/entrypoint that genuinely doesn't exist yet. */
export const RULESET_NOT_FOUND_CODE = 10404;

/**
 * What the phase-entrypoint GET actually returns for a phase that has never held a rule:
 * `10003 could not find entrypoint ruleset in the <phase> phase` — e.g. a zone with no
 * `http_ratelimit` entrypoint (CialDNB/db-talents staging bring-up, 2026-10-10). Authz failures
 * carry other codes (10000 "Authentication error", 7003 "could not route"), never this one.
 */
export const ENTRYPOINT_NOT_FOUND_CODE = 10003;

// "This phase has no entrypoint" — by code first, with the two precise wordings as a backstop in
// case a code differs. Never a broad "not found": an authz error can carry that wording. EVERY
// error must say so: a response that also carries an authz error is unreadable, not empty. And a
// 10003 whose message is about something other than the entrypoint stays an error.
const PHASE_NOT_FOUND_WORDING = /could not be found|could not find entrypoint/i;
function isNotFoundError(e) {
  const code = Number(e?.code);
  const message = typeof e?.message === 'string' ? e.message : '';
  if (code === RULESET_NOT_FOUND_CODE) return true;
  if (code === ENTRYPOINT_NOT_FOUND_CODE) return message === '' || /entrypoint/i.test(message);
  return PHASE_NOT_FOUND_WORDING.test(message);
}
function isPhaseNotFound(errors) {
  return errors.length > 0 && errors.every(isNotFoundError);
}

/**
 * Classify a GET on a ruleset phase entrypoint into `{ rules }` or `{ error }`. Shared by the
 * VERIFIER (check-edge-live) and the WRITER (provision), but they demand different rigour because
 * a PUT after a GET REPLACES the phase's whole rule list on the SHARED cialdnb.ai zone:
 *
 *   • WRITER (`strict: true`): NEVER treat a failed GET as an empty phase. Cloudflare returns a
 *     not-found-WORDED error (e.g. code 7003 "could not route") for a resource a token can't reach,
 *     so classifying that as empty and PUTting "just our rule" would WIPE every sibling app's +
 *     operator's rules zone-wide. Any error → `{ error }`; only a real `success:true` creates.
 *   • READER (default): a genuine "entrypoint not found" means the phase has no rules → `{ rules: [] }`
 *     (→ the verifier reports the rule MISSING, which is correct). Detected primarily by the SPECIFIC
 *     codes 10404 and 10003 (the one a never-used phase returns), with the narrow "could not be
 *     found" / "could not find entrypoint" wordings as a belt-and-suspenders (in case a code
 *     differs), NOT a broad "not found" that an authz error could carry. Anything else stays
 *     `{ error }` (unverifiable, a fail-safe finding), never silently "empty". The reader can afford
 *     this leniency because it never PUTs.
 *   • The WRITER still gets `{ error }` for a missing entrypoint — it never creates the first rule
 *     on a phase (DECISIONS 2026-07-13) — but with `noEntrypoint: true`, so provision can name the
 *     real remedy (add the first rule by hand) instead of blaming the token's scopes (issue #182).
 */
export function readPhaseRules(getJson, { strict = false } = {}) {
  if (getJson?.success) {
    return { rules: Array.isArray(getJson.result?.rules) ? getJson.result.rules : [] };
  }
  const errors = Array.isArray(getJson?.errors) ? getJson.errors : [];
  const errText = JSON.stringify(errors);
  const notFound = isPhaseNotFound(errors);
  if (strict) {
    // Write path: any failure is a hard failure, never empty. The flag is diagnosis only.
    return notFound ? { error: errText, noEntrypoint: true } : { error: errText };
  }
  return notFound ? { rules: [] } : { error: errText };
}

// --- Pure verifiers (drift detection) -------------------------------------------------------
// Each takes already-fetched API/HTTP data and returns a finding STRING on drift, or null when
// the control is present and correct. Kept I/O-free so check-edge-live's tests exercise every
// drift branch with fixtures (CI has no Cloudflare API access).

/**
 * workers.dev + preview URLs must be OFF. The per-script GET .../subdomain response carries BOTH
 * `enabled` (workers.dev) and `previews_enabled` (preview URLs) — verified against the Cloudflare
 * API docs — so we check both; a live preview URL is the same off-zone bypass as workers.dev.
 * A response WITHOUT a boolean `enabled` (null/empty/unexpected shape) is treated as UNVERIFIABLE
 * (a finding), never silently as "disabled" — a security check must fail toward alerting, not
 * toward a false pass.
 */
export function verifyWorkersDevDisabled(subdomainResult) {
  if (typeof subdomainResult?.enabled !== 'boolean') {
    return 'could not verify the workers.dev subdomain toggle — the API returned no boolean `enabled` (unexpected response shape)';
  }
  if (subdomainResult.enabled)
    return 'workers.dev subdomain is ENABLED — the worker is reachable off-zone (bypasses WAF/rate-limit)';
  if (subdomainResult.previews_enabled === true)
    return 'worker preview URLs are ENABLED — an off-zone ingress that bypasses WAF/rate-limit';
  return null;
}

/**
 * Host-pin custom rule verify. ADVISORY by default: on the SHARED cialdnb.ai zone (many apps)
 * a host-pin blocking "host ne <one domain>" would break sibling apps, so the kit does not
 * create or require one there — absence is not drift. But if a host-pin rule EXISTS (a dedicated
 * zone, per the account-isolation roadmap), verify it stayed enabled/correct: a host-pin someone
 * turned off IS drift. Pass `required` (a dedicated-zone app) to also flag its absence.
 */
export function verifyHostPin(customRules, customDomain, required = false) {
  const rule = findByMarker(customRules, HOST_PIN_MARKER);
  if (!rule)
    return required
      ? `Host-pin WAF rule (${HOST_PIN_MARKER}) is MISSING from the custom-rules phase`
      : null;
  if (rule.enabled === false) return 'Host-pin WAF rule is present but DISABLED';
  if (rule.action !== 'block')
    return `Host-pin WAF rule action is "${rule.action}", expected "block"`;
  // EFFECTIVENESS, not just identity: the rule must BLOCK every host that is NOT this domain. A
  // non-string expression can't be verified; and a naive `includes(domain)` would pass an INVERTED
  // rule (`http.host eq "<domain>"` blocks the RIGHT host), so require the negation form too.
  if (typeof rule.expression !== 'string')
    return `Host-pin WAF rule has a non-string expression (${typeof rule.expression}) — cannot verify it blocks off-host traffic`;
  if (!rule.expression.includes(customDomain))
    return `Host-pin WAF rule no longer pins "${customDomain}" (expression: ${rule.expression})`;
  // The negation must be applied TO http.host (`http.host ne …` / `http.host != …` / `not (http.host
  // …)`), not merely a stray `ne`/`not` anywhere — a domain like `app-ne-1.cialdnb.ai` has a
  // word-bounded `ne`, so a plain /\bne\b/ would pass an INVERTED `http.host eq "<domain>"`.
  const negatesHost =
    /http\.host\s+ne\b/i.test(rule.expression) ||
    /http\.host\s*!=/.test(rule.expression) ||
    /\bnot\b\s*\(?\s*http\.host/i.test(rule.expression);
  if (!negatesHost)
    return `Host-pin WAF rule expression isn't a "block when http.host ≠ domain" negation and may be inverted (expression: ${rule.expression})`;
  return null;
}

// A rate-limit action that actually throttles (log/skip do not). And a ceiling, normalised to
// requests/min, above which the "limit" no longer limits (the `threshold: 1000000` no-op case).
export const RL_ENFORCING_ACTIONS = ['managed_challenge', 'challenge', 'js_challenge', 'block'];
export const AUTH_RL_MAX_PER_MIN = 60;

/** `/auth/*` rate-limit rule present, enabled, AND effective (enforcing action, targets /auth, throttles). */
export function verifyAuthRateLimit(rateLimitRules) {
  const rule = findByMarker(rateLimitRules, AUTH_RL_MARKER);
  if (!rule)
    return `/auth rate-limit rule (${AUTH_RL_MARKER}) is MISSING from the rate-limit phase`;
  if (rule.enabled === false) return '/auth rate-limit rule is present but DISABLED';
  // EFFECTIVENESS: a rule reworded to action:log, pointed away from /auth, or set to a giant
  // threshold is a no-op an attacker sails through — identity (the marker) alone can't catch that.
  if (!RL_ENFORCING_ACTIONS.includes(rule.action))
    return `/auth rate-limit rule action is "${rule.action}" — not enforcing (expected one of ${RL_ENFORCING_ACTIONS.join('/')})`;
  if (typeof rule.expression !== 'string' || !rule.expression.includes('/auth'))
    return `/auth rate-limit rule no longer targets /auth paths (expression: ${rule.expression})`;
  const rpp = Number(rule.ratelimit?.requests_per_period);
  const period = Number(rule.ratelimit?.period);
  if (!Number.isFinite(rpp) || rpp <= 0 || !Number.isFinite(period) || period <= 0)
    return '/auth rate-limit rule has no valid ratelimit threshold (requests_per_period / period)';
  if ((rpp / period) * 60 > AUTH_RL_MAX_PER_MIN)
    return `/auth rate-limit threshold is too loose to throttle (${rpp} per ${period}s ≈ ${Math.round((rpp / period) * 60)}/min, expected ≤ ${AUTH_RL_MAX_PER_MIN}/min)`;
  return null;
}

// The Cloudflare-managed ruleset ids the managed-WAF phase should execute. An `execute` rule
// against one of THESE is real coverage; an execute rule against something else (or a bare
// enabled:false execute, or a ruleset fully disabled via override) is not — the "empty managed
// ruleset passes" gap. (Stable Cloudflare account-level ruleset ids.)
export const MANAGED_WAF_RULESET_IDS = [
  'efb7b8c949ac4650a09736fc376e9aee', // Cloudflare Managed Ruleset
  '4814384a9e5d4991b9815dcfc25d2f1f', // Cloudflare OWASP Core Ruleset
];

// Overrides that neuter a deployed managed ruleset without removing it: the whole ruleset turned
// off, or switched to a monitor-only action (log/skip mitigates nothing).
const MANAGED_WAF_NONENFORCING_ACTIONS = ['log', 'skip'];

/**
 * A managed WAF ruleset must be EFFECTIVE in the managed phase. Zone-wide + platform-owned, so we
 * don't create it. ABSENCE is ADVISORY by default (`required` off): the managed WAF is very often
 * deployed at the ACCOUNT scope, which a ZONE-phase entrypoint GET does NOT list — so "none found
 * in the zone phase" is NOT necessarily drift and must not hard-red every armed fork. But a
 * recognised ruleset that IS present in the zone phase and has been NEUTERED (disabled, or flipped
 * to log/skip) is real drift and always flagged. Pass `required` on a zone you KNOW deploys managed
 * WAF at the zone level to also flag absence. (Confirm your topology before arming `required`.)
 */
export function verifyManagedWaf(managedRules, required = false) {
  const executes = (managedRules ?? []).filter(
    (r) => r.action === 'execute' && r.enabled !== false,
  );
  const known = executes.find((r) => MANAGED_WAF_RULESET_IDS.includes(r.action_parameters?.id));
  if (!known) {
    // Present-but-not-recognised is worth flagging even when absence is advisory: someone replaced
    // the managed ruleset with a custom execute.
    if (executes.length > 0)
      return 'the managed WAF phase has execute rule(s) but none deploy a recognised Cloudflare managed ruleset (Managed Ruleset / OWASP CRS)';
    return required
      ? 'no managed WAF ruleset is deployed in the zone phase (expected the Cloudflare Managed Ruleset / OWASP CRS)'
      : null; // advisory: may be deployed at account scope, invisible to a zone-phase read
  }
  const overrides = known.action_parameters?.overrides;
  if (overrides?.enabled === false)
    return 'the managed WAF ruleset is deployed but entirely DISABLED via an override';
  if (
    typeof overrides?.action === 'string' &&
    MANAGED_WAF_NONENFORCING_ACTIONS.includes(overrides.action)
  )
    return `the managed WAF ruleset is deployed but overridden to a non-enforcing action ("${overrides.action}") — it mitigates nothing`;
  return null;
}

/** Security response headers the app sets (src/index.ts) must survive to the client. */
export const REQUIRED_HEADERS = [
  'strict-transport-security',
  'x-frame-options',
  'x-content-type-options',
  'content-security-policy',
];

// HSTS floor (6 months — the preload minimum). `max-age=0` (the classic silent weakening a
// presence-only check misses) and any trivially-short value fall below it.
export const HSTS_MIN_MAX_AGE = 15_552_000;

/**
 * `headerGet(name)` → header value or null. Verifies the security headers are present AND carry an
 * EFFECTIVE value — a presence-only check passes `HSTS: max-age=0`, `X-Frame-Options: ALLOWALL`, or
 * a wildcard CSP, exactly the "weaken the headers" case CLAUDE.md forbids. One finding per problem.
 */
export function verifySecurityHeaders(headerGet) {
  const findings = [];
  const hsts = headerGet('strict-transport-security');
  const xfo = headerGet('x-frame-options');
  const xcto = headerGet('x-content-type-options');
  const csp = headerGet('content-security-policy');

  if (!hsts) findings.push('security header "strict-transport-security" is missing');
  else {
    const m = /max-age\s*=\s*(\d+)/i.exec(hsts);
    const maxAge = m ? Number(m[1]) : 0;
    if (maxAge < HSTS_MIN_MAX_AGE)
      findings.push(
        `HSTS max-age is ${m ? maxAge : 'absent'} (< ${HSTS_MIN_MAX_AGE}) — HSTS is effectively disabled`,
      );
  }

  if (!xfo) findings.push('security header "x-frame-options" is missing');
  else if (!/^(deny|sameorigin)$/i.test(xfo.trim()))
    findings.push(
      `X-Frame-Options is "${xfo}" — not clickjacking-safe (expected DENY or SAMEORIGIN)`,
    );

  if (!xcto) findings.push('security header "x-content-type-options" is missing');
  else if (xcto.trim().toLowerCase() !== 'nosniff')
    findings.push(`X-Content-Type-Options is "${xcto}" — expected "nosniff"`);

  // CSP effectiveness is deep to validate in full; we catch the clear weakenings of the kit's
  // strict `default-src 'none'` — a wildcard/unsafe default-src, or default-src removed entirely
  // (no default-src = no fallback restriction). A permissive NON-default directive (e.g. an opened
  // script-src) is out of scope here — noted in docs/SECURITY-EDGE.md.
  if (!csp) findings.push('security header "content-security-policy" is missing');
  else if (!/default-src/i.test(csp))
    findings.push(
      `Content-Security-Policy has no default-src ("${csp}") — the fallback restriction is gone`,
    );
  else if (/default-src[^;]*\*/i.test(csp) || /default-src\s+['"]?unsafe-/i.test(csp))
    findings.push(
      `Content-Security-Policy has a permissive default-src ("${csp}") — a wildcard/unsafe default-src defeats the CSP`,
    );
  return findings;
}

/**
 * Turnstile enabled-state must match config: if the deploy configured a site key, the live
 * `/auth/config` must advertise it (else the login page silently stopped challenging bots);
 * if it did NOT, the live config must not advertise one either.
 */
export function verifyTurnstile(siteKeyConfigured, authConfig) {
  const live =
    typeof authConfig?.turnstile_site_key === 'string' && authConfig.turnstile_site_key.length > 0;
  if (siteKeyConfigured && !live)
    return 'Turnstile is configured but the live /auth/config advertises NO site key — bot challenge is off';
  if (!siteKeyConfigured && live)
    return 'Turnstile is NOT configured but the live /auth/config advertises a site key — config drift';
  return null;
}

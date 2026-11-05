// verify:edge:live — the LIVE, post-deploy / continuous counterpart to verify:edge.
//
// verify:edge (check-edge-hardening.mjs) checks the repo CONFIG. This checks the deployed
// ZONE + WORKER, so a control toggled off in the Cloudflare dashboard the day after go-live
// gets caught instead of sitting silent (the gap GO-LIVE gate 11 and the assessment named):
//
//   • workers.dev / preview subdomain is OFF          (CF API — account worker subdomain)
//   • Host-pin WAF custom rule present + enabled       (CF API — custom-rules phase)
//   • /auth/* rate-limit rule present + enabled        (CF API — rate-limit phase)
//   • a managed WAF ruleset is deployed                (CF API — managed phase)
//   • the app's security headers survive to the client (HTTP — GET /_health)
//   • Turnstile enabled-state matches config           (HTTP — GET /auth/config vs the var)
//
// The rule identities come from scripts/edge-rules.mjs — the SAME definitions provision.mjs
// creates, so create + verify never drift. Runs in plain Node (like verify:edge / provision):
// wired into CI post-deploy (deploy-staging job, after smoke-health) and a daily scheduled
// GitHub Action. Reads CLOUDFLARE_API_TOKEN (a scoped, ideally read-only zone token — never
// the worker holds it) + CLOUDFLARE_ZONE_ID from the environment; the CF-API checks self-skip
// with a clear note when either is absent, so the HTTP checks still run anywhere.
//
// See docs/SECURITY-EDGE.md and DECISIONS 2026-07-03 (why the CF-API check runs in CI/Action,
// not the worker).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PHASES,
  readPhaseRules,
  verifyAuthRateLimit,
  verifyHostPin,
  verifyManagedWaf,
  verifySecurityHeaders,
  verifyTurnstile,
  verifyWorkersDevDisabled,
} from './edge-rules.mjs';
import { isMainModule } from './kit-checks/main-module.mjs';
import { parseJsonc } from './new-app.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const API = 'https://api.cloudflare.com/client/v4';

/**
 * Read the deploy config for a target env → the facts the checks need. The custom domain comes
 * STRAIGHT from the config (`vars.DASHBOARD_HOST`, == the `routes[].pattern`), never reconstructed:
 * the staging WORKER is named `<app>-staging` but its domain is `staging-<app>.cialdnb.ai`, so a
 * `<name>`-based guess would be wrong.
 */
export function readTargetConfig(targetEnv, root = ROOT) {
  const file = targetEnv === 'production' ? 'wrangler.jsonc' : 'wrangler.staging.jsonc';
  const cfg = parseJsonc(readFileSync(join(root, file), 'utf8'));
  return {
    scriptName: cfg.name, // Worker script name — for the /workers/scripts/{name}/subdomain API.
    accountId: cfg.account_id,
    customDomain: cfg.vars?.DASHBOARD_HOST,
    // Turnstile is "configured" when the deploy set a non-empty site-key var.
    siteKeyConfigured:
      typeof cfg.vars?.TURNSTILE_SITE_KEY === 'string' && cfg.vars.TURNSTILE_SITE_KEY.length > 0,
  };
}

/**
 * PURE drift evaluation over already-fetched data — every branch is unit-tested with fixtures
 * (CI has no Cloudflare API access). A field being `undefined` means "not gathered" and is
 * skipped; `run()` turns an intended-but-failed fetch into an explicit finding instead.
 */
export function evaluate(data) {
  const findings = [];
  const add = (f) => {
    if (f) findings.push(f);
  };
  if (data.subdomain !== undefined) add(verifyWorkersDevDisabled(data.subdomain));
  if (data.customRules !== undefined)
    add(verifyHostPin(data.customRules, data.customDomain, data.requireHostPin === true));
  if (data.rateLimitRules !== undefined) add(verifyAuthRateLimit(data.rateLimitRules));
  if (data.managedRules !== undefined)
    add(verifyManagedWaf(data.managedRules, data.requireManagedWaf === true));
  if (data.headerGet !== undefined) findings.push(...verifySecurityHeaders(data.headerGet));
  if (data.authConfig !== undefined) add(verifyTurnstile(data.siteKeyConfigured, data.authConfig));
  return findings;
}

const CF_TIMEOUT_MS = 10_000;

/** GET the Cloudflare API with the SAME retry + timeout the HTTP half has, and NEVER throw — a
 *  transient blip or a half-open socket must not become an unhandled rejection (false-red daily
 *  page) or hang the job to GitHub's kill timeout. Exhausted retries return a synthetic error
 *  envelope so every caller's `success`-check handles it uniformly. */
export async function cfGet(token, path, { attempts = 3, fetchImpl = fetch } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetchImpl(`${API}${path}`, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(CF_TIMEOUT_MS),
      });
      return res.json().catch(() => ({ success: false, errors: [{ message: 'bad json' }] }));
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 500 * (i + 1)));
    }
  }
  return {
    success: false,
    errors: [
      { message: `cf-api fetch failed after ${attempts} attempts: ${lastErr?.message ?? lastErr}` },
    ],
  };
}

/** Rules array from a zone ruleset phase entrypoint, or null on a real failure (caller flags it).
 *  Uses the SAME readPhaseRules classifier provision's writer uses, so reader + writer agree on
 *  "empty phase" vs "GET failed". */
async function phaseRules(token, zoneId, phase, cfFetch) {
  const got = readPhaseRules(
    await cfGet(token, `/zones/${zoneId}/rulesets/phases/${phase}/entrypoint`, {
      fetchImpl: cfFetch,
    }),
  );
  return got.error !== undefined ? null : got.rules;
}

/** Fetch with a few retries on a THROWN error (transient network/DNS/TLS blip) — a post-deploy
 *  monitor must not red a deploy on a hiccup. A returned Response (even a bad one) is passed
 *  through untouched, so real drift IN the response (missing header, wrong config) is never
 *  retried away — only connection-level flakes are. */
async function fetchRetry(fetchImpl, url, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fetchImpl(url);
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 500 * (i + 1)));
    }
  }
  throw lastErr;
}

/** Gather live data (CF API + HTTP) and evaluate. Returns { findings, checked, skipped, target }:
 *  `checked` = the checks that actually ran, `skipped` = the ones unarmed (no token/zone). */
export async function run(
  targetEnv,
  {
    token,
    zoneId,
    requireHostPin = false,
    requireManagedWaf = false,
    fetchImpl = fetch,
    cfFetch = fetch,
    root = ROOT,
  } = {},
) {
  const cfg = readTargetConfig(targetEnv, root);
  const base = `https://${cfg.customDomain}`;
  const data = {
    customDomain: cfg.customDomain,
    siteKeyConfigured: cfg.siteKeyConfigured,
    requireHostPin,
    requireManagedWaf,
  };
  const findings = [];
  const checked = [];
  const skipped = [];

  // --- workers.dev/preview subdomain: needs only a TOKEN (+ accountId from config), NOT the zone
  //     id — it's the highest-value CF-API check, so it arms whenever a token is present. ---
  if (token && cfg.accountId) {
    const sub = await cfGet(
      token,
      `/accounts/${cfg.accountId}/workers/scripts/${cfg.scriptName}/subdomain`,
      { fetchImpl: cfFetch },
    );
    if (sub.success) {
      data.subdomain = sub.result ?? {};
      checked.push('workers.dev');
    } else {
      findings.push(
        `could not read the worker subdomain toggle to verify workers.dev is off (${JSON.stringify(sub.errors ?? [])})`,
      );
    }
  } else {
    skipped.push('workers.dev/preview (set CLOUDFLARE_API_TOKEN)');
  }

  // --- Zone ruleset checks (Host-pin / /auth rate-limit / managed WAF): need the zone id too. ---
  if (token && zoneId) {
    const custom = await phaseRules(token, zoneId, PHASES.custom, cfFetch);
    if (custom === null)
      findings.push('could not read the custom-rules phase to verify the Host-pin rule');
    else {
      data.customRules = custom;
      checked.push('host-pin');
    }

    const rl = await phaseRules(token, zoneId, PHASES.ratelimit, cfFetch);
    if (rl === null) findings.push('could not read the rate-limit phase to verify the /auth rule');
    else {
      data.rateLimitRules = rl;
      checked.push('auth-rate-limit');
    }

    const managed = await phaseRules(token, zoneId, PHASES.managed, cfFetch);
    if (managed === null)
      findings.push('could not read the managed phase to verify the WAF ruleset');
    else {
      data.managedRules = managed;
      checked.push('managed-waf');
    }
  } else {
    skipped.push('WAF/rate-limit rules (set CLOUDFLARE_API_TOKEN + CLOUDFLARE_ZONE_ID)');
  }

  // --- HTTP checks (no credentials; retried so a transient blip isn't false drift) ---
  if (!cfg.customDomain) {
    // No vars.DASHBOARD_HOST in the config → we don't know the app's custom domain, so name that
    // as the problem rather than fetching `https://undefined/_health` and reporting an opaque error.
    findings.push(
      'could not run the HTTP checks: this deploy config has no vars.DASHBOARD_HOST (the app custom domain)',
    );
  } else {
    try {
      const health = await fetchRetry(fetchImpl, `${base}/_health`);
      data.headerGet = (name) => health.headers.get(name);
      checked.push('headers');
    } catch (err) {
      findings.push(
        `could not GET ${base}/_health to verify security headers (${err?.message ?? err})`,
      );
    }
    try {
      const cfgRes = await fetchRetry(fetchImpl, `${base}/auth/config`);
      // Only parse a 2xx body — a non-2xx (an error envelope / edge error page) must not be fed to
      // verifyTurnstile as if it were the live config (spurious "config drift").
      if (!cfgRes.ok) {
        findings.push(
          `could not verify Turnstile: GET ${base}/auth/config returned HTTP ${cfgRes.status}`,
        );
      } else {
        const body = await cfgRes.json().catch(() => null);
        data.authConfig = body?.data ?? body ?? null;
        checked.push('turnstile');
      }
    } catch (err) {
      findings.push(
        `could not GET ${base}/auth/config to verify Turnstile (${err?.message ?? err})`,
      );
    }
  }

  findings.push(...evaluate(data));
  return { findings, checked, skipped, target: cfg.customDomain };
}

async function main() {
  const args = process.argv.slice(2);
  const targetEnv = args.includes('--env') ? args[args.indexOf('--env') + 1] : 'staging';
  if (!['staging', 'production'].includes(targetEnv)) {
    console.error(`usage: check-edge-live.mjs --env staging|production (got "${targetEnv}")`);
    process.exit(2);
  }
  const token = process.env.CLOUDFLARE_API_TOKEN;
  const zoneId = process.env.CLOUDFLARE_ZONE_ID;
  // Dedicated-zone apps (account-isolation) set this to also require the Host-pin rule's presence.
  const requireHostPin = process.env.EDGE_REQUIRE_HOST_PIN === '1';
  // Set only on a zone you've CONFIRMED deploys managed WAF at the ZONE level — else absence is
  // advisory (managed WAF is often ACCOUNT-scoped, invisible to a zone-phase read).
  const requireManagedWaf = process.env.EDGE_REQUIRE_MANAGED_WAF === '1';
  // An armed fork can set this to fail CI when any check couldn't run (coverage regression), rather
  // than passing green on a partial run.
  const requireComplete = process.env.EDGE_REQUIRE_COMPLETE === '1';
  const { findings, checked, skipped, target } = await run(targetEnv, {
    token,
    zoneId,
    requireHostPin,
    requireManagedWaf,
  });

  if (findings.length) {
    console.error(`\nverify:edge:live FAILED for ${target} — edge controls drifted:\n`);
    for (const f of findings) console.error(`  ✗ ${f}`);
    console.error(
      '\nAn edge control is off or unverifiable. Re-apply it (scripts/provision.mjs --env <env> re-creates the kit rules) or investigate the dashboard. See docs/SECURITY-EDGE.md.',
    );
    process.exit(1);
  }
  // Incomplete is VISIBLY distinct from a clean pass — a green exit on an unarmed run must not read
  // as "all edge controls verified". Default (unarmed) exits 0 with the banner; EDGE_REQUIRE_COMPLETE
  // makes an incomplete run a hard failure for forks that armed the CF-API half.
  if (skipped.length) {
    console.warn(
      `\n⚠ verify:edge:live INCOMPLETE for ${target} — ran [${checked.join(', ') || 'none'}], SKIPPED [${skipped.join('; ')}].`,
    );
    console.warn(
      '  The skipped checks (workers.dev / WAF / rate-limit) need CLOUDFLARE_API_TOKEN (+ CLOUDFLARE_ZONE_ID for the zone rules). See docs/SECURITY-EDGE.md.',
    );
    process.exit(requireComplete ? 1 : 0);
  }
  console.log(`✓ verify:edge:live passed for ${target} — all checks ran: [${checked.join(', ')}].`);
}

if (isMainModule(import.meta.url)) {
  // A top-level .catch so an unexpected throw can't become an unhandled rejection (silent + a bad
  // exit code); every expected failure already exits explicitly above.
  main().catch((err) => {
    console.error(`verify:edge:live crashed: ${err?.stack ?? err}`);
    process.exit(1);
  });
}

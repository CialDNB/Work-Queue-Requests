// Daily edge-drift probe — the credential-free half of verify:edge:live. The authoritative rule
// inventory (Host-pin / /auth rate-limit / managed WAF, plus header + Turnstile checks) runs in
// CI post-deploy and a daily scheduled GitHub Action against the live domain; the worker
// deliberately holds NO Cloudflare API token (DECISIONS 2026-07-03). This cron is the one
// between-deploy regression the worker can catch on its own, with plain fetch and no credentials:
//
//   workers.dev must stay DEAD. If a fork tells us its workers.dev hostname (WORKERS_DEV_HOST),
//   we probe it: a 2xx that is THIS app means the off-zone ingress is live again — it bypasses
//   the zone WAF + rate-limiting, the whole reason workers.dev is disabled.
//
// DORMANT unless WORKERS_DEV_HOST is set (like report_to_registry): the scheduled Action covers
// the workers.dev toggle authoritatively via the CF API regardless, so a fork opts into the
// continuous worker-side watch by naming its hostname. DRIFT PAGES: a definitive hit throws, so
// the ops loop routes it to sendAlert like any failed task (a live security control silently off
// is an emergency, not a quiet digest — same posture as restore_verify). A transient fetch error
// (blip / timeout / the expected "off" 404) NEVER pages. Fetch is allowed here — cron is off the
// fetch-fence, like alert.ts.
import type { Env } from '../env';

const PROBE_TIMEOUT_MS = 5_000;

// A dedicated error type so the "is this OUR drift?" test is an instanceof, not a fragile
// message-prefix match — renaming the message can never accidentally make the loop swallow a real
// drift page.
class EdgeDriftError extends Error {}

export async function runEdgeProbe(env: Env): Promise<string> {
  const workersDev = env.WORKERS_DEV_HOST?.trim();
  if (!workersDev) {
    return 'edge probe: dormant (set WORKERS_DEV_HOST to watch the off-zone ingress between deploys)';
  }

  try {
    const res = await fetch(`https://${workersDev}/_health`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (res.ok) {
      const body = (await res.json().catch(() => null)) as { app?: string } | null;
      // Page ONLY when the response is demonstrably THIS app leaking off-zone: /_health reports its
      // own `app` name, so an exact match is precise. (A 2xx with just a `status` field is the most
      // common health-endpoint shape on the internet — a parked/placeholder host answering the
      // workers.dev name would false-page, so app-name identity is required, not a generic shape.)
      if (body?.app === env.APP_NAME) {
        // Throw → the ops loop joins this to `failures` → sendAlert pages the owner.
        throw new EdgeDriftError(
          `edge drift detected: workers.dev ingress ${workersDev} is SERVING this app — it bypasses the zone WAF + rate-limiting`,
        );
      }
    }
  } catch (err) {
    // Re-throw only OUR drift error; swallow everything else (unreachable / non-2xx / timeout is
    // the expected healthy state, and a transient blip is not a security regression).
    if (err instanceof EdgeDriftError) throw err;
  }
  return `edge probe: workers.dev (${workersDev}) is not serving — ok`;
}

// Cloudflare Turnstile verification for the pre-auth login surface. Server-side siteverify,
// pre-wired but DISABLED until configured — mirroring the kit's other optional integrations
// (the AI gateway kill-switch, email fail-open in tests). Raw fetch (not the SDK) through an
// injectable fetcher, exactly like src/ai/anthropic.ts, so tests never touch the network.
//
// State machine (see DECISIONS 2026-06-18):
//   • TURNSTILE_SITE_KEY empty  → DISABLED: { enabled:false, ok:true } — no challenge, skip.
//   • site key set, secret missing → ENABLED but misconfigured → fail CLOSED (reject), log it.
//   • site key set, token missing/invalid/unverifiable → fail CLOSED (reject).
//   • site key set, siteverify success → { enabled:true, ok:true }.
// "Fail open when unconfigured, fail closed when half-configured" keeps the template + forks
// deployable while making a partial enable impossible to slip past silently.
import { type Env, getSecret } from '../env';
import { logEvent } from '../platform/logEvent';

const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

export type Fetcher = (input: string, init: RequestInit) => Promise<Response>;

export interface TurnstileResult {
  /** Whether a challenge is configured at all (TURNSTILE_SITE_KEY is set). */
  enabled: boolean;
  /** Whether the request may proceed. Disabled → always true; enabled → only on success. */
  ok: boolean;
  errorCodes?: string[];
}

export async function verifyTurnstile(
  env: Env,
  token: string,
  ip: string,
  fetcher: Fetcher = (url, init) => fetch(url, init),
): Promise<TurnstileResult> {
  const siteKey = env.TURNSTILE_SITE_KEY?.trim();
  if (!siteKey) return { enabled: false, ok: true };

  // Enabled from here — every problem fails CLOSED.
  const secret = await getSecret(env.TURNSTILE_SECRET);
  if (!secret) {
    // TURNSTILE_SITE_KEY set but TURNSTILE_SECRET missing.
    logEvent('turnstile_misconfigured', { cause: 'secret_missing' });
    return { enabled: true, ok: false, errorCodes: ['missing-secret'] };
  }
  if (!token) return { enabled: true, ok: false, errorCodes: ['missing-input-response'] };

  let response: Response;
  try {
    const form = new URLSearchParams();
    form.set('secret', secret);
    form.set('response', token);
    if (ip) form.set('remoteip', ip);
    response = await fetcher(SITEVERIFY_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
  } catch (err) {
    logEvent('turnstile_network_error', { err });
    return { enabled: true, ok: false, errorCodes: ['network-error'] };
  }

  if (!response.ok) return { enabled: true, ok: false, errorCodes: [`http-${response.status}`] };

  const data = (await response.json().catch(() => null)) as {
    success?: boolean;
    'error-codes'?: string[];
  } | null;
  if (!data || data.success !== true) {
    return {
      enabled: true,
      ok: false,
      errorCodes: data?.['error-codes'] ?? ['verification-failed'],
    };
  }
  return { enabled: true, ok: true };
}

// Passwordless magic links. Anti-enumeration: /auth/request returns the same generic
// response whether or not the email is registered; refusals are logged AND audited (domain
// only, never the address; a sentinel actor, deferred so timing is unchanged) and never
// surfaced — the daily anomaly digest reads those rows. Anti-replay: tokens are claimed atomically
// in D1 — exactly one verify wins, ever. At rest: D1 stores only sha256(token), mirroring
// api_tokens (AICOE-346) — the raw token exists in the emailed link alone (and, outside
// production, in the short-lived KV outbox below when the email did not go out), so a D1 reader
// cannot turn an unconsumed row into a login. Verify hashes the presented token to claim. The one
// exception is the opt-in outbox below, which holds a raw link at rest in KV (read its comment).
// Logs: never the link, never the address (PIA C5) — see src/platform/logEvent.ts.
import { makeDb } from '../data';
import { magicLinkEmail } from '../email/templates';
import { sendEmail } from '../email/transport';
import type { Env } from '../env';
import { logEvent } from '../platform/logEvent';
import { appDisplayName } from './interstitial';
import { isReservedIdentifier } from './serviceNamespace';
import { createSession } from './sessions';
import { randomHex, sha256Hex } from './tokens';

const MAGIC_TOKEN_TTL_SEC = 15 * 60;

// THE NON-PRODUCTION OUTBOX — opt-in per address, and a deliberate, time-boxed EXCEPTION to the
// at-rest rule above. Until the central sender is onboarded (docs/RESOURCES.md), a staging or local
// login email is not delivered, and the builder still has to get in. The kit used to print the
// link — token and all — to the log, where Workers Logs kept it 7 days, undeletable, next to the
// address it was for (PIA C5). Now, for an address listed in MAGIC_LINK_OUTBOX, the link is parked
// in the SESSIONS KV namespace under `magic-link-outbox:<address, lowercased>` for the token's own
// lifetime (15 min), and the log says only THAT it happened. Fetch it with
//   npx wrangler kv key get --binding SESSIONS "magic-link-outbox:<you@…, lowercase>" --remote \
//     --config wrangler.staging.jsonc
// What that costs, stated plainly: the value is a RAW, replayable login credential at rest.
// SESSIONS otherwise holds only sha256(sid) (AICOE-346) precisely so that a KV reader cannot log
// in, and KV read is account-wide on a shared account — every fork's CI token carries it. (Those
// tokens also carry KV write, which can already forge a session outright; the exposure the outbox
// ADDS is to holders of KV read.) Hence the two gates, both fail closed:
//   * environment — `staging`, `development`, `test` only; production and any APP_ENV this list
//     does not name never write it (there a delivery failure is a loud error instead);
//   * address — only those listed in MAGIC_LINK_OUTBOX (comma-separated, case-insensitive; a Worker
//     secret on staging, `.dev.vars` locally). Unset = no outbox for anyone, so an unauthenticated
//     POST /auth/request cannot park a link for an owner who never opted in. Delete the secret once
//     email works.
const MAGIC_LINK_OUTBOX_ENVS: ReadonlySet<string> = new Set(['staging', 'development', 'test']);

/**
 * KV key (SESSIONS) holding the latest undelivered link for `email` outside production. The key is
 * the NORMALIZED address — trimmed and lowercased, as requestMagicLink normalizes before writing —
 * so `You@Example.com` and `you@example.com` name the same entry.
 */
export function magicLinkOutboxKey(email: string): string {
  return `magic-link-outbox:${email.trim().toLowerCase()}`;
}

/** Whether `email` (already normalized) is opted in to the outbox via MAGIC_LINK_OUTBOX. */
function outboxOptedIn(env: Env, email: string): boolean {
  // A plain string or nothing: anything else (a Secrets Store binding, say) opts nobody in.
  const listed = env.MAGIC_LINK_OUTBOX;
  if (typeof listed !== 'string') return false;
  return listed
    .split(',')
    .map((address) => address.trim().toLowerCase())
    .includes(email);
}

// Canonical trusted-domain set for internal apps. Put the token `trusted` in
// ALLOWED_EMAIL_DOMAINS to opt into these without listing them per app (DECISIONS
// 2026-06-13, A3). Keep sorted; lowercase.
export const TRUSTED_DOMAINS = [
  'cballiance.com',
  'cialdnb.com',
  'dbisrael.co.il',
  'trustedpartners.com',
] as const;

// Per-app domain policy for invite eligibility.
//   ""          → OPEN (default): no domain gate; the invite-only users table is the
//                 real gate. Lets external-user apps work out of the box.
//   "trusted"   → expands to TRUSTED_DOMAINS (the internal set).
//   "a.com,b.io"→ exactly those domains. May include `trusted` alongside extras.
// Whatever the policy, a user must STILL be invited (present + active in `users`).
export function isAllowedDomain(env: Env, email: string): boolean {
  const tokens = (env.ALLOWED_EMAIL_DOMAINS ?? '')
    .split(',')
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
  if (tokens.length === 0) return true; // open
  const domains = tokens.flatMap((t) => (t === 'trusted' ? [...TRUSTED_DOMAINS] : [t]));
  const at = email.indexOf('@');
  // Exactly one '@' required: a multi-'@' address like `a@evil.com@cialdnb.com` must not
  // extract a trusted suffix and slip the gate, regardless of which path calls this.
  if (at === -1 || email.indexOf('@', at + 1) !== -1) return false;
  return domains.includes(email.slice(at + 1).toLowerCase());
}

// Same-origin relative paths only. A naive `startsWith('/') && !startsWith('//')`
// check is NOT enough: browsers normalize backslashes in a Location header, so
// '/\evil.com' (and '/\/evil.com', '/<tab>/evil.com', …) resolve as the
// protocol-relative '//evil.com' → an open redirect. We resolve the value against a
// sentinel origin with the SAME WHATWG parser the browser uses; anything that lands
// off that origin is rejected. We then guard the parser's NORMALIZED output too: a
// '..'-collapse like '/..//evil.com' resolves on-origin (so the origin check passes)
// but yields a pathname of '//evil.com', which a browser reads as protocol-relative —
// so reject any emitted value that begins '//'. Exported for direct testing.
export function sanitizeReturnTo(value: string | undefined): string | null {
  if (!value || !value.startsWith('/')) return null; // path-relative inputs only
  try {
    const u = new URL(value, 'https://x.invalid');
    if (u.origin !== 'https://x.invalid') return null; // '//evil', '/\evil', … land here
    const path = u.pathname + u.search + u.hash;
    return path.startsWith('//') ? null : path; // '/..//evil.com' → '//evil.com' → reject
  } catch {
    return null;
  }
}

/**
 * Audit a refused magic-link request so the daily anomaly digest can flag a per-domain flood
 * (a spray of probes at one domain). PRIVACY — mirror the log event: DOMAIN ONLY, never the
 * address, and a FIXED SENTINEL actor, never the raw email. Storing the unknown address as the
 * actor would persist the exact probe targets (and, for a disabled real user, an at-rest record
 * of who tried to log in) — the opposite of the anti-enumeration posture this whole path exists
 * to protect. Best-effort: an audit failure must never turn the (deliberately silent) refusal
 * into anything observable, so it is swallowed with the error class logged. Call inside waitUntil
 * so the extra D1 insert never changes the refusal's response LATENCY (the timing oracle the
 * generic body + deferred send already close). Shared by the magic-link refusal branch below and
 * the entra-only refusal in src/auth/routes.ts, so the sentinel + domain-only shape lives in ONE
 * place.
 */
export function auditMagicLinkRefusal(
  env: Env,
  reason: string,
  domain: string,
  ip: string,
): Promise<void> {
  return makeDb(env)
    .audit.insert({
      actor_email: 'anonymous@refused',
      action: 'magic_link_refused',
      payload_json: JSON.stringify({ reason, domain }),
      ip,
    })
    .catch((err) => logEvent('magic_link_refused_audit_failed', { err }));
}

export async function requestMagicLink(
  env: Env,
  rawEmail: string,
  returnTo: string | undefined,
  ip: string,
  // Defers the email send (a network call) off the response path so a registered address
  // can't be told apart from an unknown one by response LATENCY — the body is already
  // identical, and awaiting the send inline made the positive branch much slower. NOTE: the
  // positive branch still does one extra D1 insert (the token) inline, a small residual
  // timing difference — so the generic body + the edge `/auth/*` rate-limit are the primary
  // anti-enumeration defenses, not wall-clock parity.
  waitUntil: (p: Promise<unknown>) => void,
): Promise<void> {
  const email = rawEmail.trim().toLowerCase();
  const db = makeDb(env);
  // A reserved (service) address is never a person, so it never gets a link — refused BEFORE any
  // lookup, in every environment. Not relying on "it is not in `users`": outside production an
  // undeliverable link can be PARKED in the opt-in outbox below, so one minted for a machine
  // identifier would be a session for it there (il-lingua's DATADEV-2259 found it in the log sink,
  // where such links went before PIA C5). Same generic response as an unknown address.
  const reserved = isReservedIdentifier(email);
  const user = reserved ? null : await db.users.getActive(email);
  const domainOk = isAllowedDomain(env, email);

  if (!user || !domainOk) {
    const reason = reserved
      ? 'service_identity'
      : user
        ? 'domain_not_allowed'
        : 'unknown_or_disabled_user';
    const domain = email.split('@')[1] ?? 'invalid';
    logEvent('magic_link_refused', { reason, domain });
    // Make the refusal auditable so the daily anomaly digest can flag a per-domain flood (a spray
    // of unknown-user probes at one domain). The deferred, domain-only, best-effort write lives in
    // auditMagicLinkRefusal (shared with the entra-only refusal path in routes.ts).
    waitUntil(auditMagicLinkRefusal(env, reason, domain, ip));
    return; // caller responds generically — no account enumeration
  }

  const token = randomHex(64);
  // Only the hash touches D1; the raw token rides in the emailed link and nowhere else.
  await db.magicLinks.insert(
    await sha256Hex(token),
    email,
    sanitizeReturnTo(returnTo),
    MAGIC_TOKEN_TTL_SEC,
  );
  const link = `https://${env.DASHBOARD_HOST}/auth/verify?token=${token}`;

  // Email send + audit run AFTER the response is returned (off the response path).
  waitUntil(
    (async () => {
      // The magic-link email is user-facing, so render it with the app's display name (the same
      // resolution the interstitial uses), not the kebab APP_NAME.
      const brand = appDisplayName(env.APP_NAME, env.MAIL_FROM_NAME);
      const outcome = await sendEmail(env, magicLinkEmail(brand, link, email));
      // The outbox write and the audit insert run side by side and are BOTH awaited, whatever
      // either does: a failed insert must neither drop the outbox write (a floating promise the
      // runtime may cancel when the invocation ends) nor escape this waitUntil as a rejection —
      // the runtime logs an unhandled rejection with its message, the D1 text included, outside
      // logEvent. handleUndelivered never rejects; the audit failure is logged as a category.
      const [, audit] = await Promise.allSettled([
        outcome === 'sent' ? undefined : handleUndelivered(env, email, link, outcome),
        db.audit.insert({
          actor_email: email,
          action: 'magic_link_sent',
          payload_json: JSON.stringify({ email_outcome: outcome }),
          ip,
        }),
      ]);
      if (audit.status === 'rejected') {
        logEvent('magic_link_sent_audit_failed', { err: audit.reason });
      }
    })(),
  );
}

/** A magic link the transport did not deliver ('skipped' = no binding, 'failed' = send threw). */
async function handleUndelivered(
  env: Env,
  email: string,
  link: string,
  outcome: 'skipped' | 'failed',
): Promise<void> {
  if (!MAGIC_LINK_OUTBOX_ENVS.has(env.APP_ENV)) {
    // LOUD in production (and in any APP_ENV the outbox list does not name): the response is
    // (deliberately) generic, but a delivery failure means this user cannot log in AND there is
    // no outbox here — so surface it to ops/alerting instead of failing silently. Email
    // onboarding is a hard go-live gate (docs/GO-LIVE.md); this catches a regression after it.
    logEvent('magic_link_delivery_failed', { outcome });
    return;
  }
  // Non-prod. The log names the outcome and whether the link was parked — never the link, never
  // the address. Only an address opted in via MAGIC_LINK_OUTBOX gets a parked link (above).
  if (!outboxOptedIn(env, email)) {
    logEvent('magic_link_not_emailed', { outcome, outbox: 'not_listed' });
    return;
  }
  logEvent('magic_link_not_emailed', { outcome, outbox: 'parked' });
  try {
    await env.SESSIONS.put(magicLinkOutboxKey(email), link, {
      expirationTtl: MAGIC_TOKEN_TTL_SEC,
    });
  } catch (err) {
    logEvent('magic_link_outbox_failed', { err });
  }
}

export async function verifyMagicLink(
  env: Env,
  token: string,
  ip: string,
): Promise<{ sid: string; returnTo: string } | null> {
  const db = makeDb(env);
  const claim = await db.magicLinks.claim(await sha256Hex(token));
  if (!claim) return null;

  // Defense in depth for the refusal in requestMagicLink: a link minted for a reserved address by
  // anything else (a pre-upgrade row, a hand insert) is burnt by the claim above and redeems
  // nothing. Logged with the reason only — never the address.
  if (isReservedIdentifier(claim.email)) {
    logEvent('magic_link_verify_refused', { reason: 'service_identity' });
    return null;
  }

  // The user may have been disabled between mint and click; the token is already
  // consumed at this point, so a blocked user also burns the link (anti-replay).
  const user = await db.users.getActive(claim.email);
  if (!user) return null;

  const sid = await createSession(env, claim.email, 'magic_link');
  await db.audit.insert({
    actor_email: claim.email,
    action: 'login',
    payload_json: JSON.stringify({ method: 'magic_link' }),
    ip,
  });
  return { sid, returnTo: claim.return_to ?? '/' };
}

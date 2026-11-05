// CSRF defense for cookie-authenticated mutations, layered on SameSite=Lax:
// if the browser sent an Origin header it must match the request's own origin.
// A missing Origin is allowed (non-browser clients; Lax already blocks cross-site
// POST cookies in browsers). Bearer requests are exempt — a deliberately attached
// header, not an ambient credential a cross-site page could ride.
import type { Principal } from '../auth/types';

/**
 * Whether the CSRF same-origin check applies to this caller. Keys on credential
 * TRANSPORT and fails CLOSED on both axes: only the deliberately-attached 'bearer'
 * header is exempt — 'cookie', an absent field (a hand-cast Principal in a fork
 * adapter), or any future transport value ('mtls', a device cert…) is treated as
 * ambient and must pass the same-origin check. Written as `!== 'bearer'` rather
 * than `=== 'cookie'` precisely so a novel transport defaults to protected; the
 * unit tests pin that polarity with a cast third value.
 */
export function requiresCsrfCheck(principal: Principal): boolean {
  return principal.credentialTransport !== 'bearer';
}

export function isSameOrigin(req: Request): boolean {
  const origin = req.headers.get('origin');
  if (!origin) return true;
  try {
    return new URL(origin).host === new URL(req.url).host;
  } catch {
    return false;
  }
}

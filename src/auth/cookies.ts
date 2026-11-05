// Session cookie. The __Host- prefix is load-bearing: the browser enforces Secure,
// Path=/, and no Domain attribute, so the cookie is host-only and can never leak to
// sibling subdomains on cialdnb.ai. SameSite=Lax (not Strict) because magic-link
// clicks from email apps are top-level cross-site navigations; mutations are
// independently CSRF-protected (src/security/csrf.ts).

export const SESSION_COOKIE = '__Host-app_session';

/**
 * The ONE place that owns __Host- cookie attribute policy (session cookie + the OIDC
 * login-transaction cookie both serialize through here). Tighten attributes here and
 * every auth cookie inherits it; never fork this string into another module.
 */
export function serializeHostCookie(name: string, value: string, maxAgeSec: number): string {
  return `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}`;
}

export function serializeSessionCookie(sid: string, ttlSec: number): string {
  return serializeHostCookie(SESSION_COOKIE, sid, ttlSec);
}

export function clearSessionCookie(): string {
  return serializeHostCookie(SESSION_COOKIE, '', 0);
}

export function readCookie(header: string | null | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim() || null;
  }
  return null;
}

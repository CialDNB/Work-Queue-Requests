// THE RESERVED SERVICE NAMESPACE. A service identity (a machine principal — src/auth/types.ts
// ServicePrincipal) is attributed in audit_log and read_log under an identifier shaped like an
// email address, because every attribution column in the kit is an `actor_email`:
//
//     svc-<slug>@<app>.invalid          e.g. svc-c360-etl@insights.invalid
//
// `.invalid` is reserved by RFC 2606 §2 and RFC 6761 §6.4: it never resolves, so no mailbox can
// exist under it, no magic link addressed to it can be delivered, no Entra tenant can verify it,
// and it can never collide with a real person's address. Nothing here RELIES on those facts,
// though. The kit refuses the whole TLD, not just well-formed `svc-*` addresses, on every path a
// person uses:
//   - users.add (src/data/users.ts) will not store one, so nobody can be invited under it;
//   - /auth/request, /auth/verify and the Entra callback refuse one (src/auth/magicLink.ts,
//     src/auth/oidc.ts);
//   - createSession / getSession will not mint or honour a session for one (src/auth/sessions.ts).
// And the bearer resolver treats any token owned by a reserved address as a SERVICE token, which
// resolves only through a live `service_identities` row (src/auth/tokens.ts).
//
// The format is il-lingua's (svc-<system>@il-lingua.invalid), kept deliberately: with the app name
// as the domain label, il-lingua's existing identifiers are exactly what the kit mints, so its
// audit history stays continuous when it moves onto kit service identities.
//
// Pure on purpose: no imports, no I/O. src/data imports it too (the token lifetime cap depends on
// whether the owner is a service), so it must not pull the data layer back in.

/** The reserved top-level domain. Every address under it is a non-person identifier. */
export const RESERVED_TLD = 'invalid';

/** Every service identifier's local part starts with this; the slug follows it. */
export const SERVICE_LOCAL_PREFIX = 'svc-';

/**
 * True for ANY address under the reserved TLD — the TLD itself, any subdomain, any case, with or
 * without a trailing root dot — not only well-formed `svc-*` identifiers. Fail closed: the
 * question every caller is asking is "could this be a person?", and for this whole namespace the
 * answer is no. The domain is what follows the LAST '@', the part a mail system would route on.
 */
export function isReservedIdentifier(address: string): boolean {
  const at = address.lastIndexOf('@');
  if (at === -1) return false;
  const domain = address
    .slice(at + 1)
    .trim()
    .toLowerCase()
    .replace(/\.+$/, '');
  return domain === RESERVED_TLD || domain.endsWith(`.${RESERVED_TLD}`);
}

// A slug: lowercase ASCII letters and digits in hyphen-separated words, starting with a letter,
// 2–40 chars (il-lingua's rule). Narrow on purpose — it becomes part of an identifier, an audit
// actor and a log line, and "c360-etl" / "crm" / "sap-hr" is all anyone needs.
const SLUG_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
export const SERVICE_SLUG_MIN = 2;
export const SERVICE_SLUG_MAX = 40;

export function isValidServiceSlug(slug: string): boolean {
  return slug.length >= SERVICE_SLUG_MIN && slug.length <= SERVICE_SLUG_MAX && SLUG_RE.test(slug);
}

// The domain label is the app's name (APP_NAME: kebab-case, validated at bootstrap). Anything that
// is not a clean DNS label falls back to `app` rather than minting an identifier with odd
// characters in it; the identifier is stored at creation, so a later rename never re-keys one.
const LABEL_RE = /^[a-z][a-z0-9-]{0,61}[a-z0-9]$/;

export function serviceDomainLabel(appName: string): string {
  const label = appName.trim().toLowerCase();
  return LABEL_RE.test(label) && !label.includes('--') ? label : 'app';
}

/**
 * `svc-<slug>@<app>.invalid` for a VALID slug. Throws on an invalid one: callers validate at the
 * boundary, so reaching here with a bad slug is a programming error, and silently producing an
 * identifier from it would mint one no route can address again.
 */
export function serviceIdentifierFor(slug: string, appName: string): string {
  if (!isValidServiceSlug(slug)) throw new Error('serviceIdentifierFor: invalid slug');
  return `${SERVICE_LOCAL_PREFIX}${slug}@${serviceDomainLabel(appName)}.${RESERVED_TLD}`;
}

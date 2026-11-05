import { env, SELF } from 'cloudflare:test';
import { SESSION_COOKIE } from '../../src/auth/cookies';
import { createSession } from '../../src/auth/sessions';
import type { Role } from '../../src/auth/types';
import { USERS } from './db';

export const BASE = 'https://work-queue-requests.test';

export async function cookieFor(email: string): Promise<string> {
  const sid = await createSession(env, email, 'magic_link');
  return `${SESSION_COOKIE}=${sid}`;
}

/** Request as a user (or anonymously with email=null). Origin is same-origin so CSRF passes.
 *
 * The `content-type: application/json` header is sent UNCONDITIONALLY — including on bodiless
 * mutations — because that is what a real browser does: the SPA's fetch wrapper set it on every
 * request. This helper used to send it only alongside a body, so the suite never reproduced the
 * browser's actual request shape and CI sailed past a bug that 400'd every DELETE in every fork
 * (AICOE-398). A test client that is politer than the real client cannot catch the real client's
 * bugs. */
export async function asUser(
  email: string | null,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  const headers: Record<string, string> = { origin: BASE, 'content-type': 'application/json' };
  if (email) headers.cookie = await cookieFor(email);
  return SELF.fetch(BASE + path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

export function emailFor(role: Role): string {
  return USERS[role];
}

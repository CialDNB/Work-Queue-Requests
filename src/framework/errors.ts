// Typed application errors. SECURITY INVARIANT — 404-uniformity: a denied resource and
// a missing resource must be byte-identical on every surface. Use notFound() for BOTH;
// never emit a 403 for a resource. (401 "log in first" is fine — it leaks nothing about
// existence.) test/isolation/uniformity.test.ts enforces this per route.

export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** Seconds until the caller may retry; rendered as the `Retry-After` header (429s). */
    readonly retryAfterSec?: number,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

/** The ONLY response for missing-or-forbidden resources and unknown API paths. */
export function notFound(): AppError {
  return new AppError(404, 'not_found', 'Not found');
}

export function unauthorized(): AppError {
  return new AppError(401, 'unauthorized', 'Authentication required');
}

export function badRequest(message: string): AppError {
  return new AppError(400, 'validation_failed', message);
}

export function csrfRejected(): AppError {
  return new AppError(403, 'csrf_rejected', 'Cross-origin request rejected');
}

export function tooManyRequests(retryAfterSec: number): AppError {
  return new AppError(
    429,
    'rate_limited',
    `Rate limited; retry in ${retryAfterSec}s`,
    retryAfterSec,
  );
}

export function conflict(message: string): AppError {
  return new AppError(409, 'conflict', message);
}

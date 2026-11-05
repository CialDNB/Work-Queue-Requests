// Worker entry. Order matters: /_health (public) → auth surfaces (public, rate-limited)
// → the paved road (every /api/* route, fail-closed) → uniform 404 for everything else
// that reaches the worker. Paths outside run_worker_first are served as static assets.
import { Hono } from 'hono';
import { routePath } from 'hono/route';
import { authRoutes } from './auth/routes';
import { runScheduled } from './cron';
import type { Env } from './env';
import { mountRoutes } from './framework/defineRoute';
import { fail } from './framework/envelope';
import { healthResponse } from './health';
import { logEvent } from './platform/logEvent';
import { allRoutes } from './routes';

const app = new Hono<{ Bindings: Env }>();

// One content-free line per request (PIA C5): method, the matched route PATTERN, status and
// duration. It stands in for the platform's invocation log, which is off because it records the
// full URL — a live `/auth/verify?token=…` or `/api/users/<address>` (DECISIONS 2026-09-23).
// Registered first so it wraps everything below, including the fail-closed 401/404 paths.
// The pattern is read AFTER next(): routePath(c) then names the handler that answered. Not the
// last entry of matchedRoutes(c) — the `/api/*` catch-all is registered after every real route,
// so it matches every API request and would make every API line read '/api/*'.
app.use('*', async (c, next) => {
  const started = Date.now();
  try {
    await next();
  } finally {
    logEvent('request_done', {
      method: c.req.method,
      path: routePath(c) || '*',
      status: c.res.status,
      duration_ms: Date.now() - started,
    });
  }
});

// Security headers on EVERY worker response (registered first so it wraps health, auth,
// the API, and the 401/404 fail-closed paths uniformly — same headers on denied and
// missing keeps 404-uniformity intact). The SPA document + static assets get their own
// (document-shaped, script/style 'self') headers from web/public/_headers, served by
// Static Assets. Worker responses are JSON/redirects that render nothing, so their CSP
// is maximally strict. These are KIT-MANAGED DEFAULTS — keep this and web/public/_headers
// in sync, and reconcile both on /kit-upgrade (the skill calls this out).
app.use('*', async (c, next) => {
  await next();
  const h = c.res.headers;
  h.set('X-Content-Type-Options', 'nosniff');
  h.set('X-Frame-Options', 'DENY');
  h.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  h.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  // Strict default for the worker's JSON + redirect responses (they render nothing).
  // The magic-link confirmation interstitial is the one worker response that renders
  // HTML; it sets its own still-tight CSP (default-src 'none' + style-src
  // 'unsafe-inline' + form-action 'self'), so honor a route-set CSP instead of
  // clobbering it.
  if (!h.has('Content-Security-Policy')) {
    h.set('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
  }
});

app.get('/_health', (c) => healthResponse(c.env));
app.route('/', authRoutes());
mountRoutes(app, allRoutes);

// Unknown API path → byte-identical to a denied resource (404-uniformity).
app.all('/api/*', () => fail(404, 'not_found', 'Not found'));
app.notFound(() => fail(404, 'not_found', 'Not found'));

// Unhandled errors render as an opaque 500 (never leak internals to the client). One
// dev-only convenience: the most common first-run mistake is `npm run dev` before
// `npm run db:apply:local`, which throws "no such table" deep in a query — surface a fix
// hint in non-production only; production stays fully opaque. The log line carries the
// error's CATEGORY and the matched route PATTERN only — never the message, which can hold
// request content, SQL with bound values or an address (PIA C5, src/platform/logEvent.ts).
app.onError((err, c) => {
  logEvent('unhandled_error', { method: c.req.method, path: routePath(c), err });
  if (c.env.APP_ENV !== 'production' && /no such table/i.test(String(err))) {
    return fail(
      500,
      'internal_error',
      'Database not initialized — run `npm run db:apply:local` (local dev only).',
    );
  }
  return fail(500, 'internal_error', 'Internal error');
});

export default {
  fetch: app.fetch,
  scheduled: runScheduled,
} satisfies ExportedHandler<Env>;

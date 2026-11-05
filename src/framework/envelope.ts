// One canonical JSON envelope for every kit app's API. Success: { ok: true, data }.
// Error: { ok: false, error: { code, message } } with a machine-readable code and a
// human message — NEVER stack traces or internals. See docs/API-CONVENTIONS.md.

export function ok(data: unknown, status = 200): Response {
  return Response.json({ ok: true, data }, { status });
}

export function fail(status: number, code: string, message: string): Response {
  return Response.json({ ok: false, error: { code, message } }, { status });
}

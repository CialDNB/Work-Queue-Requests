---
name: security-review
description: Adversarial security pass over the current diff (or the whole app before go-live) against the kit's invariants — auth, uniformity, data fence, secrets, PII, budgets. Required gate before /go-live.
---

# /security-review — attack it before anyone else can

Act as a skeptical security reviewer, not the author. Review the diff (`git diff
main...HEAD`) — or the full app when invoked for go-live. Report findings with
file:line, severity, and a concrete fix; then apply agreed fixes and re-verify.

## The kit's invariants (check every one)

1. **Fail-closed auth:** any new surface reachable without a session? Any defineRoute
   bypass (raw `app.get` in src/index.ts)? Public surfaces limited to /auth/* + /_health?
2. **404-uniformity:** could ANY response distinguish "forbidden" from "missing"
   (status, body bytes, headers, timing through different code paths)? Does every
   :param route have a real fixture?
3. **Permission map:** new permissions follow least-privilege? Matrix test updated
   consciously? Any handler doing its own role logic instead of canManageRole-style
   helpers?
4. **Data fence:** `env.DB` outside src/data/? Raw `fetch()` in routes? (semgrep
   catches these, but review intent too — a new integration module needs allowlists
   and timeouts.) **Upstream reads (PIA C15):** does every route that reads an upstream
   HTTP source do it inside `ctx.readUpstream(SPEC, (grant) => …)`, with the source in
   `UPSTREAM_SOURCES` at the right class? Does each integration module for a registered
   source take the grant and call `requireUpstreamGrant` before it fetches? No CI gate
   sees a call made around the seam — this review is the gate (docs/DATA-ROUTES.md).
   **Machine routes and read attribution:** a `machine: true` route with a mutating method
   (POST/PUT/PATCH/DELETE) is the one request shape whose D1 reads go unrecorded once its
   audit row lands with its payload and `X-Sync-Run`, and that row names the service, not
   whoever holds its token (DECISIONS 2026-09-24). So does every such handler return only counts and the keys the caller itself
   sent (`rejectedKeys`) — never a row, a field or an id it read (an upsert's merged row, a
   resolve step's matches, a diff)? Is every lookup the integration needs a GET, which stays
   recorded? Is its audit payload built with `batchAudit()`? The exemption reads the declared
   method, not the response, so no CI gate sees a write that hands back what it read — this
   review is the gate (docs/API-CONVENTIONS.md → machine routes).
5. **Injection:** every query parameterized (`.bind()`)? Any string-built SQL? Any
   HTML rendering of user content in the SPA without React's escaping (e.g.
   dangerouslySetInnerHTML)?
6. **Secrets:** anything sensitive in code, vars (vs secrets), logs, or audit
   payloads? `.dev.vars` still gitignored? gitleaks clean on full history?
7. **PII / synthetic-data rule:** seeds, fixtures, tests, demo content — all
   synthetic? Audit payload_json free of sensitive values (it stores params, never
   bodies — keep it that way)?
8. **AI surfaces:** `cf-aig-collect-log-payload: false` intact? Budget gates not
   widened silently? Prompt content can't exfiltrate other users' data (check what
   context the handler feeds the model)?
9. **CSRF & cookies:** mutations same-origin-checked? `__Host-` prefix + HttpOnly +
   SameSite=Lax untouched? No tokens in URLs (except the one-time magic link)?
10. **Abuse ceilings:** new pre-auth or expensive endpoints rate-limited?
11. **Headers/responses:** stack traces or internals in any error path? (Throw
    AppError or let the opaque 500 handle it.)

## Output format

`[severity] file:line — finding → fix` (severities: blocker / should-fix / note).
Blockers stop /ship and /go-live until resolved. Record systemic findings in
docs/DECISIONS.md; create Linear issues for deferred should-fixes.

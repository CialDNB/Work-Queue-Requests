# Optional: expose your app's own MCP tools

This template is the **opt-in** module for apps that want to expose MCP tools of their
own (so Claude/agents can call your app, the way docshub exposes `docshub_*` tools).
It is NOT wired into the build — most internal apps don't need it. The shell targets
the **stateless MCP spec (2026-07-28)**: no sessions, no Durable Object — every request
authenticates itself and any instance can serve it. (The previous Durable-Object
`McpAgent` pattern is deprecated and feature-frozen upstream; see DECISIONS 2026-08-03.)

## What you get

- **Tools generated from your route registry** (`src/mcp/tools.ts`, part of the kit).
  `buildMcpTools(allRoutes)` turns every `defineRoute()` into an MCP tool whose call runs
  the **same `executeRoute` pipeline** as the HTTP surface — identical permission check,
  Zod validation, handler, and audit-on-write. You do **not** hand-write per-tool auth; a
  tool that skips the permission check or the audit row is impossible by construction. This
  is what keeps the agent surface a governed part of the paved road, not a parallel one.
- A **stateless handler shell** (`agent.ts` sketch in this folder) — the transport only:
  it resolves a LIVE principal from each request's own `Authorization` header (revocation,
  disable, and role changes bite on the next request — nothing is ever persisted, not even
  a token hash, because there is no session state to persist) and registers only the tools
  the caller may use (`toolsForPrincipal` — the enumeration analog of 404-uniformity,
  explicitly conformant under 2026-07-28's per-identity list-variance rule). For a bearer
  caller that is its role ∩ its token's scopes, minus the non-delegable set (tokens, user
  management, settings, audit/read logs, the manifest — PIA C8), so an agent is never shown a
  tool it cannot call. If you emit list cache hints, filtered lists are
  `cacheScope: "private"` — never `"public"`.
- **Authentication:** pre-issued `t_*` bearer tokens — already supported by the kit
  (`src/auth/tokens.ts`); zero extra setup, the right default for internal use, and the
  same Principal your API uses, narrowed by the token's scopes. Mint a dedicated token for the
  MCP client with only the scopes it needs, and note that every token expires within 90 days
  (`docs/runbooks/machine-token-rotation.md`). (OAuth is possible but deliberately not paved: the
  2026-07-28 spec deprecates Dynamic Client Registration in favor of Client ID Metadata
  Documents, and the ecosystem libraries haven't settled on CIMD yet — revisit when they
  do. See DECISIONS 2026-08-03.)

## Wiring it up (deliberate steps — this is protected-core work)

1. `npm i agents @modelcontextprotocol/server` (agents ≥ 0.20 for `createMcpHandler`;
   `@modelcontextprotocol/server` v2 is the stable 2026-07-28-spec SDK).
2. Copy `agent.ts` to `src/mcp/agent.ts`. The tools come from `buildMcpTools(allRoutes)` —
   you register `toolsForPrincipal(...)` and forward each call to `tool.invoke(env, principal, args)`.
   The kit's tool `inputSchema` is a plain JSON Schema, so wrap it in the SDK's
   `fromJsonSchema(...)` at registration (v2 accepts Standard Schema objects or that wrapper —
   never a raw JSON Schema directly; the sketch shows this). You do NOT re-implement auth,
   validation, or audit per tool: `executeRoute` does all of it, and the data-layer fence
   still applies because the handlers are your existing repositories.
3. Route `/mcp` in `src/index.ts` (see the wiring snippet in `agent.ts`): authenticate the
   Bearer `t_*` token first — no principal, no handler — then hand the request to
   `createMcpHandler`. `run_worker_first` already lists `/mcp`, so no wrangler change is
   needed. **No Durable Object, no binding, no migration.**
4. The kit already tests the generator (`test/mcp/tools.test.ts`): tool-per-route, input
   schema, per-caller filtering (bearer narrowing included), uniform denial, audit-on-write,
   bounded background-work drain.
   Add app-specific tests only for tools whose handlers you wrote; the enforcement itself
   is covered upstream.
5. Record the decision in `docs/DECISIONS.md`. (Nothing to add to `docs/RESOURCES.md` —
   the stateless shell provisions no resources.)

## Client compatibility (read before flipping this on)

The 2026-07-28 spec is a breaking rearchitecture (no `initialize` handshake, per-request
`_meta`, MRTR instead of server-initiated requests). Anthropic has announced support is
rolling out across Claude products, but verify your actual clients speak it before
exposing a spec-2026-07-28-only endpoint; `createMcpHandler`'s `legacy` option controls
how older-protocol requests are treated.

## Why this is not on by default

An MCP surface is a second front door. The kit's stance (from the Arena right-sizing
record): ship the smallest attack surface by default; add doors deliberately, with
tests and an audit trail, never by template inertia.

// SKETCH — copy to src/mcp/agent.ts when opting in (see README.md in this folder).
// Not compiled as part of the template (tsconfig excludes templates/).
//
// STATELESS MCP (spec 2026-07-28; DECISIONS 2026-08-03). The previous sketch wrapped the
// tools in a Durable-Object McpAgent; upstream has deprecated and feature-frozen McpAgent,
// and the 2026-07-28 protocol removed sessions entirely. The shell is now a per-request
// stateless handler: no DO binding, no wrangler migration, no session state anywhere.
//
// The tools themselves are still GENERATED from your route registry by src/mcp/tools.ts,
// so every tool call runs the SAME executeRoute pipeline as the HTTP surface — identical
// permission check, Zod validation, handler, and audit-on-write. This file is only the
// transport shell: it authenticates the caller and registers the tools that caller may use.
//
// Invariants this shell upholds — stronger than the old DO shell, with less code:
//   1. NOTHING is persisted. The old shell stored the token HASH in DO props and
//      re-resolved a live principal on every call; here there are no props to store.
//      Every request resolves a LIVE principal from its own Authorization header, so a
//      revoked token / disabled user / role change bites on the next request — the same
//      guarantee, now structural. (Statelessly, every tool call IS its own request.)
//   2. The tool LIST is filtered per request to the caller's EFFECTIVE permissions
//      (toolsForPrincipal — the enumeration analog of 404-uniformity). Every /mcp caller is
//      a bearer token, so that is its role ∩ its token's scopes, minus the non-delegable set
//      (PIA C8; src/auth/permissions.ts) — a token is never offered post_tokens, get_audit
//      and the like. Per-IDENTITY list variance is explicitly conformant under 2026-07-28
//      ("the set MAY vary by the authorization presented on the request"); the per-SESSION
//      variance the rule used to guard against no longer exists. If you surface list cache
//      hints, filtered lists are cacheScope 'private' — NEVER 'public': a shared cache must
//      not serve one caller's tool list to another.
//   3. The per-call executeRoute permission re-check remains the actual security
//      boundary; the list filter is UX + defense-in-depth.
//
// import { createMcpHandler } from 'agents/mcp/server'; // agents >= 0.20
// // v2 — the 2026-07-28 spec, stable. fromJsonSchema is REQUIRED for the kit's tools:
// // registerTool's inputSchema accepts Standard Schema objects (Zod/ArkType) or a plain
// // JSON Schema wrapped in fromJsonSchema — never a raw JSON Schema object directly.
// import { fromJsonSchema, McpServer } from '@modelcontextprotocol/server';
// import { resolveApiToken } from '../auth/tokens';
// import type { Principal } from '../auth/types';
// import type { Env } from '../env';
// import { allRoutes } from '../routes';
// import { buildMcpTools, toolsForPrincipal } from './tools';
//
// const TOOLS = buildMcpTools(allRoutes); // generated once from the route registry
//
// function buildServerFor(env: Env, principal: Principal): McpServer {
//   const server = new McpServer({ name: 'your-app', version: '1.0.0' });
//   // Closures carry THIS request's live principal — no cross-request state to leak.
//   for (const t of toolsForPrincipal(TOOLS, principal)) {
//     server.registerTool(
//       t.name,
//       // The kit's inputSchema is a plain JSON Schema (toInputJsonSchema) — wrap it.
//       { description: t.description, inputSchema: fromJsonSchema(t.inputSchema) },
//       (args) => t.invoke(env, principal, args),
//     );
//   }
//   return server;
// }
//
// // In src/index.ts, before the asset fallthrough (run_worker_first already lists '/mcp').
// // Auth stays in the wrapper so the surface is fail-closed by construction: no principal,
// // no handler — a wiring mistake exposes zero tools, never all of them. Building the
// // handler per request is deliberate (it is stateless anyway) and lets the factory close
// // over env + principal without any module-scope threading.
// // app.all('/mcp', async (c) => {
// //   const authz = c.req.header('authorization') ?? '';
// //   const token = authz.toLowerCase().startsWith('bearer ') ? authz.slice(7).trim() : '';
// //   const principal = token ? await resolveApiToken(c.env, token) : null;
// //   if (!principal) return fail(401, 'unauthorized', 'Authentication required');
// //   const handler = createMcpHandler(() => buildServerFor(c.env, principal), {
// //     route: '/mcp',
// //     corsOptions: false, // bearer-only surface; browsers have no business here
// //   });
// //   return handler(c.req.raw, c.env, c.executionCtx);
// // });
//
// VERIFY against the installed agents version's types when you copy this in — the factory
// also receives an McpRequestContext ({ era, authInfo?, requestInfo? }) if you prefer a
// module-scope handler that reads the Authorization header itself via requestInfo.
export {};

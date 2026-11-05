// Meta endpoints — the app's machine-readable manifest (src/framework/manifest.ts).
// Owner/admin via a SESSION only: the manifest exposes the full route + permission structure
// (no data, no secrets, but governance-grade intel), and `meta.read` is non-delegable, so no
// `t_*` token reaches it whatever its role or scopes (PIA C8, DECISIONS 2026-09-23). The fleet
// registry does not pull it: the daily `report_to_registry` cron pushes the manifest to the
// registry (src/cron/reportToRegistry.ts).
//
// The manifest must list EVERY route — including itself — so the handler needs the full
// registry, which in turn contains this route. That is an inherent self-reference. It is
// resolved WITHOUT an import cycle: `index.ts` PASSES the registry in as a lazy accessor
// (`() => allRoutes`) instead of this module importing the `./index` barrel. The accessor is
// invoked only at REQUEST time, by which point `allRoutes` is fully initialized, so it can
// safely close over that const before it is assigned. Previously this module imported
// `allRoutes` from `./index` directly; that was TDZ-safe only because `index.ts` happens to be
// evaluated first (its eager `...metaRoutes` spread would throw a ReferenceError at module load
// if anything imported `routes/meta` before `routes/index`). Handing the registry in removes
// that load-order landmine entirely. The "manifest lists itself" test (test/routes/meta.test.ts)
// pins the self-listing guarantee.
import { z } from 'zod';
import { defineRoute, type RouteDef } from '../framework/defineRoute';
import { buildManifest } from '../framework/manifest';

/** Build the meta routes, given a lazy accessor for the full route registry. `index.ts` calls
 * this with `() => allRoutes`; the accessor runs only inside the handler (request time), so it
 * may close over `allRoutes` before that const is initialized without a TDZ hazard — and this
 * module never imports the route barrel, so there is no meta↔index import cycle to reason about. */
export function createMetaRoutes(getRoutes: () => readonly RouteDef[]): RouteDef[] {
  return [
    defineRoute({
      method: 'GET',
      path: '/api/meta/manifest',
      permission: 'meta.read',
      summary:
        "Machine-readable projection of this app's routes, permissions, and audit vocabulary",
      input: z.object({}),
      handler: async (ctx) => ({
        ...buildManifest(ctx.env, getRoutes()),
        generated_at: new Date().toISOString(),
      }),
    }),
  ];
}

// THE DATA CLASS OF EACH REPOSITORY — which parts of the data layer hold CLIENT-class data.
//
// The class axis is the one the read ledger already uses for private databases (`ReadSourceClass`,
// src/data/readLog.ts; decided per source in AURORA_SOURCES, src/data/aurora.ts): `client` is data
// about CIAL's clients and the third parties in their records — company records, national ids,
// report datablocks; `internal` is the app's own operational data. This table carries the same
// axis one level up, to the repositories a route declares in `needs`, because that is the only
// statement a route makes about what data it can reach.
//
// WHO READS IT: the agent-exposure guard (src/framework/agentExposure.ts). A route exposed to the
// in-app agent hands whatever it returns to a model provider, so an exposed route whose `needs`
// reaches a client-class repository must carry an `egressRuling` — a DPO-signed Linear decision
// with a written necessity test (PIA C3). Nothing else consults it yet.
//
// FAIL-CLOSED DEFAULT: a repository NOT listed here is CLIENT-class. A fork's new repository is
// therefore treated as client data the moment an exposed route names it, and the build stops until
// someone either classifies it `internal` here (a reviewed line in protected core) or obtains the
// ruling. The wrong direction — a client repository silently treated as internal — needs an
// explicit, wrong line in this file, which is what code-owner review is for.
//
// A PRIVATE DATABASE IS NOT A `needs` KEY. Aurora repositories are functions a handler calls with
// `ctx.env` (docs/DATA-ROUTES.md), so no line here can classify one, and no route declaration can
// prove it never calls one. That half of C3 is the app's: in an app whose AURORA_SOURCES holds a
// client-class source, every exposed route needs a ruling (assertPrivateSourcesRuled,
// src/framework/agentExposure.ts). A D1 repository that COPIES client-class private data into D1
// is client-class, full stop: classify it `client` (or leave it out).
//
// Forks: add one line per repository you classify, in the same PR as the repository. The kit's own
// repositories are all internal — the kit holds no client data; `users` is staff and client-user
// accounts, the app's own operational data, not client records.
import type { Db } from './index';
import type { ReadSourceClass } from './readLog';

// `satisfies` on the OBJECT LITERAL itself, not an annotation and not on `Object.freeze(…)`: only a
// fresh literal gets TypeScript's excess-property check, so only this way is a key that is not a
// repository — a typo, or a kit line for a repository your fork does not have — a compile error.
// (On the freeze call's result it was silently accepted.) The table stays partial on purpose:
// absent means client (see above). Frozen on its own line below.
const REPOSITORY_DATA_CLASS = {
  users: 'internal',
  groups: 'internal',
  audit: 'internal',
  magicLinks: 'internal',
  tokens: 'internal',
  serviceIdentities: 'internal',
  aiBudget: 'internal',
  settings: 'internal',
  readLog: 'internal',
  activity: 'internal',
  meta: 'internal',
  // `agent` and `agentErasure` (the transcript store) are deliberately NOT listed, so they are
  // CLIENT-class: a transcript quotes whatever tool results the agent saw, client data included.
  // They are AGENT_FORBIDDEN_REPOSITORIES as well (src/auth/permissions.ts), so no exposed route can
  // name them whatever this table says — the omission is the honest class, not the only fence.
  // ---- app repositories (golden example — classify yours alongside) ----
  notes: 'internal',
} satisfies Partial<Record<keyof Db, ReadSourceClass>>;
Object.freeze(REPOSITORY_DATA_CLASS);

/**
 * The data class of repository `name`: `internal` only when this table says so explicitly, and
 * `client` for everything else — an unlisted repository, an unknown name, a typo. Fail closed.
 */
export function repositoryDataClass(name: string): ReadSourceClass {
  return Object.hasOwn(REPOSITORY_DATA_CLASS, name) &&
    (REPOSITORY_DATA_CLASS as Readonly<Record<string, ReadSourceClass>>)[name] === 'internal'
    ? 'internal'
    : 'client';
}

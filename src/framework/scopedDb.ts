// PER-ROUTE LEAST PRIVILEGE for the data layer — the runtime half of `RouteSpec.needs`.
//
// `ctx.db` is normally the WHOLE data layer: a notes handler can read ctx.db.users,
// ctx.db.tokens, ctx.db.audit. That is ambient authority — nothing but code review stands
// between a feature handler and every table in the app. A route that declares
// `needs: ['notes']` gets a view that is typed `Pick<Db, 'notes'>` AND backed by this proxy,
// which throws on every other repository. The declaration is enforced, not advisory: a
// handler cannot quietly grow reach that its spec doesn't admit to.
//
// OPT-IN BY CONSTRUCTION. executeRoute builds this only when `needs` is present; a route
// without `needs` receives the `makeDb()` object itself — no proxy, no wrapper, no extra
// allocation on a path that runs on every request of every app (see execute.ts step 4).
// `scopedNeedsOf()` exists so that "the unscoped path allocates no wrapper" is a fact CI
// checks, not a claim in a PR body.
//
// What the proxy is NOT. (1) It does not scope the framework's own writes: executeRoute keeps
// a reference to the full `makeDb()` result and uses it for the declared audit row and for
// `ctx.audit()` — those are framework capabilities the route already declared through
// `audit:`, mediated by the framework. `needs` scopes what the HANDLER reaches directly.
// (2) It is not a sandbox: `ctx.env` still carries the bindings, and what keeps a handler off
// `env.DB` is the semgrep data fence (CLAUDE.md, "Never do"), not this. `needs` closes the
// ambient-authority gap ON the sanctioned path — the one every handler actually uses.
import type { Db } from '../data';

/**
 * Brand carried by a scoped view, holding the `needs` it was built from. Exposed for tests
 * and debugging (a handler reading it only learns its own route's declaration); the type
 * system, not this symbol, is how callers are meant to know what a view carries.
 */
export const SCOPED_DB = Symbol('kit.scopedDb');

/**
 * The `needs` behind a scoped `ctx.db`, or `undefined` for the unscoped full data layer.
 * This is how the tests prove the no-`needs` path is unchanged: it must return `undefined`,
 * i.e. nothing wrapped the `makeDb()` result at all.
 */
export function scopedNeedsOf(db: object): readonly string[] | undefined {
  return (db as Record<symbol, readonly string[] | undefined>)[SCOPED_DB];
}

/**
 * What a handler gets for reaching past its `needs`. The message is for the developer's stack
 * trace; the `name` and `code` are for the log. Logs carry an error's category, never its message
 * (PIA C5, src/platform/logEvent.ts), so the repository it reached rides in `code` — a code
 * identifier, `undeclared_repo:<name>` — which is what keeps the `route_error` line diagnostic.
 */
export class NeedsScopeError extends Error {
  override readonly name = 'NeedsScopeError';
  readonly code: string;
  constructor(message: string, repository: string) {
    super(message);
    this.code = `undeclared_repo:${repository}`;
  }
}

/**
 * A view of `db` exposing only the named repositories. Reading anything else — including
 * through `Object.getOwnPropertyDescriptor`, the one route around a `get` trap — throws.
 * Undeclared repositories are also absent from `in` and `Object.keys`, so the view behaves
 * like the `Pick<Db, N>` it is typed as rather than like a full Db that bites.
 *
 * `method`/`path` are passed separately (rather than a pre-built label) so the message is
 * only concatenated on the throw path, never on a successful request.
 */
export function scopeDb<N extends keyof Db>(
  db: Db,
  needs: readonly N[],
  method: string,
  path: string,
): Pick<Db, N> {
  // `needs` is 1–3 entries in practice; a linear scan beats allocating a Set per request.
  const allows = (prop: string | symbol): boolean =>
    typeof prop === 'string' && (needs as readonly string[]).includes(prop);

  // Own properties of a makeDb() result ARE the repositories, so "own but not declared" is
  // exactly "an undeclared repository". Anything else (Symbol.toPrimitive, a `then` probe,
  // a typo'd name) is not a repository and keeps its ordinary meaning: undefined.
  const isUndeclaredRepo = (prop: string | symbol): boolean =>
    !allows(prop) && Object.hasOwn(db, prop);

  const denial = (prop: string | symbol): Error =>
    new NeedsScopeError(
      `Route ${method} ${path} reached ctx.db.${String(prop)}, which it did not declare in \`needs\` ` +
        `(declared: ${needs.length > 0 ? needs.join(', ') : 'none'}). Add the repository to \`needs\`, ` +
        `or use one the route declared.`,
      String(prop),
    );

  return new Proxy(db, {
    get(target, prop, receiver) {
      if (allows(prop)) return Reflect.get(target, prop, receiver);
      if (prop === SCOPED_DB) return needs;
      if (isUndeclaredRepo(prop)) throw denial(prop);
      return Reflect.get(target, prop, receiver);
    },
    has(target, prop) {
      if (isUndeclaredRepo(prop)) return false;
      return Reflect.has(target, prop);
    },
    ownKeys(target) {
      return Reflect.ownKeys(target).filter((k) => allows(k));
    },
    // Without this, `Object.getOwnPropertyDescriptor(ctx.db, 'users').value` would hand back
    // the users repository and walk straight past the `get` trap.
    getOwnPropertyDescriptor(target, prop) {
      if (isUndeclaredRepo(prop)) throw denial(prop);
      return Reflect.getOwnPropertyDescriptor(target, prop);
    },
  }) as Pick<Db, N>;
}

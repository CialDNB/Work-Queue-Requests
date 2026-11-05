// FORK-OWNED: where this app's PERMISSIONS come from (the authority seam, src/auth/authority.ts).
// The kit's protected resolvers call `authorityFor` once per PERSON resolution, after the live
// `users` row is found and before the Principal is returned. There are three:
//   - resolvePrincipal (src/auth/index.ts), a session cookie: `session` and `request` are set;
//   - resolveApiTokenByHash (src/auth/tokens.ts), a personal bearer token: `session` is null, and
//     `request` is the request over HTTP, null when the MCP adapter re-resolves from the hash;
//   - resolveRunPrincipal (src/auth/runPrincipal.ts), an in-app agent turn, before every model
//     round and every tool call: a SESSION principal (`credentialTransport: 'cookie'`) re-derived
//     from the stored session the turn was started on, with `request: null`. There is no request:
//     derive the grant from `session` alone. A refusal or a throw ends the turn `revoked`, and so
//     does a decided set without `agent.use` — map it for the people who may use the agent.
// So `request === null` does NOT mean "bearer": read the transport from `principal`. This file
// lives in src/routes/ because that is the part of the tree /kit-upgrade never overwrites: the kit
// ships this role-only default, and your copy is yours.
//
// Answer one of:
//   null                     the ROLE decides (users.role → PERMISSIONS). The kit default, and the
//                            right answer for every app without an external authority.
//   { permissions: keys }    the AUTHORITATIVE set for THIS resolution (a request, or one agent
//                            round or tool call): it REPLACES the role in principalCan — a key
//                            missing from it is denied even when the role has it. A bearer token
//                            still narrows it (its scopes), and a bearer never holds the
//                            non-delegable set. Keys your PERMISSIONS does not define are dropped
//                            and counted (`principal_authority_keys_dropped`).
//     + attributes?          optional DATA for your own routes on the same request (declare its
//                            fields by augmenting PrincipalAttributes, src/auth/types.ts). Never
//                            authority: no kit check reads it.
//   { refuse: 'code' }       no principal at all: a 401 — on an agent turn, the turn ends
//                            `revoked` — and the kit logs `principal_authority_refused` with the
//                            code. A fixed identifier — never an email or anything read from the
//                            request; a value outside [A-Za-z0-9_.:-]{1,64} is logged as
//                            `unspecified`.
// A hook that THROWS, or answers anything else, refuses (401) — `undefined` included: a branch that
// ends without a `return` does not typecheck, and at runtime it refuses rather than reading as
// "the role". Nothing here ever falls back to the role: an authority that failed is not one that
// said "use the role". Say `null` when you mean the role.
//
// Called on EVERY resolution and never cached by the kit — keep it that way (PIA C15: no
// permission snapshot outlives a turn). Service identities never reach it; their one scope is the
// kit's business. `src/routes/tokenPolicy.ts` runs AFTER this for bearer tokens, and sees the set.
//
// AND DECLARE IT: `authorityIsExternal(env)` says whether this app's authority is external on this
// env — `true` whenever `authorityFor` may answer `{ permissions }` for anyone. It is a fact about
// the app, not about one caller, and the kit holds you to it:
//   - a hook that answers a set on an env declared `false` REFUSES (401, `undeclared_external`);
//   - while it is `true`, the in-app agent starts a run only for a person on a SESSION whose
//     permissions your hook decided (authorityRefusesAgentRun, src/auth/authority.ts): never on a
//     bearer token — even one your hook left on the role (`null`) — and never on the role.
// The kit default is `false`: the role decides everywhere, and nothing changes.
//
// Example — an app whose permissions come from an upstream ACL, re-derived on every resolution
// from the ACL credential its sessions carry (the shape of the insights fork). The CREDENTIAL comes
// first: a session that carries one is always re-derived — and refused if that fails, even after
// ACL was unconfigured — so only a caller with no ACL credential can ever get the role. It reads
// everything from `session` and `principal`, so an agent turn (`request: null`) gets the same set.
//
//   export const authorityIsExternal: ExternalAuthorityCheck = (env) => aclAuthorityRequested(env);
//
//   export const authorityFor: AuthorityCheck = async (principal, { env, session, request }) => {
//     const aclToken = session?.acl_access_token;
//     if (aclToken) {
//       const profile = await fetchAclProfile(env, aclToken, {
//         // `request` is null on an agent turn: guard every read of it.
//         includeProductDirectory: request !== null && new URL(request.url).pathname === '/api/me',
//       });
//       if (!profile.ok) return { refuse: `acl_${profile.reason}` };
//       if (profile.profile.email !== principal.email) return { refuse: 'acl_email_mismatch' };
//       const granted = aclPermissionsToKeys(profile.profile.permissions);
//       if (granted.size === 0) return { refuse: 'acl_app_grant_revoked' };
//       return {
//         permissions: granted,
//         attributes: { aclCompanies: profile.profile.companies },   // for the company picker
//       };
//     }
//     if (!aclAuthorityRequested(env)) return null;             // no ACL at all: the role
//     if (principal.credentialTransport === 'cookie') return { refuse: 'no_acl_credential' };
//     return null;
//     //   ^ a bearer token: local authority (refuseTokenFor refuses ACL users' tokens). The agent
//     //     still refuses every run on it, because authorityIsExternal says true.
//   };
import type { AuthorityCheck, ExternalAuthorityCheck } from '../auth/types';

export const authorityFor: AuthorityCheck = () => null;

export const authorityIsExternal: ExternalAuthorityCheck = () => false;

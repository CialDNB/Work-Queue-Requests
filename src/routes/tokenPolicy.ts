// FORK-OWNED: the bearer-token refusal policy (PIA C8). The kit's protected resolver
// (resolveApiTokenByHash in src/auth/tokens.ts) calls `refuseTokenFor` once per bearer request,
// after the token and the live user are found and the app's authority hook
// (src/routes/authorityPolicy.ts) has answered — so `principal.permissions` is set when that hook
// set it — and before a Principal is returned. This file lives
// in src/routes/ because that is the part of the tree /kit-upgrade never overwrites: the kit ships
// this allow-all default, and your copy is yours.
//
// Return a short reason CODE to refuse the token (the request becomes a 401 and the kit logs
// `{"event":"api_token_refused","reason":"<code>"}`), or null to allow. The code is a fixed
// identifier — never an email, a name, or anything read from the request; a value outside
// [A-Za-z0-9_.:-]{1,64} is logged as `unspecified`. A hook that throws refuses.
//
// Refusal can only take away: the principal it is handed is ALREADY narrowed by the token's scopes
// and the non-delegable set (src/auth/permissions.ts), and nothing returned here can widen it.
//
// Example — an app whose authoritative permissions come from an upstream ACL, where a token has
// no grant snapshot to re-derive them from (the insights fork does exactly this):
//
//   export const refuseTokenFor: TokenRefusalCheck = (_principal, { env, user }) =>
//     aclAuthorityRequested(env) && user.added_by === 'cial_acl'
//       ? 'acl_user_no_grant_snapshot'
//       : null;
import type { TokenRefusalCheck } from '../auth/types';

export const refuseTokenFor: TokenRefusalCheck = () => null;

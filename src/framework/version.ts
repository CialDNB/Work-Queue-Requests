// The paved-road KIT version this app is currently synced to. This is the stamp file:
// `/kit-upgrade` bumps it when it adopts template changes, so the app manifest
// (src/framework/manifest.ts) reports version lag to the fleet registry. It is deliberately
// DISTINCT from package.json's `version` — that is the app's OWN version; this records which
// kit the fork last pulled from. A single constant is the source of truth (the worker can't
// read a file at runtime), so there is no separate stamp to drift out of sync.
export const KIT_VERSION = '0.2.1';

// The version of the SHARED KIT CHECKS this fork carries (scripts/kit-checks/). Deliberately
// DISTINCT from KIT_VERSION: the checks move on their own cadence and a fork can be current on
// one and behind on the other, which is precisely the lag the fleet registry needs to see. The
// Worker cannot read a file at runtime, so this constant — not scripts/kit-checks/checks.sync.json
// — is what the manifest reports; `node scripts/sync-checks.mjs --check` fails when the two
// disagree, and `--stamp` writes them together.
export const CHECKS_VERSION = '1.1.0';

// This app's MATURITY MODE — flipped from 'incubating' to 'stable' at graduation (any of: a
// second maintainer joins, data classification reaches PII/client, sustained production users, or
// an ownership handoff). Incubating = one owner + a named break-glass successor, zero review
// friction; stable = a second CODEOWNER + branch protection on. The report cron sends this to the
// fleet registry so it can flag drift (stable-criteria met but still incubating). Graduation rides
// a reviewed PR — see docs/COLLABORATION.md → "Maturity lifecycle". Fresh apps start incubating.
export const APP_MATURITY: 'incubating' | 'stable' = 'incubating';

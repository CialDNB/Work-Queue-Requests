#!/usr/bin/env node
// Mechanical half of the /new-app bootstrap: renames the template into your app.
// The conversational half (Linear project, provisioning walk-through, first deploy)
// is driven by the /new-app skill in Claude Code — run that; it calls this script.
//
// Three things a naive find/replace gets wrong, all handled here:
//   • D1/KV bind by ID, not name — so the rename ALSO resets the staging resource ids to
//     the provisioning placeholder, or a fresh app stays bound to paved-road's staging
//     DB + session KV (prod is already placeholder). See src/platform/bootstrap.ts.
//   • runtime secrets bind by store NAME — renameTemplateRefs repoints the per-app
//     `PAVED_ROAD_*` secret_name prefix to `<APP>_*` (the shared PAVED_ROAD_ALERT_WEBHOOK_URL
//     is allowlisted and kept), or a fresh app shares paved-road's Anthropic key + budget.
//   • a forgotten file leaves a stale `paved-road` identifier (or `PAVED_ROAD` secret
//     prefix) — so a post-rename tripwire greps the repo and fails the bootstrap if any
//     survive outside the kit self-references.
//   • the marketplace/plugin packaging (plugins/, .claude-plugin/) is template-repo-only;
//     "Use this template" copies it in, so the bootstrap strips it — else a fresh app ships a
//     self-referential marketplace + a verify:plugin gate it can't satisfy (`/paved-road:pave`
//     already excludes it). See stripPluginPackaging.
// It also stamps docs/RESOURCES.md back to a placeholder so a fresh app never ships
// paved-road's resource manifest + ids (a security-attribution file), and re-stamps
// docs/agent-guidance.sync.json for the renamed CLAUDE.md (see restampAgentGuidance).
//
// THE DEPLOYMENT TARGET (opt-in; DECISIONS 2026-10-27, "new-app DB Israel target"). CIAL is the
// default, and nothing is ever inferred: not from the name, the org, the git remote or the user.
// `--target dbisrael` makes a DB Israel app, delivered by the central DB Israel pipeline: it writes
// the deployment marker first (so the plugin path's second run keeps the target), runs the same
// rename, then installs central's release caller byte for byte, sets the CIAL account, store,
// gateway, host and mail values in both wrangler configs to sentinels or blanks by key, removes
// `routes` and tools/, stamps docs/RESOURCES.md and writes docs/CENTRAL-DELIVERY.md, and prints the
// identity block, the platform handoff and the draft registration (scripts/central-proposal.mjs).
// What a rerun may do depends on the tree (planBootstrap): a target change is a reviewed migration,
// never a rerun. The deployment-target reader (scripts/deployment-target.mjs) owns the marker's
// path and the caller's bytes; this file asks it for both.
//
// Usage:
//   node scripts/new-app.mjs <app-name> [--display "Display Name"] [--target cial|dbisrael]
//   node scripts/new-app.mjs --verify-only   # re-check a repo (e.g. after a hand-rename)
//   app-name: kebab-case, e.g. "arena-go" → resources arena-go-db, staging-arena-go.cialdnb.ai…
//   (3-40 characters; 3-32 for a DB Israel app, central's rule). Flags go in any order, as
//   `--flag value` or `--flag=value`. An unknown flag, a missing value or an unknown target exits 1
//   and changes nothing.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { isMainModule } from './kit-checks/main-module.mjs';

// ── Mirror of src/platform/bootstrap.ts — keep in sync (node can't import the TS module;
// test/platform/bootstrap.test.ts + test/platform/new-app.test.mjs pin both copies to one
// contract so drift fails CI). Same convention as scripts/provision.mjs ↔ naming.ts. ──────
const TEMPLATE_KEBAB = 'paved-road';
const TEMPLATE_DISPLAY = 'Paved Road';
const TEMPLATE_CONSTANT = 'PAVED_ROAD'; // per-app Secrets Store prefix (see bootstrap.ts)
// Deliberately-shared secret names: carry the PAVED_ROAD token but are NOT renamed per-app and
// NOT flagged by the tripwire (the central account-wide alert webhook, the one Entra client
// secret behind the shared "CIAL Internal Apps" registration, and the one fleet-wide Turnstile
// widget's siteverify secret). See bootstrap.ts — the parity test (test/platform/new-app.test.mjs)
// pins this mirror to the TS canonical.
const SHARED_SECRET_NAMES = [
  'PAVED_ROAD_ALERT_WEBHOOK_URL',
  'PAVED_ROAD_ENTRA_CLIENT_SECRET',
  'PAVED_ROAD_TURNSTILE_SECRET',
];
// The kit's own repository: a deliberately-shared name like the secrets above, neither renamed nor
// flagged. Carried kit files name it as the upstream an app syncs from (sync-checks.mjs CANON_REPO,
// checks.sync.json `source`) and in issue links. Only the exact slug: a longer repository name is
// still flagged. See bootstrap.ts.
const KIT_REPOSITORY = 'CialDNB/paved-road';
const KIT_REPOSITORY_RE = new RegExp(`${KIT_REPOSITORY}(?![\\w-])`);
const PROVISION_PLACEHOLDER = 'PLACEHOLDER_RUN_PROVISION';
const TEMPLATE_STAGING_IDS = [
  '358e2840-8dd7-45c4-b59d-18c48b10cb57', // paved-road-db-staging (D1)
  '02ab99a8697840d79c0e04b2919d518e', // paved-road-sessions-staging (SESSIONS KV)
];

const constantCase = (kebab) => kebab.toUpperCase().replaceAll('-', '_');

function renameTemplateRefs(text, name, display) {
  // Kebab + display via split/join (literal insert, so a `$` in --display isn't a special
  // pattern). The SCREAMING_SNAKE prefix is renamed via a negative-lookahead replace that
  // leaves it alone where it begins a deliberately-shared secret name
  // (PAVED_ROAD_ALERT_WEBHOOK_URL stays put). SHARED_SECRET_NAMES are SCREAMING_SNAKE ids
  // (no regex metacharacters). The kit's repository name is split out first and put back
  // unchanged. Mirror of src/platform/bootstrap.ts.
  const sharedSuffixes = SHARED_SECRET_NAMES.map((n) => n.slice(TEMPLATE_CONSTANT.length));
  const constantRe = new RegExp(
    TEMPLATE_CONSTANT + (sharedSuffixes.length ? `(?!${sharedSuffixes.join('|')})` : ''),
    'g',
  );
  return text
    .split(KIT_REPOSITORY_RE)
    .map((part) =>
      part
        .split(TEMPLATE_KEBAB)
        .join(name)
        .split(TEMPLATE_DISPLAY)
        .join(display)
        .replace(constantRe, () => constantCase(name)),
    )
    .join(KIT_REPOSITORY);
}

function resetStagingResourceIds(text) {
  let d1 = 0;
  let kv = 0;
  const withD1 = text.replace(/("database_id"\s*:\s*)"[^"]*"/g, (_m, prefix) => {
    d1++;
    return `${prefix}"${PROVISION_PLACEHOLDER}"`;
  });
  // Bare KV `"id"` reset SCOPED to the kv_namespaces array (don't clobber a Hyperdrive/
  // Vectorize binding's own `"id"`). `[^\]]*` stops at the first `]`; runs on raw text, so a
  // `]` inside a comment in the array truncates the scope — fail-safe (a surviving template id
  // is caught by the drift guard / contamination check). KV ids are hex; template is comment-free.
  const withKv = withD1.replace(
    /("kv_namespaces"\s*:\s*\[)([^\]]*)(\])/,
    (_m, open, inner, close) => {
      const reset = inner.replace(/("id"\s*:\s*)"[^"]*"/g, (_x, prefix) => {
        kv++;
        return `${prefix}"${PROVISION_PLACEHOLDER}"`;
      });
      return `${open}${reset}${close}`;
    },
  );
  return { text: withKv, resetD1: d1 > 0, resetKv: kv > 0, resetCount: d1 + kv };
}

function stripJsoncComments(text) {
  let out = '';
  let inStr = false;
  let esc = false;
  let line = false;
  let block = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const n = text[i + 1];
    if (line) {
      if (c === '\n') {
        line = false;
        out += c;
      }
    } else if (block) {
      if (c === '*' && n === '/') {
        block = false;
        i++;
      }
    } else if (inStr) {
      out += c;
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') {
      inStr = true;
      out += c;
    } else if (c === '/' && n === '/') {
      line = true;
      i++;
    } else if (c === '/' && n === '*') {
      block = true;
      i++;
    } else {
      out += c;
    }
  }
  return out;
}

function parseJsonc(text) {
  try {
    // A leading BOM is stripped first: wrangler's own parser accepts BOM'd configs, and a gate
    // stricter than the tool it guards manufactures false reds on files the tool honours.
    return JSON.parse(stripJsoncComments(text.replace(/^\uFEFF/, '')));
  } catch {
    return null;
  }
}

function stagingIdsArePlaceholders(configText) {
  const config = parseJsonc(configText);
  if (!config) return false;
  // Array.isArray, not `?? []`: a malformed-but-parseable slot (object/string) must fail
  // CLOSED (→ false), not throw `.map`.
  const slots = (v) => (Array.isArray(v) ? v : []);
  const d1 = slots(config.d1_databases).map((db) => db.database_id);
  const kv = slots(config.kv_namespaces).map((ns) => ns.id);
  if (d1.length === 0 || kv.length === 0) return false;
  return [...d1, ...kv].every((id) => id === PROVISION_PLACEHOLDER);
}

function contaminatingTemplateIds(text) {
  return TEMPLATE_STAGING_IDS.filter((id) => text.includes(id));
}

// Mirror of SELF_REFERENCE_FILES in src/platform/bootstrap.ts — keep in sync. `version.ts` names
// the KIT the fork synced from (like CLAUDE.md/CHANGELOG.md), a legitimate self-reference.
// new-app.test.mjs checks this copy EQUALS the canonical literal, and both tests check every entry
// the kit needs is present; a fork may add its own entries to both. Two entries name files the kit
// does not have: the DB Israel release caller, which only a DB Israel app has, and the
// central-proposal script, which a later version adds. See bootstrap.ts.
const SELF_REFERENCE_FILES = new Set([
  'CLAUDE.md',
  'CHANGELOG.md',
  'GUIDEBOOK.md',
  '.github/workflows/il-paved-road-release.yml',
  'scripts/new-app.mjs',
  'scripts/check-agent-guidance-sync.mjs',
  'scripts/central-proposal.mjs',
  'scripts/deployment-target.mjs',
  'src/framework/version.ts',
  'src/platform/bootstrap.ts',
  'test/auth/interstitial.test.ts',
  'test/platform/naming.test.ts',
  'test/platform/bootstrap.test.ts',
  'test/platform/new-app.test.mjs',
  'test/platform/provision.test.mjs',
  'test/platform/agent-guidance-sync.test.mjs',
]);
// tools/ = platform-maintainer content (the cf-provisioning Bruno collection) that
// legitimately names PAVED_ROAD_* fleet-shared secrets — found tripping a fork's
// residual scan during the 0.2.0 rollout (invisible on the template: the scan is
// inert here by design).
const SELF_REFERENCE_PREFIXES = ['docs/', '.claude/', '.cursor/', 'tools/'];

function isTemplateSelfReference(path) {
  const p = path.replace(/^\.\//, '');
  return SELF_REFERENCE_FILES.has(p) || SELF_REFERENCE_PREFIXES.some((dir) => p.startsWith(dir));
}

function residualTemplateRefs(files) {
  return files
    .filter((f) => {
      if (isTemplateSelfReference(f.path)) return false;
      // The kit's repository name is a shared name, never a residual.
      const content = f.content.split(KIT_REPOSITORY_RE).join('');
      if (content.includes(TEMPLATE_KEBAB)) return true;
      // Ignore the deliberately-shared secret names before the SCREAMING_SNAKE check.
      const withoutShared = SHARED_SECRET_NAMES.reduce(
        (c, shared) => c.split(shared).join(''),
        content,
      );
      return withoutShared.includes(TEMPLATE_CONSTANT);
    })
    .map((f) => f.path)
    .sort();
}
// ── end mirror ─────────────────────────────────────────────────────────────────────────

const STAGING_CONFIG = 'wrangler.staging.jsonc';
const RESOURCES_MANIFEST = 'docs/RESOURCES.md';

// Files that carry the app identity. Deliberately explicit — no blind repo-wide sed.
// The tripwire below is the backstop: if a new identity-bearing file shows up and isn't
// listed here (and isn't a kit self-reference), the bootstrap fails loudly.
//
// Most of these are files /kit-upgrade does not carry (package.json, the wrangler configs, web/,
// the identity migration), renamed once, here. The carried ones (schema.sql, the four CIAL
// workflows, CLAUDE.md and four test files) need the app's own identity in their structure: a
// deploy name, the staging host, the app name a test or the app_identity seed reads. The kit's
// bytes bring the template name back with each upgrade, and the fork re-localizes them
// (/kit-upgrade step 4, trap T2). So that set stays small: a carried file that names the
// template only in passing (a comment, a fixture) is made neutral instead, never listed here.
// test/platform/new-app.test.mjs pins the carried set.
const FILES = [
  'package.json',
  // schema.sql seeds the app_identity row with the app name (the cross-app D1 backstop,
  // DECISIONS 2026-08-18), so it renames like any other identifier-carrying file.
  'schema.sql',
  // Same app_identity seed as schema.sql, for databases that predate the baseline change.
  'migrations/d1/0000_kit_app_identity.sql',
  'package-lock.json',
  'wrangler.jsonc',
  'wrangler.staging.jsonc',
  'wrangler.test.jsonc',
  // The minimal Workers test config (vitest.config.ts) names its test resources like the full one.
  'test/runtime/wrangler.test-minimal.jsonc',
  '.github/workflows/ci.yml',
  '.github/workflows/deploy-prod.yml',
  '.github/workflows/provision-staging.yml',
  '.github/workflows/provision-production.yml',
  'web/index.html',
  'web/src/App.tsx',
  'web/src/Login.tsx',
  'test/helpers/http.ts',
  'test/health.test.ts',
  'test/cron/cron.test.ts',
  'test/ai/anthropic.test.ts',
  'CLAUDE.md',
];

// Dirs the residual scan skips entirely (build output, vcs, deps). `.git` also covers
// `.git/worktrees`; we deliberately do NOT skip a bare `worktrees` name — an app may have
// its own source dir by that name, and the scan must still see into it. `.test-results` is
// generated test output (scripts/test-profile.mjs): coverage and local `npm run ci` write it
// before verify:bootstrap runs, and Vitest's raw report there quotes every test title and
// absolute path, kit tests that name the template among them.
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'coverage',
  '.wrangler',
  '.test-results',
]);
const SKIP_EXT = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.ico',
  '.webp',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
  '.pdf',
  '.zip',
  '.gz',
]);

// Walk the working tree, returning { path, content } for every readable text file.
// Paths are repo-relative with forward slashes so they match isTemplateSelfReference.
function collectRepoFiles(root = '.') {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = dir === '.' ? entry.name : `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(rel);
        continue;
      }
      if (!entry.isFile()) continue;
      const dot = entry.name.lastIndexOf('.');
      if (dot >= 0 && SKIP_EXT.has(entry.name.slice(dot).toLowerCase())) continue;
      try {
        out.push({ path: rel, content: readFileSync(rel, 'utf8') });
      } catch {
        // unreadable/binary — can't carry the kebab token as text anyway
      }
    }
  };
  walk(root);
  return out;
}

function safeRead(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

// Is this repo still the template (vs a bootstrapped app)? The "is it contaminated by
// paved-road?" checks are vacuously true on the template (it legitimately IS paved-road
// everywhere), so --verify-only and the CI residual scan are inert here and live only on
// renamed apps. Reads the app identity from wrangler.jsonc (the prod config name).
function isTemplateRepo(root = '.') {
  const config = parseJsonc(safeRead(join(root, 'wrangler.jsonc')));
  return config?.name === TEMPLATE_KEBAB;
}

// The DURABLE half of the tripwire: residual identifiers + carried-over TEMPLATE ids.
// Deliberately does NOT run the pre-provision "ids must be placeholder" check — that
// false-positives the moment an app provisions its own (concrete) ids. This is the check
// that must be clean on a correctly-provisioned app (--verify-only) and in CI. One tree
// walk feeds both scans.
function verifyBootstrap() {
  const problems = [];
  // The bundled marketplace/plugin shell is handled by its own check below (with correct
  // remediation), so keep it out of the residual/contamination scans — its copies legitimately
  // carry `paved-road` until the bootstrap strips them.
  const files = collectRepoFiles().filter((f) => !isBundledPluginPath(f.path));

  // Plugin packaging must not survive into a scaffolded app (see stripPluginPackaging).
  const leftover = BUNDLED_PLUGIN_MARKERS.filter((m) => existsSync(m));
  if (leftover.length) {
    const list = leftover.map((m) => `      - ${m}`).join('\n');
    problems.push(
      `Marketplace/plugin packaging present in a bootstrapped app:
${list}
    The marketplace + plugin shell belong to the paved-road template repo, not a scaffolded app
    (their copies also carry unrenamed "paved-road" identifiers). Re-bootstrap via
    scripts/new-app.mjs (it strips them) or remove plugins/ + .claude-plugin/ by hand.`,
    );
  }

  const residual = residualTemplateRefs(files);
  if (residual.length) {
    const list = residual.map((p) => `      - ${p}`).join('\n');
    problems.push(
      `Residual template identifier ("${TEMPLATE_KEBAB}" or "${TEMPLATE_CONSTANT}_*" secret prefix) in ${residual.length} file(s):
${list}
    Fix, by kind of file:
      - A file /kit-upgrade carries that names the template only in passing (a comment, a
        test fixture): make the mention neutral, or derive the value at runtime. FILES cannot
        fix it: FILES renames only at bootstrap, and the next upgrade brings the name back.
      - A carried file whose structure needs the app's own identity (a deploy name, a host,
        the app name a test reads): it belongs in FILES in scripts/new-app.mjs, and
        /kit-upgrade re-localizes it at each upgrade (step 4, trap T2).
      - A file the upgrade does not carry: add it to FILES.
      - A legitimate kit self-reference: the allowlist in src/platform/bootstrap.ts AND the
        mirror here.`,
    );
  }

  // Contamination: paved-road's OWN staging ids carried into ANY non-self-reference file
  // (usually wrangler.staging.jsonc, but a stray copy anywhere binds to the wrong resource).
  const contam = [];
  for (const f of files) {
    if (isTemplateSelfReference(f.path)) continue;
    for (const id of contaminatingTemplateIds(f.content)) contam.push(`${f.path}: ${id}`);
  }
  if (contam.length) {
    const list = contam.map((c) => `      - ${c}`).join('\n');
    problems.push(
      `Carried-over paved-road staging resource id(s) — D1/KV bind by id, so this app is
    pointed at the template's staging DB + session KV (cross-app data/session contamination):
${list}
    Bootstrap via this script (not a hand-rename) to reset them, then \`provision --env
    staging\` fills this app's real ids.`,
    );
  }
  return problems;
}

// Placeholder RESOURCES.md so a fresh app never ships paved-road's manifest + real ids.
// `npm run provision` regenerates the real table; until then the manifest must be inert.
function placeholderManifest(name) {
  return `# Resources — ${name}

> NOT YET GENERATED. Run \`npm run provision\` (or the **Provision staging** Actions
> workflow) to create this app's Cloudflare resources and regenerate this manifest with
> the real ids. This file is a security-attribution manifest — it must NEVER carry another
> app's resource ids, so the bootstrap stamps it back to this placeholder. Do not hand-edit.

This manifest exists so every resource on the shared Cloudflare account is attributable to
its app at a glance, including the things wrangler.jsonc cannot show (DNS, tokens, gateway
config, Entra URIs). \`scripts/provision.mjs\` regenerates it on every provision.
`;
}

// ── Plugin packaging — belongs to the marketplace repo, never a scaffolded app ──────────
// PR #87 makes this repo a Claude Code marketplace (.claude-plugin/marketplace.json) hosting a
// plugins/paved-road/ shell of byte-identical harness copies. `/paved-road:pave` excludes both
// when it scaffolds, but the GitHub "Use this template" → new-app.mjs path copies the WHOLE
// tree, so the bootstrap must strip them here too. Left in, every fresh app would ship a
// self-referential marketplace, a duplicated skill set, and a `verify:plugin` CI gate it can't
// satisfy — and the residual tripwire would fail the bootstrap on the unrenamed `paved-road`
// identifiers inside those copies. CLI-only bootstrap machinery (no bootstrap.ts mirror).
const PLUGIN_PACKAGING_DIRS = ['plugins', '.claude-plugin'];
const BUNDLED_PLUGIN_MARKERS = ['.claude-plugin/marketplace.json', 'plugins/paved-road'];

// True for a path inside the bundled marketplace/plugin shell, so the residual scan can skip it
// (the dedicated leftover check below owns it, with correct "remove it" guidance). Precise on
// purpose: an app's OWN future plugins/<something-else> is not matched.
function isBundledPluginPath(path) {
  const p = path.replace(/^\.\//, '');
  return (
    p === '.claude-plugin/marketplace.json' ||
    p.startsWith('.claude-plugin/') ||
    p === 'plugins/paved-road' ||
    p.startsWith('plugins/paved-road/')
  );
}

// Drop the verify:plugin script + its `npm run ci` reference from a scaffolded app's
// package.json. Pure + idempotent (a no-op once gone), so re-running the bootstrap is safe. The
// gate guards the plugin copies the app no longer carries — leaving it makes `npm run ci` fail
// on a missing sync script.
//
// The chain lookahead accepts a SPACE as well as the closing quote. It was `(?=")` alone, which
// silently assumed verify:plugin sat last in the `ci` chain: append any gate after it and the
// script line still went (that replace is position-free) while the chain reference stayed,
// scaffolding forks whose `npm run ci` died on `Missing script: "verify:plugin"`. Found when
// verify:deps was appended. The failure was invisible because the strip still logged success.
function dropPluginVerifyScript(pkgText) {
  return pkgText
    .replace(/ && npm run verify:plugin(?=[ "])/, '')
    .replace(/\n[ \t]*"verify:plugin":[ \t]*"[^"]*",/, '');
}

// The README's plugin-install pitch is marketplace-repo content — a scaffolded app shouldn't
// advertise how to install the plugin, and the block carries `paved-road` tokens (CialDNB/paved-road,
// the install ids) that would trip the residual tripwire. It's wrapped in these markers in README.md
// so the bootstrap removes exactly it, leaving the app's own README prose untouched.
const README_PLUGIN_START = '<!-- plugin-install:start -->';
const README_PLUGIN_END = '<!-- plugin-install:end -->';

// Remove the marker-delimited plugin-install block (inclusive) from README text, collapsing the
// surrounding blank lines to one. Pure + idempotent: returns the text unchanged when the markers
// are absent (already stripped, or an app that never had them).
function stripReadmePluginBlock(text) {
  const start = text.indexOf(README_PLUGIN_START);
  const end = text.indexOf(README_PLUGIN_END);
  if (start === -1 || end === -1 || end < start) return text;
  const head = text.slice(0, start).replace(/\s*$/, '');
  const tail = text.slice(end + README_PLUGIN_END.length).replace(/^\s*/, '');
  return tail ? `${head}\n\n${tail}` : `${head}\n`;
}

// Remove the marketplace/plugin shell from a scaffolded app + clean its package.json. Runs in
// the rename path only (main() calls it when bootstrapping a named app, never on the template).
// Idempotent: a no-op under `/paved-road:pave`, which already excludes both dirs.
function stripPluginPackaging(root = '.') {
  for (const dir of PLUGIN_PACKAGING_DIRS) {
    const dirPath = join(root, dir);
    if (existsSync(dirPath)) {
      rmSync(dirPath, { recursive: true, force: true });
      console.log(`removed plugin packaging: ${dir}/`);
    }
  }
  const pkgPath = join(root, 'package.json');
  const pkg = safeRead(pkgPath);
  if (pkg) {
    const next = dropPluginVerifyScript(pkg);
    if (next !== pkg) {
      writeFileSync(pkgPath, next);
      console.log('removed verify:plugin gate from package.json');
    }
  }
  const readmePath = join(root, 'README.md');
  const readme = safeRead(readmePath);
  if (readme) {
    const next = stripReadmePluginBlock(readme);
    if (next !== readme) {
      writeFileSync(readmePath, next);
      console.log('removed plugin-install block from README.md');
    }
  }
}

async function applyRename(
  name,
  display,
  { manifest = placeholderManifest, stamp = 'placeholder' } = {},
) {
  let changed = 0;
  const guidanceWasStamped = await agentGuidanceStamped();
  for (const file of FILES) {
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      console.warn(`skip (missing): ${file}`);
      continue;
    }
    let next = renameTemplateRefs(text, name, display);
    if (file === STAGING_CONFIG) {
      const reset = resetStagingResourceIds(next);
      if (!reset.resetD1 || !reset.resetKv) {
        console.error(
          `Could not reset staging ids in ${STAGING_CONFIG} (D1:${reset.resetD1} KV:${reset.resetKv}).
Its shape changed — update resetStagingResourceIds in src/platform/bootstrap.ts + the mirror.`,
        );
        process.exit(1);
      }
      next = reset.text;
    }
    if (next !== text) {
      writeFileSync(file, next);
      changed++;
      console.log(`renamed: ${file}`);
    }
  }
  // Stamp the resource manifest back to a placeholder (it lives under docs/, a kit
  // self-reference, so the rename loop never touches it — but a fresh app must not ship
  // paved-road's resource names + real staging ids).
  writeFileSync(RESOURCES_MANIFEST, manifest(name));
  console.log(`stamped ${stamp}: ${RESOURCES_MANIFEST}`);
  changed++;
  const guidance = await restampAgentGuidance('.', guidanceWasStamped);
  const { MANIFEST } = await agentGuidanceGuard();
  if (guidance === 'restamped') {
    console.log(`re-stamped: ${MANIFEST} (for the renamed CLAUDE.md)`);
    changed++;
  } else if (guidance === 'stale') {
    console.warn(
      `skip: ${MANIFEST} was already out of date before the rename; run \`npm run verify:agents\`.`,
    );
  }
  return changed;
}

// The rename rewrites CLAUDE.md, the canonical the agent-guidance guard (verify:agents) hashes, so
// without a re-stamp a new app's first CI run fails on the template's stale hash. The rename is
// mechanical, so the curated mirrors need no reconsidering, and the bootstrap re-stamps, but only
// when the template's stamp matched the template's CLAUDE.md. A stamp that was already stale
// stays stale, so verify:agents still reports the drift it was built to catch.
//
// The guard's own module is loaded only on this path: many gates import this file for parseJsonc
// and must not need the agent-guidance script to do so.
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const agentGuidanceGuard = () => import('./check-agent-guidance-sync.mjs');

/** Whether the agent-guidance manifest records the current bytes of its canonical. */
async function agentGuidanceStamped(root = '.') {
  const { readManifest } = await agentGuidanceGuard();
  try {
    const manifest = readManifest(root);
    const recorded = String(manifest.source?.sha256 ?? '')
      .trim()
      .toLowerCase();
    return recorded === sha256(readFileSync(join(root, manifest.source.path)));
  } catch {
    return false; // no manifest, an unreadable one, or no canonical: nothing to re-stamp
  }
}

/** After the rename: 'current' (nothing to do), 'restamped', or 'stale' (for verify:agents). */
async function restampAgentGuidance(root, wasStamped) {
  if (await agentGuidanceStamped(root)) return 'current';
  if (!wasStamped) return 'stale';
  const { stampManifest } = await agentGuidanceGuard();
  stampManifest(root);
  return 'restamped';
}

// The deployment-target reader (scripts/deployment-target.mjs), loaded on the bootstrap and verify
// paths only, like the agent-guidance guard: many gates import this file for parseJsonc, and the
// reader imports this file. An invalid deployment marker, or a sign of a DB Israel app with no
// marker, fails the bootstrap check: every CIAL provision and deploy path refuses such a tree, and
// this is where a PR sees it. A valid target passes once its own invariants hold
// (deploymentTargetProblems).
const deploymentTargetReader = () => import('./deployment-target.mjs');

/**
 * The reader's error for this tree, as a problem; then what its target requires. A DB Israel app
 * is held to its invariants (israelProblems). A CIAL app with a release caller is dual-delivered:
 * its caller's bytes and the enrollment-safety approximation. A CIAL app with no caller: nothing
 * more, as before.
 */
async function deploymentTargetProblems(root = '.') {
  const reader = await deploymentTargetReader();
  const resolution = reader.resolveDeploymentTarget({ root });
  if (resolution.error) return [resolution.error];
  if (resolution.target === 'dbisrael') return israelProblems(root, reader);
  if (lstatOrNull(join(root, reader.CALLER_PATH)) === null) return [];
  return [...callerProblems(root, reader, 'cial'), ...enrollmentProblems(root, reader)];
}

// ── The DB Israel target ─────────────────────────────────────────────────────────────────────
// The values a DB Israel app's wrangler configs get (set by key, so the output does not depend on
// which literals the template held), the checks verify:bootstrap adds for it, and the text of the
// files the bootstrap writes for it. DECISIONS 2026-10-27, "new-app DB Israel target".
const TARGET_NAMES = ['cial', 'dbisrael'];
// Central's app-name rule (catalog.ts APP_NAME): 3-32 characters.
const DB_ISRAEL_NAME = /^[a-z][a-z0-9-]{1,30}[a-z0-9]$/;
// The all-zero account id wrangler.test.jsonc already uses: no real account has it, so a raw
// `wrangler` command against a DB Israel app's config reaches none.
const ACCOUNT_SENTINEL = '0'.repeat(32);
// Central's placeholder sender until it sends mail (ILOPS-8950).
const PLACEHOLDER_SENDER = 'auth@invalid.example';
const israelStagingHost = (name) => `${name}.staging.dbisrael.ai`;
const PRODUCTION_CONFIG = 'wrangler.jsonc';
const ISRAEL_MARKER_TEXT = '{ "version": 1, "deploymentTarget": "dbisrael" }\n';
const ISRAEL_WRANGLER_HEADER = [
  '// Local development and tests only. DB Israel central delivery ignores this file; bindings, vars,',
  '// crons and hostnames come from the central catalog. See docs/CENTRAL-DELIVERY.md.',
  '',
].join('\n');
// Central's build prerequisites, mirrored from its deploy-app.yml at f7eba76 (the build job's
// toolchain and lockfile checks, APP_WRANGLER_MIN, and MIGRATION_NAME in
// src/delivery/migrations.ts). A mirror, labelled as one: central's run decides.
const CENTRAL_WRANGLER_MIN = [4, 125, 0];
const MIGRATION_NAME = /^[0-9]{4}_[a-z0-9_]+\.sql$/;
const REGISTRY = 'https://registry.npmjs.org/';

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** lstat, or null when nothing is there. */
function lstatOrNull(path) {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

/**
 * The structure of JSONC `text`, with offsets: { type, start, end, members | items }. A member is
 * { key, start (its key's), node, comma (the offset of the comma after it, or -1) }. Comments and
 * strings are skipped as the JSONC scanner above skips them. Throws on malformed input. It exists
 * so the DB Israel values are set by key while every comment stays where it is.
 */
function jsoncSpans(text) {
  let i = 0;
  const fail = (what) => {
    throw new Error(`${what} at offset ${i}`);
  };
  const skip = () => {
    for (;;) {
      while (i < text.length && /\s/.test(text[i])) i++;
      if (text.startsWith('//', i)) {
        const eol = text.indexOf('\n', i);
        i = eol === -1 ? text.length : eol;
      } else if (text.startsWith('/*', i)) {
        const close = text.indexOf('*/', i + 2);
        if (close === -1) fail('an unterminated comment');
        i = close + 2;
      } else return;
    }
  };
  const string = () => {
    const start = i;
    for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === '\\') i++;
    if (i >= text.length) fail('an unterminated string');
    i++;
    return { start, end: i, value: JSON.parse(text.slice(start, i)) };
  };
  const value = () => {
    skip();
    const start = i;
    if (text[i] === '{' || text[i] === '[') {
      const object = text[i] === '{';
      const close = object ? '}' : ']';
      const entries = [];
      i++;
      skip();
      while (text[i] !== close) {
        let entry;
        if (object) {
          if (text[i] !== '"') fail('a key expected');
          const key = string();
          skip();
          if (text[i] !== ':') fail('":" expected');
          i++;
          entry = { key: key.value, start: key.start, node: value(), comma: -1 };
        } else entry = { node: value(), comma: -1 };
        entries.push(entry);
        skip();
        if (text[i] === ',') {
          entry.comma = i;
          i++;
          skip();
        } else if (text[i] !== close) fail(`"," or "${close}" expected`);
      }
      i++;
      return object
        ? { type: 'object', start, end: i, members: entries }
        : { type: 'array', start, end: i, items: entries };
    }
    if (text[i] === '"') return { type: 'string', ...string() };
    const literal = /^(?:-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(text.slice(i));
    if (!literal) fail('a value expected');
    i += literal[0].length;
    return { type: 'literal', start, end: i };
  };
  const root = value();
  skip();
  if (i !== text.length) fail('trailing content');
  return root;
}

/** The member at `path` (object keys) in a jsoncSpans() tree, with its parent; or null. */
function jsoncMember(root, path) {
  let parent = root;
  let member = null;
  for (const key of path) {
    if (parent?.type !== 'object') return null;
    member = parent.members.find((m) => m.key === key) ?? null;
    if (!member) return null;
    if (key !== path.at(-1)) parent = member.node;
  }
  return member ? { member, parent } : null;
}

/** `text` with the value at `path` replaced by `value`, as JSON; unchanged when there is none. */
function setJsoncValue(text, path, value) {
  const found = jsoncMember(jsoncSpans(text), path);
  if (!found) return text;
  const { node } = found.member;
  return `${text.slice(0, node.start)}${JSON.stringify(value)}${text.slice(node.end)}`;
}

/**
 * `text` without the member at `path`. A member alone on its lines goes with those lines and with
 * the comment lines directly above it (they describe it), and two blank lines left side by side
 * become one. The last member takes the comma before it along.
 */
function removeJsoncMember(text, path) {
  const found = jsoncMember(jsoncSpans(text), path);
  if (!found) return text;
  const { member, parent } = found;
  const index = parent.members.indexOf(member);
  const before = member.comma === -1 && index > 0 ? parent.members[index - 1].comma : -1;
  let start = member.start;
  let end = member.comma === -1 ? member.node.end : member.comma + 1;
  const lineStart = text.lastIndexOf('\n', start - 1) + 1;
  const eol = text.indexOf('\n', end);
  const lineEnd = eol === -1 ? text.length : eol;
  if (text.slice(lineStart, start).trim() === '' && text.slice(end, lineEnd).trim() === '') {
    start = lineStart;
    while (start > 0) {
      const above = text.lastIndexOf('\n', start - 2) + 1;
      if (!/^\s*\/\//.test(text.slice(above, start - 1))) break;
      start = above;
    }
    end = eol === -1 ? text.length : eol + 1;
    const aboveStart = start > 0 ? text.lastIndexOf('\n', start - 2) + 1 : -1;
    const nextEol = text.indexOf('\n', end);
    const below = text.slice(end, nextEol === -1 ? text.length : nextEol);
    if (
      aboveStart !== -1 &&
      text.slice(aboveStart, start - 1).trim() === '' &&
      below.trim() === ''
    ) {
      end = nextEol === -1 ? text.length : nextEol + 1;
    }
  }
  if (before === -1) return `${text.slice(0, start)}${text.slice(end)}`;
  return `${text.slice(0, before)}${text.slice(before + 1, start)}${text.slice(end)}`;
}

/**
 * A wrangler config's text for a DB Israel app, set by key: the Israel header in place of the CIAL
 * one; the sentinel for `account_id` and for every Secrets Store id, in the commented examples too;
 * no `routes` (central owns the hostnames); DASHBOARD_HOST the staging host on staging and empty in
 * production; no CF_ACCOUNT_ID, AI gateway or alert address; central's placeholder sender.
 * Everything else stays, for local development and the app's own tests. Idempotent.
 */
function israelWranglerConfig(text, { name, staging }) {
  const open = text.search(/^\{/m);
  let next = open === -1 ? text : `${ISRAEL_WRANGLER_HEADER}${text.slice(open)}`;
  const config = parseJsonc(next);
  if (!isPlainObject(config)) throw new Error('not valid JSONC');
  const stores = (Array.isArray(config.secrets_store_secrets) ? config.secrets_store_secrets : [])
    .map((s) => s?.store_id)
    .filter((id) => typeof id === 'string' && id !== '' && id !== ACCOUNT_SENTINEL);
  for (const id of new Set(stores)) next = next.split(id).join(ACCOUNT_SENTINEL);
  next = setJsoncValue(next, ['account_id'], ACCOUNT_SENTINEL);
  next = removeJsoncMember(next, ['routes']);
  const vars = {
    DASHBOARD_HOST: staging ? israelStagingHost(name) : '',
    CF_ACCOUNT_ID: '',
    AI_GATEWAY_ID: '',
    MAIL_FROM: PLACEHOLDER_SENDER,
    ALERT_EMAIL: '',
  };
  for (const [key, value] of Object.entries(vars)) next = setJsoncValue(next, ['vars', key], value);
  return next;
}

/** docs/RESOURCES.md for a DB Israel app: its resources are central's, read back there. */
function israelManifest(name) {
  return `# Resources — ${name}

> DB Israel app, delivered centrally. Its central catalog entry (\`catalog/apps/${name}.json\`
> in CialDNB/il-paved-road-deployment) and the read-back receipts beside it are this app's
> resource record: its Worker, D1 database, KV namespace, hostnames and secrets are created and
> checked there, on the DB Israel Cloudflare account. This app creates nothing itself, and the CIAL
> provision paths refuse it. This file is a security-attribution manifest, so it must NEVER carry
> another app's resource ids. Do not hand-edit; see docs/CENTRAL-DELIVERY.md.
`;
}

/** docs/CENTRAL-DELIVERY.md, written for a DB Israel app only: the kit ships no such file. */
function centralDeliveryDoc(name, reader) {
  const host = israelStagingHost(name);
  const caller = reader.CALLER_PATH;
  return `# Central delivery — ${name}

This app is a **DB Israel application**. Its deployment target is \`dbisrael\`
(\`npm run deployment-target\`), and the central DB Israel pipeline,
\`CialDNB/il-paved-road-deployment\`, builds and releases it.

**It is not enrolled or deployed until the platform enrolls it.** Until then nothing is released,
and the release caller's comment about the workflow-path ruleset is not true yet.

- **Staging:** \`https://${host}\`. After enrollment, each merge to \`main\` releases
  it.
- **Production:** the **Promote to production** link on a staging release, once the platform
  enables production, after go-live sign-off (docs/GO-LIVE.md, "DB Israel apps").
- **Configuration:** the central catalog entry \`catalog/apps/${name}.json\` declares the Worker's
  bindings, variables, secrets, schedules and hostnames, and every release reads them back exactly.
  \`wrangler.jsonc\` and \`wrangler.staging.jsonc\` here are for local development and tests only;
  central delivery ignores them. A new schedule, resource, variable or secret is a catalog PR first
  (\`/add-job\`, "DB Israel apps").
- **The CIAL paths refuse this app:** \`npm run deploy\`, \`deploy:staging\`, \`provision\` and the
  remote \`db:*\` scripts stop, the Provision and Deploy production workflows refuse, and CI's
  \`deploy-staging\` skips.

## Two files to leave alone

- \`${caller}\`, the release caller. Central accepts it byte for byte (CRLF read as LF): never
  edit, reformat, wrap or delete it. After enrollment only an org admin can change a workflow file.
- \`${reader.MARKER_PATH}\`, the deployment marker. A target change is a reviewed migration, never an
  edit.

## Getting it live

1. Link or create the Linear project.
2. Push to \`CialDNB/<repo>\`, merge the bootstrap PR at once, and protect \`main\` (PR and CI).
3. Send the platform owner the identity block \`/new-app\` collected and the
   \`npm run central:proposal\` output, and ask for source access (both GitHub App installations)
   and the catalog PR.
4. The platform onboards the app (plan, apply, the resource receipt) and enrolls it (the rulesets,
   the audit of every ref, the secret grant). Until enrollment, the \`il-paved-road-release\` run on
   \`main\` is expected to be red.
5. Someone with DB Israel Cloudflare access sets each declared runtime secret's value on the
   receipt's Worker. Every release stops until then.
6. A platform operator runs \`seed-owner\` with the first owner's sign-in email.
7. From then on, each merge to \`main\` releases \`https://${host}\`.

## Don't create

- \`CLOUDFLARE_API_TOKEN\` or \`DEPLOY_ENABLED\` on this repository: they belong to the CIAL
  pipeline, and CI's deployment-target guard goes red on either;
- any \`IL_PAVEDROAD_*\` repository secret or variable: a repository secret shadows the
  organization's;
- \`production/*\` tags (the Promote link makes them);
- GitHub environments;
- a Worker secret the catalog does not declare (the release's read-back fails on it).

## Open decisions

\`npm run central:proposal\` prints the draft catalog entry and the owner's decisions: sign-in,
AI, email alerts, schedules, backups, optional Worker secrets, ingress and health, and Workers
invocation logs. It writes nothing.
`;
}

/**
 * The release caller at its path, for an app of `target`: absent (an error for a DB Israel app),
 * not a file, or not accepted. The fix depends on the target. A DB Israel app's bootstrap rerun
 * restores the caller and changes nothing else. A dual-delivered app (a `cial` marker) takes the
 * CIAL branch on a rerun, which resets its provisioned staging ids, re-stamps docs/RESOURCES.md
 * and never writes a caller, so its caller is restored by hand.
 */
function callerProblems(root, reader, target) {
  const path = reader.CALLER_PATH;
  const st = lstatOrNull(join(root, path));
  const fix =
    target === 'dbisrael'
      ? "Rerun the bootstrap with this app's name (node scripts/new-app.mjs <name>) to restore it; in an enrolled app, an org admin makes that change."
      : `This app is dual-delivered (a "cial" marker), so restore the caller by hand to CALLER_TEXT in scripts/deployment-target.mjs: node -e "import('./scripts/deployment-target.mjs').then((m) => process.stdout.write(m.CALLER_TEXT))" > ${path} (in an enrolled app, an org admin makes that change). Never rerun the bootstrap on this app: its CIAL branch resets the provisioned staging ids, re-stamps docs/RESOURCES.md and does not write the caller.`;
  if (st === null) {
    return target === 'dbisrael'
      ? [`There is no release caller at ${path}, and a DB Israel app needs it. ${fix}`]
      : [];
  }
  if (!st.isFile()) return [`${path} is not a regular file. ${fix}`];
  const text = readFileSync(join(root, path), 'utf8');
  if (reader.isAcceptedCaller(text)) return [];
  return [
    `${path} is not a caller the kit accepts (sha256 ${reader.callerSha256(text)}, CRLF read as LF). Central enrolls it byte for byte. ${fix}`,
  ];
}

/** The enrollment-safety approximation's findings, as one problem. */
function enrollmentProblems(root, reader) {
  const found = reader.repoEnrollmentProblems(root);
  if (found.length === 0) return [];
  return [
    `The workflows fail the kit's offline approximation of DB Israel enrollment (central's own audit decides, over every ref):\n${found.map((p) => `      - ${p}`).join('\n')}`,
  ];
}

/** "4.130.2" at or above [4, 125, 0], within the same major. */
function wranglerAtLeast(version, [major, minor, patch]) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(version));
  if (!m) return false;
  const [a, b, c] = m.slice(1).map(Number);
  return a === major && (b > minor || (b === minor && c >= patch));
}

/** Where a DB Israel tree breaks central's build prerequisites (a mirror); [] for none. */
function centralBuildProblems(root) {
  const found = [];
  const lockPath = join(root, 'package-lock.json');
  const lockStat = lstatOrNull(lockPath);
  if (lockStat === null || !lockStat.isFile())
    found.push('package-lock.json is missing or not a regular file');
  else {
    let lock = null;
    try {
      lock = JSON.parse(readFileSync(lockPath, 'utf8'));
    } catch {
      found.push('package-lock.json is not valid JSON');
    }
    if (lock) {
      if (lock.lockfileVersion !== 3) found.push('package-lock.json: lockfileVersion must be 3');
      const entries = [];
      for (const [key, entry] of Object.entries(lock.packages ?? {})) {
        if (key === '') continue;
        if (entry?.link) entries.push(`${key} is a linked package`);
        else if (typeof entry?.resolved !== 'string' || !entry.resolved.startsWith(REGISTRY)) {
          entries.push(`${key} does not resolve from ${REGISTRY}`);
        } else if (
          typeof entry.integrity !== 'string' ||
          !/^sha512-[A-Za-z0-9+/]+=*$/.test(entry.integrity)
        ) {
          entries.push(`${key} has no sha512 integrity`);
        }
      }
      for (const e of entries.slice(0, 5)) found.push(`package-lock.json: ${e}`);
      if (entries.length > 5)
        found.push(`package-lock.json: and ${entries.length - 5} more such entries`);
      const wrangler = lock.packages?.['node_modules/wrangler']?.version;
      if (!wranglerAtLeast(wrangler, CENTRAL_WRANGLER_MIN)) {
        found.push(
          `package-lock.json: the locked wrangler is ${wrangler ?? 'missing'}; central builds with a 4.x wrangler at ${CENTRAL_WRANGLER_MIN.join('.')} or later`,
        );
      }
    }
  }
  const npmrc = join(root, '.npmrc');
  const npmrcStat = lstatOrNull(npmrc);
  if (npmrcStat !== null) {
    if (!npmrcStat.isFile()) found.push('.npmrc must be a regular file');
    else {
      for (const line of readFileSync(npmrc, 'utf8').split(/\r?\n/)) {
        const t = line.trim();
        if (t !== '' && !t.startsWith('#') && t !== 'min-release-age=1') {
          found.push(
            `.npmrc: ${JSON.stringify(t)} is outside what central allows (comments, blank lines and min-release-age=1)`,
          );
        }
      }
    }
  }
  const staging = parseJsonc(safeRead(join(root, STAGING_CONFIG)));
  const d1 = Array.isArray(staging?.d1_databases) ? staging.d1_databases : [];
  if (d1.length > 0) {
    const dir = String(d1[0]?.migrations_dir ?? 'migrations');
    let names = [];
    try {
      names = readdirSync(join(root, dir)).filter((n) => n.endsWith('.sql'));
    } catch {
      found.push(`${dir}: no migrations directory`);
    }
    for (const n of names.filter((x) => !MIGRATION_NAME.test(x))) {
      found.push(`${dir}/${n}: a migration name outside ${MIGRATION_NAME}`);
    }
    if (names.length === 0 && existsSync(join(root, dir))) found.push(`${dir}: no migrations`);
  }
  let pkg = null;
  try {
    pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  } catch {
    // reported as the missing script
  }
  if (typeof pkg?.scripts?.['build:web'] !== 'string')
    found.push('package.json has no "build:web" script');
  if (!existsSync(join(root, 'src', 'index.ts'))) found.push('src/index.ts is missing');
  if (found.length === 0) return [];
  return [
    `Central's build would refuse this DB Israel app (a mirror of its deploy-app.yml checks at f7eba76; central's run decides):\n${found.map((p) => `      - ${p}`).join('\n')}`,
  ];
}

/**
 * The provider ids a DB Israel app's wrangler configs must not hold, and the sentinel account they
 * must name; [] for none. Each config names the sentinel at its top level: a config with no
 * account_id leaves a raw wrangler command to the account of whoever is logged in, a CIAL login
 * included. An env block may leave it out (wrangler then takes the top level's), and when it sets
 * one, it is the sentinel.
 */
function israelConfigProblems(root) {
  const found = [];
  for (const file of [PRODUCTION_CONFIG, STAGING_CONFIG]) {
    const text = safeRead(join(root, file));
    const config = parseJsonc(text);
    if (!isPlainObject(config)) {
      found.push(`${file} is missing or not valid JSONC`);
      continue;
    }
    const blocks = [['', config]];
    if (isPlainObject(config.env)) {
      for (const [env, block] of Object.entries(config.env)) blocks.push([`env.${env}.`, block]);
    }
    for (const [at, block] of blocks) {
      if (!isPlainObject(block)) continue;
      if (block.account_id === undefined) {
        if (at === '') found.push(`${file}: account_id (missing)`);
      } else if (block.account_id !== ACCOUNT_SENTINEL) {
        found.push(`${file}: ${at}account_id`);
      }
      const stores = Array.isArray(block.secrets_store_secrets) ? block.secrets_store_secrets : [];
      stores.forEach((s, i) => {
        if (s?.store_id !== ACCOUNT_SENTINEL)
          found.push(`${file}: ${at}secrets_store_secrets[${i}].store_id`);
      });
      const account = block.vars?.CF_ACCOUNT_ID;
      if (account !== undefined && account !== '' && account !== ACCOUNT_SENTINEL) {
        found.push(`${file}: ${at}vars.CF_ACCOUNT_ID`);
      }
    }
  }
  if (found.length === 0) return [];
  return [
    `A DB Israel app's wrangler configs name no real Cloudflare account or Secrets Store: central delivery ignores them, and the sentinel account keeps a raw wrangler command from reaching a real one. Set each of these to ${ACCOUNT_SENTINEL} (the variable may also be ""):\n${found.map((p) => `      - ${p}`).join('\n')}`,
  ];
}

// The CIAL platform tooling the DB Israel bootstrap removes with tools/: the provisioning collection
// (the CIAL account, zone and store ids, per-app token minting) and a deployable CIAL-account
// Worker. Only these two are checked: an app may keep tooling of its own under tools/.
const CIAL_TOOLING = ['tools/bruno/cf-provisioning', 'tools/secrets-migrator'];

/** The CIAL platform tooling present in a DB Israel tree, as one problem; [] for none. */
function cialToolingProblems(root) {
  const found = CIAL_TOOLING.filter((path) => lstatOrNull(join(root, path)) !== null);
  if (found.length === 0) return [];
  return [
    `CIAL platform tooling in a DB Israel app, which the bootstrap removes (it names the CIAL account and deploys to it):\n${found.map((p) => `      - ${p}`).join('\n')}\n    Remove it.`,
  ];
}

/** Everything verify:bootstrap requires of a DB Israel app, as problems; [] for none. */
function israelProblems(root, reader) {
  const problems = [...callerProblems(root, reader, 'dbisrael')];
  if (lstatOrNull(join(root, reader.LEGACY_CALLER_PATH)) !== null) {
    problems.push(
      `${reader.LEGACY_CALLER_PATH} is the legacy release caller; a DB Israel app has only ${reader.CALLER_PATH}. Remove it (an org admin, in an enrolled app).`,
    );
  }
  return [
    ...problems,
    ...enrollmentProblems(root, reader),
    ...israelConfigProblems(root),
    ...cialToolingProblems(root),
    ...centralBuildProblems(root),
  ];
}

/**
 * What this run may do to the tree at `root`: { target } or { refusal }. The rows of the
 * tree-state table (DECISIONS 2026-10-27, "new-app DB Israel target"):
 *   - an invalid marker, or none beside a sign of a DB Israel app: refused, as by every guard;
 *   - the template: CIAL unless --target says otherwise; a marker already there only when
 *     --target names the same target (a rerun after a failed run);
 *   - a DB Israel app: a rerun keeps its target, under its own name; --target cial is refused;
 *   - a renamed CIAL app: as before, unless --target dbisrael, which is allowed only with no
 *     marker, under the same name, while neither wrangler config holds a provisioned id and
 *     docs/RESOURCES.md still holds the bootstrap's placeholder, in the working tree and in the
 *     git history (provisionedInHistory: a plain CIAL rerun resets the working tree's copies).
 */
function planBootstrap({ name, requested, reader, root = '.' }) {
  const unchanged = 'Nothing was changed.';
  const resolution = reader.resolveDeploymentTarget({ root, env: {} });
  if (resolution.error) return { refusal: `${resolution.error} ${unchanged}` };
  const marker = reader.readMarker(root);
  const current = marker.state === 'valid' ? marker.target : null;
  const migration = 'A deployment-target change is a reviewed migration, never a bootstrap rerun.';
  if (isTemplateRepo(root)) {
    if (current === null || requested === current)
      return { target: requested ?? current ?? 'cial' };
    return {
      refusal: `${reader.MARKER_PATH} already says "${current}", but this tree is still the template. Run the bootstrap with --target ${current} if that is this app's target (a rerun after a failed run); otherwise remove the marker. ${unchanged}`,
    };
  }
  const app = parseJsonc(safeRead(join(root, PRODUCTION_CONFIG)))?.name;
  const otherName = `This app is "${app}", not "${name}": a rerun takes the app's own name. ${unchanged}`;
  if (current === 'dbisrael') {
    if (requested === 'cial') {
      return {
        refusal: `This is a DB Israel app (${reader.MARKER_PATH} says "dbisrael"). ${migration} ${unchanged}`,
      };
    }
    if (name !== app) return { refusal: otherName };
    return { target: 'dbisrael' };
  }
  if (requested !== 'dbisrael') return { target: 'cial' };
  if (current === 'cial') {
    return {
      refusal: `${reader.MARKER_PATH} says "cial": the owner chose the CIAL target. ${migration} ${unchanged}`,
    };
  }
  if (name !== app) return { refusal: otherName };
  const convert = 'Converting an existing app to DB Israel is a separate, reviewed migration.';
  const placeholders = [PRODUCTION_CONFIG, STAGING_CONFIG].every((file) =>
    stagingIdsArePlaceholders(safeRead(join(root, file))),
  );
  if (!placeholders || safeRead(join(root, RESOURCES_MANIFEST)) !== placeholderManifest(app)) {
    return {
      refusal: `This app has CIAL resources (a provisioned id in a wrangler config, or a regenerated ${RESOURCES_MANIFEST}). ${convert} ${unchanged}`,
    };
  }
  // A plain CIAL rerun puts the placeholders back in the working tree, so the history decides too.
  const history = provisionedInHistory(root, app);
  if (history.error) {
    return {
      refusal: `This app may have CIAL resources: its git history cannot be read (${history.error}), and a rerun of the CIAL bootstrap resets the working tree's evidence. ${convert} ${unchanged}`,
    };
  }
  if (history.evidence) {
    return {
      refusal: `This app has CIAL resources: its git history holds ${history.evidence}. A rerun of the CIAL bootstrap resets the working tree, never the history. ${convert} ${unchanged}`,
    };
  }
  return { target: 'dbisrael' };
}

/**
 * Whether the git history of the tree at `root` shows the CIAL app `app` provisioned: a committed
 * wrangler config that is not the template's own (by its `name`) and holds a D1 or KV id other
 * than the placeholder, or a committed docs/RESOURCES.md titled for `app` that is not the
 * bootstrap's stamp. Provisioning commits both (/new-app step 3), and a rerun of the CIAL bootstrap
 * resets the working tree's copies, never the history. Every ref counts. The template's own
 * versions, kit staging ids included, are what a repository made with "Use this template" starts
 * from, and are no evidence.
 *
 * Returns {} (nothing found, or not a git repository), { evidence } with what was found, or
 * { error } when a repository is there and its history cannot be read in full. A tree inside
 * another repository's work tree with no .git of its own (a monorepo folder) reads that
 * repository's history; a .git here that git passes over (a corrupt one inside another
 * repository, one set bare, or one that links to nothing) is one whose history is not read, and
 * refuses. So does a shallow clone, whose log ends at its boundary.
 */
function provisionedInHistory(root, app) {
  // The repository at `root`, never one a leaked GIT_DIR or GIT_WORK_TREE points at.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
  );
  const git = (args, input) =>
    execFileSync('git', ['-C', root, ...args], {
      env,
      input,
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: 256 * 1024 * 1024,
    });
  // lstat, not exists: a .git that links to nothing (a volume not mounted) is still a .git here.
  const dotGit = lstatOrNull(join(root, '.git')) !== null;
  let inside;
  let cdup;
  let shallow;
  try {
    [inside, cdup, shallow] = git([
      'rev-parse',
      '--is-inside-work-tree',
      '--show-cdup',
      '--is-shallow-repository',
    ])
      .toString()
      .split(/\r?\n/);
  } catch (err) {
    // No git, or not a repository: nothing to read, unless a .git says there is one.
    if (!dotGit) return {};
    return { error: err?.code === 'ENOENT' ? 'git is not installed' : 'git rev-parse failed' };
  }
  // A .git here is this tree's repository only when git reads it as the top of a work tree.
  if (dotGit && (inside !== 'true' || cdup !== '')) {
    return { error: 'git does not use the .git here' };
  }
  if (inside !== 'true') return {};
  // A shallow clone's log stops at its boundary, and the provisioning commit may lie past it.
  if (shallow === 'true') {
    return { error: 'the clone is shallow; git fetch --unshallow fetches the rest' };
  }
  const files = [PRODUCTION_CONFIG, STAGING_CONFIG, RESOURCES_MANIFEST];
  const blobs = [];
  try {
    // Each commit's line, then the raw diff lines for the three files, with full blob ids.
    const log = git([
      'log',
      '--all',
      '--format=commit %H',
      '--raw',
      '--no-abbrev',
      '--no-renames',
      '--',
      ...files,
    ]);
    let commit = '';
    for (const line of log.toString().split('\n')) {
      if (line.startsWith('commit ')) commit = line.slice(7, 19);
      const raw = /^:\d+ \d+ [0-9a-f]+ ([0-9a-f]+) [A-Z]\d*\t(.+)$/.exec(line);
      if (!raw || /^0+$/.test(raw[1])) continue;
      const file = files.find((f) => raw[2] === f || raw[2].endsWith(`/${f}`));
      if (file) blobs.push({ id: raw[1], file, commit });
    }
    if (blobs.length === 0) return {};
    const out = git(['cat-file', '--batch'], `${blobs.map((b) => b.id).join('\n')}\n`);
    let at = 0;
    for (const blob of blobs) {
      const eol = out.indexOf(0x0a, at);
      const header = out.subarray(at, eol).toString().split(' ');
      if (header[1] !== 'blob') throw new Error(`${blob.id} is not a blob`);
      const size = Number(header[2]);
      blob.text = out.subarray(eol + 1, eol + 1 + size).toString('utf8');
      at = eol + 1 + size + 1;
    }
  } catch (err) {
    return { error: err?.code === 'ENOENT' ? 'git is not installed' : 'git log failed' };
  }
  const template = [TEMPLATE_KEBAB, `${TEMPLATE_KEBAB}-staging`];
  for (const { file, commit, text } of blobs) {
    if (file === RESOURCES_MANIFEST) {
      if (text.split('\n', 1)[0] === `# Resources — ${app}` && text !== placeholderManifest(app)) {
        return { evidence: `a regenerated ${file} (commit ${commit})` };
      }
    } else if (!template.includes(parseJsonc(text)?.name) && !stagingIdsArePlaceholders(text)) {
      return { evidence: `a provisioned id in ${file} (commit ${commit})` };
    }
  }
  return {};
}

/** The DB Israel branch of the bootstrap, after planBootstrap allowed it. */
async function bootstrapDbIsrael(name, display, reader) {
  let changed = 0;
  // The marker first, so a rerun (the plugin path's second run) keeps the target.
  if (reader.readMarker('.').state === 'missing') {
    mkdirSync(dirname(reader.MARKER_PATH), { recursive: true });
    writeFileSync(reader.MARKER_PATH, ISRAEL_MARKER_TEXT);
    console.log(`wrote the deployment marker: ${reader.MARKER_PATH} (dbisrael)`);
    changed++;
  }
  changed += await applyRename(name, display, { manifest: israelManifest, stamp: 'DB Israel' });
  stripPluginPackaging();
  // Central's caller, after the rename (which would rename its central names), byte for byte. A
  // caller the kit accepts already (a CRLF checkout, say) stays as it is.
  const callerStat = lstatOrNull(reader.CALLER_PATH);
  if (callerStat !== null && !callerStat.isFile()) {
    console.error(`${reader.CALLER_PATH} is not a regular file; remove it, then rerun.`);
    process.exit(1);
  }
  if (callerStat === null || !reader.isAcceptedCaller(readFileSync(reader.CALLER_PATH, 'utf8'))) {
    writeFileSync(reader.CALLER_PATH, reader.CALLER_TEXT);
    console.log(
      `${callerStat === null ? 'installed' : 'restored'} the release caller: ${reader.CALLER_PATH}`,
    );
    changed++;
  }
  for (const [file, staging] of [
    [PRODUCTION_CONFIG, false],
    [STAGING_CONFIG, true],
  ]) {
    const text = readFileSync(file, 'utf8');
    const next = israelWranglerConfig(text, { name, staging });
    if (next !== text) {
      writeFileSync(file, next);
      console.log(`set the DB Israel values: ${file}`);
      changed++;
    }
  }
  // Platform-maintainer content for the CIAL account: the provisioning collection (its account,
  // zone and store ids, and per-app token minting), a deployable CIAL-account Worker, and a README
  // for the CIAL account owner. Nothing tests or runs it in an app.
  if (existsSync('tools')) {
    rmSync('tools', { recursive: true, force: true });
    console.log('removed tools/ (CIAL platform tooling)');
    changed++;
  }
  const doc = centralDeliveryDoc(name, reader);
  if (safeRead(reader.CENTRAL_DELIVERY_DOC) !== doc) {
    writeFileSync(reader.CENTRAL_DELIVERY_DOC, doc);
    console.log(`wrote: ${reader.CENTRAL_DELIVERY_DOC}`);
    changed++;
  }

  const problems = [...verifyBootstrap(), ...(await deploymentTargetProblems())];
  if (!stagingIdsArePlaceholders(safeRead(STAGING_CONFIG))) {
    problems.push(
      `${STAGING_CONFIG} must carry placeholder staging ids ("${PROVISION_PLACEHOLDER}") after
    bootstrap. The rename should have reset them — re-run this script.`,
    );
  }
  if (problems.length) failVerification(problems);

  console.log(`\n"${display}" (${name}), a DB Israel app — ${changed} files updated.`);
  console.log(
    'Verified: the deployment marker, the release caller central accepts, the DB Israel config values; no residual template refs.',
  );
  if (!process.env.CI) tagRepoTopic();

  const host = israelStagingHost(name);
  console.log(`
Identity for the catalog PR (the /new-app skill fills in what this script cannot know):
  catalog app name   ${name}  (= APP_NAME, and the app_identity row schema.sql seeds)
  display name       ${display}
  repository         CialDNB/<repo>  (CialDNB/${name} unless it has another name)
  repository id      once it exists: gh api repos/CialDNB/<repo> --jq .id
  branch             main
  first owner        <the sign-in email of the person seed-owner makes the first owner>
  data sensitivity   <the answer to /new-app's data question>
  Linear project     <the project's URL>

Next (the /new-app skill walks you through all of this; docs/CENTRAL-DELIVERY.md keeps it):
  1. Link or create the Linear project for this app
  2. Push to CialDNB/<repo>, merge this bootstrap PR at once, and protect main (PR and CI)
  3. Send the platform owner the identity block above and the \`npm run central:proposal\` output;
     ask for source access (both GitHub App installations) and the catalog PR
  4. The platform onboards the app (plan, apply, the resource receipt) and enrolls it (rulesets,
     the audit of every ref, the secret grant). Until enrollment, the ${reader.CALLER_PATH.split(
       '/',
     )
       .at(-1)
       .replace(/\.yml$/, '')}
     run on main is expected to be red.
  5. Someone with DB Israel Cloudflare access sets each declared runtime secret on the receipt's
     Worker; every release stops until then
  6. A platform operator runs seed-owner with the first owner's sign-in email
  7. Then each merge to main releases https://${host}; production goes through
     the Promote to production link, once the platform enables it

Don't create: CLOUDFLARE_API_TOKEN or DEPLOY_ENABLED; any IL_PAVEDROAD_* repository secret or
variable (a repository secret shadows the organization's); production/* tags; GitHub environments;
a Worker secret the catalog does not declare.

Registration proposal (\`npm run central:proposal\` prints it again):`);
  const { buildProposal, formatProposal } = await import('./central-proposal.mjs');
  process.stdout.write(formatProposal(buildProposal({ root: '.' })));
}

function failVerification(problems) {
  console.error(`\nBootstrap verification FAILED:\n\n  • ${problems.join('\n\n  • ')}\n`);
  process.exit(1);
}

// Tag the current repo with the `paved-road` topic so every kit app is discoverable via
// `topic:paved-road`. Best-effort: rename + verify already passed, so nothing here may
// fail the bootstrap. Resolve the repo first so the success log NAMES it (a mistarget is
// visible) and so we never tag the template itself; a short timeout keeps a stalled
// network call from hanging the one-time bootstrap. Idempotent — --add-topic is a no-op
// when the topic is already set.
function tagRepoTopic() {
  const GH_TIMEOUT_MS = 10_000;
  try {
    const repo = execFileSync(
      'gh',
      ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: GH_TIMEOUT_MS },
    ).trim();
    if (repo.endsWith(`/${TEMPLATE_KEBAB}`)) {
      console.warn(`skip: repo resolves to the template (${repo}) — not tagging it as an app.`);
      return;
    }
    execFileSync('gh', ['repo', 'edit', repo, '--add-topic', TEMPLATE_KEBAB], {
      stdio: 'pipe',
      timeout: GH_TIMEOUT_MS,
    });
    console.log(`tagged ${repo} with topic: ${TEMPLATE_KEBAB}`);
  } catch {
    console.warn(
      `skip: could not tag repo topic — once \`gh\` is authed, run:\n  gh repo edit --add-topic ${TEMPLATE_KEBAB}`,
    );
  }
}

const USAGE = `Usage: node scripts/new-app.mjs <app-name> [--display "Display Name"] [--target cial|dbisrael]
       node scripts/new-app.mjs --verify-only
app-name is kebab-case, 3-40 chars (e.g. "arena-go"); a DB Israel app's is 3-32 chars.
--target defaults to cial. Flags take "--flag value" or "--flag=value", in any order.`;

/**
 * The command line: { verifyOnly: true }, { name, display, target }, or { usage } with what is
 * wrong. An unknown flag, a missing value or an unknown target is an error, never ignored: a
 * mistyped --target must not make a CIAL app quietly. `display` and `target` are undefined when
 * not given.
 */
function parseBootstrapArgs(argv) {
  if (argv.includes('--verify-only')) {
    return argv.length === 1
      ? { verifyOnly: true }
      : { usage: '--verify-only takes no other argument' };
  }
  let name;
  let display;
  let target;
  const seen = new Set();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      if (name !== undefined) return { usage: `unexpected argument ${JSON.stringify(arg)}` };
      name = arg;
      continue;
    }
    const eq = arg.indexOf('=');
    const flag = eq === -1 ? arg : arg.slice(0, eq);
    if (flag !== '--display' && flag !== '--target') return { usage: `unknown flag ${flag}` };
    if (seen.has(flag)) return { usage: `${flag} is given twice` };
    seen.add(flag);
    const value = eq === -1 ? argv[++i] : arg.slice(eq + 1);
    if (value === undefined || value === '' || (eq === -1 && value.startsWith('--'))) {
      return { usage: `${flag} needs a value` };
    }
    if (flag === '--display') display = value;
    else if (!TARGET_NAMES.includes(value)) {
      return {
        usage: `--target must be ${TARGET_NAMES.join(' or ')} (got ${JSON.stringify(value)})`,
      };
    } else target = value;
  }
  if (name === undefined) return { usage: 'the app name is missing' };
  return { name, display, target };
}

function usageError(why) {
  console.error(`${why}\n${USAGE}`);
  process.exit(1);
}

async function main() {
  const parsed = parseBootstrapArgs(process.argv.slice(2));
  if (parsed.usage) usageError(parsed.usage);

  // Standalone re-check — useful after a hand-rename, after a /kit-upgrade, or to prove a
  // downstream app is clean. Runs ONLY the durable checks (residual refs + carried-over
  // template ids), NOT the pre-provision placeholder gate — so it is clean-exit on a
  // correctly-provisioned app. Inert on the template itself (those checks are vacuous when
  // the repo legitimately IS paved-road). This is exactly what the CI step runs. A DB Israel app,
  // and a CIAL app with a release caller, are also held to what their target requires
  // (deploymentTargetProblems).
  if (parsed.verifyOnly) {
    if (isTemplateRepo()) {
      console.log(
        'This repo is the template (paved-road) — bootstrap checks are vacuous here; nothing to verify.',
      );
      return;
    }
    const problems = [...verifyBootstrap(), ...(await deploymentTargetProblems())];
    if (problems.length) failVerification(problems);
    console.log(
      'Bootstrap verified: no residual template refs/secret prefixes; no carried-over template ids.',
    );
    return;
  }

  const { name, target: requested } = parsed;
  if (!/^[a-z][a-z0-9-]{1,38}[a-z0-9]$/.test(name) || name.includes('--')) {
    usageError(`app-name must be kebab-case, 3-40 chars (got ${JSON.stringify(name)}).`);
  }
  if (name === TEMPLATE_KEBAB) {
    console.error('Pick a real app name — "paved-road" is the template.');
    process.exit(1);
  }
  if (requested === 'dbisrael' && !DB_ISRAEL_NAME.test(name)) {
    usageError(`A DB Israel app name is 3-32 chars, central's rule (got ${name.length}).`);
  }
  const display =
    parsed.display ?? name.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

  // Every argument is valid; now what the tree allows. A refusal changes nothing.
  const reader = await deploymentTargetReader();
  const plan = planBootstrap({ name, requested, reader });
  if (plan.refusal) {
    console.error(plan.refusal);
    process.exit(1);
  }
  if (plan.target === 'dbisrael') {
    if (!DB_ISRAEL_NAME.test(name)) {
      usageError(`A DB Israel app name is 3-32 chars, central's rule (got ${name.length}).`);
    }
    await bootstrapDbIsrael(name, display, reader);
    return;
  }

  const changed = await applyRename(name, display);
  stripPluginPackaging();

  // Durable checks (residual + contamination) PLUS the pre-provision placeholder gate — the
  // latter is bootstrap-path-only: right after a rename the staging ids must be the
  // placeholder, before provisioning fills them. --verify-only deliberately omits it.
  const problems = [...verifyBootstrap(), ...(await deploymentTargetProblems())];
  if (!stagingIdsArePlaceholders(safeRead(STAGING_CONFIG))) {
    problems.push(
      `${STAGING_CONFIG} must carry placeholder staging ids ("${PROVISION_PLACEHOLDER}") after
    bootstrap, before provisioning. The rename should have reset them — re-run this script.`,
    );
  }
  if (problems.length) failVerification(problems);

  console.log(`\n"${display}" (${name}) — ${changed} files updated.`);
  console.log('Verified: staging ids + per-app secret prefixes reset; no residual template refs.');

  // Repo identity isn't only files: tag the GitHub repo so every kit app is discoverable
  // org-wide (`topic:paved-road`). Skipped in CI — nothing to tag there, and GitHub
  // Actions sets CI=true.
  if (!process.env.CI) tagRepoTopic();

  console.log('\nNext (the /new-app skill walks you through all of this):');
  console.log('  1. Link or create the Linear project for this app');
  console.log(
    '  2. IT/platform owner sets repo secret CLOUDFLARE_API_TOKEN + variable DEPLOY_ENABLED=true',
  );
  console.log('  3. Run "Provision staging" (no laptop token), then commit the ids via PR:');
  console.log('       gh workflow run provision-staging.yml -f seed_owner_email=<you>');
  console.log(`  4. CI auto-deploys on merge — check https://staging-${name}.cialdnb.ai/_health`);
  console.log('  5. Invite yourself: see GUIDEBOOK.md "First login"');
}

// Exported for the mirror-parity pin (test/platform/new-app.test.mjs), which asserts these
// behave identically to src/platform/bootstrap.ts — making the "keep in sync" promise a
// mechanical CI check, not just discipline.
export {
  // The agent-guidance re-stamp after the rename (CLI-only, no bootstrap.ts mirror).
  agentGuidanceStamped,
  constantCase,
  contaminatingTemplateIds,
  // Plugin-packaging strip (CLI-only bootstrap machinery, no bootstrap.ts mirror) — exported
  // for test/platform/new-app.test.mjs.
  dropPluginVerifyScript,
  // The rename list, for the end-to-end bootstrap test (what the bootstrap may change).
  FILES,
  isBundledPluginPath,
  // Whether a tree is still the template; the end-to-end test skips itself outside it.
  isTemplateRepo,
  isTemplateSelfReference,
  KIT_REPOSITORY,
  // The provisioning sentinel + the JSONC comment scanner: exported so the wrangler-config
  // guards in check-edge-hardening.mjs reuse the canonical string-and-block-aware
  // implementation instead of hand-rolling a third comment parser.
  PROVISION_PLACEHOLDER,
  parseJsonc,
  // The bootstrap's docs/RESOURCES.md stamp, for the end-to-end test's plain-rename pin.
  placeholderManifest,
  renameTemplateRefs,
  resetStagingResourceIds,
  residualTemplateRefs,
  restampAgentGuidance,
  SELF_REFERENCE_FILES,
  SHARED_SECRET_NAMES,
  stagingIdsArePlaceholders,
  stripJsoncComments,
  stripPluginPackaging,
  stripReadmePluginBlock,
  TEMPLATE_CONSTANT,
  // The template's kebab identity. Exported so check-edge-hardening.mjs can ask "is this repo
  // still the unforked kit?" from the one JS copy of the constant instead of retyping it.
  TEMPLATE_KEBAB,
  TEMPLATE_STAGING_IDS,
};

// Run only as a CLI; importing the module (the pin test) must not rename anything. Not a top-level
// await: the verify paths import the deployment-target reader, which imports this module, and
// that import would wait for this module's own evaluation, which would wait for main(). Node then
// exits 13 on the unsettled await. An error still prints and exits 1.
if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

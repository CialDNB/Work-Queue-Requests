// Mechanical mirror-parity pin. scripts/new-app.mjs duplicates src/platform/bootstrap.ts in
// plain JS (node can't import the TS module); this asserts the .mjs copy obeys the SAME
// contract test/platform/bootstrap.test.ts pins for the TS canonical. Two tests pinning one
// contract → drift in EITHER copy fails CI, making the "keep in sync" promise mechanical
// rather than a comment. Run by `node --test` (it's .mjs, outside vitest's *.test.ts glob).
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { agentGuidanceDrift, stampManifest } from '../../scripts/check-agent-guidance-sync.mjs';
import {
  agentGuidanceStamped,
  constantCase,
  contaminatingTemplateIds,
  dropPluginVerifyScript,
  FILES,
  isBundledPluginPath,
  isTemplateRepo,
  isTemplateSelfReference,
  KIT_REPOSITORY,
  parseJsonc,
  renameTemplateRefs,
  resetStagingResourceIds,
  residualTemplateRefs,
  restampAgentGuidance,
  SELF_REFERENCE_FILES,
  SHARED_SECRET_NAMES,
  stagingIdsArePlaceholders,
  stripPluginPackaging,
  stripReadmePluginBlock,
  TEMPLATE_CONSTANT,
  TEMPLATE_KEBAB,
  TEMPLATE_STAGING_IDS,
} from '../../scripts/new-app.mjs';
import { RAW_REPORT_PATH, RESULTS_DIRECTORY } from '../../scripts/test-profile.mjs';

const PLACEHOLDER = 'PLACEHOLDER_RUN_PROVISION';
// The kit's own self-reference entries. Entries for files the kit has not shipped yet are harmless.
const KIT_SELF_REFERENCE_FILES = [
  '.github/workflows/il-paved-road-release.yml',
  'CHANGELOG.md',
  'CLAUDE.md',
  'GUIDEBOOK.md',
  'scripts/central-proposal.mjs',
  'scripts/check-agent-guidance-sync.mjs',
  'scripts/deployment-target.mjs',
  'scripts/new-app.mjs',
  'src/framework/version.ts',
  'src/platform/bootstrap.ts',
  'test/auth/interstitial.test.ts',
  'test/platform/agent-guidance-sync.test.mjs',
  'test/platform/bootstrap.test.ts',
  'test/platform/naming.test.ts',
  'test/platform/new-app.test.mjs',
  'test/platform/provision.test.mjs',
];

/**
 * The entries of the SELF_REFERENCE_FILES literal in `source`, sorted. It reads the literal as
 * code, up to its closing bracket: `//` and block comments are skipped, so a quote or an
 * apostrophe in a comment is prose, and an entry commented out is not an entry.
 */
function selfReferenceEntries(source) {
  const open = 'SELF_REFERENCE_FILES = new Set([';
  const start = source.indexOf(open);
  assert.notEqual(start, -1, 'the source must declare SELF_REFERENCE_FILES');
  const entries = [];
  for (let i = start + open.length; i < source.length; i++) {
    const c = source[i];
    if (c === ']') return entries.sort();
    if (c === '/' && source[i + 1] === '/') {
      const eol = source.indexOf('\n', i);
      i = eol === -1 ? source.length : eol;
    } else if (c === '/' && source[i + 1] === '*') {
      const close = source.indexOf('*/', i + 2);
      assert.notEqual(close, -1, 'an unterminated comment in SELF_REFERENCE_FILES');
      i = close + 1;
    } else if (c === "'" || c === '"') {
      const end = source.indexOf(c, i + 1);
      assert.notEqual(end, -1, 'an unterminated string in SELF_REFERENCE_FILES');
      entries.push(source.slice(i + 1, end));
      i = end;
    }
  }
  assert.fail('SELF_REFERENCE_FILES has no closing bracket');
}

/** The SELF_REFERENCE_FILES literal in src/platform/bootstrap.ts, sorted. */
function canonicalSelfReferenceFiles() {
  return selfReferenceEntries(
    readFileSync(join(import.meta.dirname, '..', '..', 'src/platform/bootstrap.ts'), 'utf8'),
  );
}
const STAGING_SAMPLE = `{
  "name": "paved-road-staging",
  "d1_databases": [{ "binding": "DB", "database_id": "358e2840-8dd7-45c4-b59d-18c48b10cb57" }],
  "kv_namespaces": [{ "binding": "SESSIONS", "id": "02ab99a8697840d79c0e04b2919d518e" }]
}`;

describe('new-app.mjs mirror parity', () => {
  it('constants + constantCase match the canonical', () => {
    assert.equal(TEMPLATE_CONSTANT, 'PAVED_ROAD');
    // The kebab identity is also what check-edge-hardening.mjs asks "is this still the kit?" with
    // (isUnforkedTemplate), so it is now load-bearing outside the bootstrap too.
    assert.equal(TEMPLATE_KEBAB, 'paved-road');
    assert.deepEqual(
      [...SHARED_SECRET_NAMES],
      [
        'PAVED_ROAD_ALERT_WEBHOOK_URL',
        'PAVED_ROAD_ENTRA_CLIENT_SECRET',
        'PAVED_ROAD_TURNSTILE_SECRET',
      ],
    );
    // The kit's own repository: neither renamed nor flagged, like the shared secret names.
    assert.equal(KIT_REPOSITORY, 'CialDNB/paved-road');
    assert.equal(constantCase('arena-go'), 'ARENA_GO');
    assert.equal(constantCase('docs-hub2'), 'DOCS_HUB2');
    assert.deepEqual([...TEMPLATE_STAGING_IDS].sort(), [
      '02ab99a8697840d79c0e04b2919d518e',
      '358e2840-8dd7-45c4-b59d-18c48b10cb57',
    ]);
  });

  it('renameTemplateRefs swaps kebab + display + per-app secret prefix, keeps the shared one', () => {
    assert.equal(
      renameTemplateRefs('paved-road / Paved Road', 'arena-go', 'Arena Go'),
      'arena-go / Arena Go',
    );
    assert.equal(
      renameTemplateRefs('Welcome to Paved Road', 'x-y', 'Spend $& $1 $$'),
      'Welcome to Spend $& $1 $$',
    );
    const secrets = renameTemplateRefs(
      '"PAVED_ROAD_ANTHROPIC_API_KEY" "PAVED_ROAD_AI_GATEWAY_TOKEN" "PAVED_ROAD_ALERT_WEBHOOK_URL" "PAVED_ROAD_ENTRA_CLIENT_SECRET" "PAVED_ROAD_TURNSTILE_SECRET"',
      'arena-go',
      'Arena Go',
    );
    assert.match(secrets, /ARENA_GO_ANTHROPIC_API_KEY/);
    assert.match(secrets, /ARENA_GO_AI_GATEWAY_TOKEN/);
    assert.match(secrets, /PAVED_ROAD_ALERT_WEBHOOK_URL/); // shared, kept
    assert.doesNotMatch(secrets, /ARENA_GO_ALERT_WEBHOOK_URL/);
    assert.match(secrets, /PAVED_ROAD_ENTRA_CLIENT_SECRET/); // shared, kept (one Entra registration)
    assert.doesNotMatch(secrets, /ARENA_GO_ENTRA_CLIENT_SECRET/);
    assert.match(secrets, /PAVED_ROAD_TURNSTILE_SECRET/); // shared, kept (one fleet-wide widget)
    assert.doesNotMatch(secrets, /ARENA_GO_TURNSTILE_SECRET/);
  });

  it("renameTemplateRefs keeps the kit's own repository name", () => {
    assert.equal(
      renameTemplateRefs(
        'pull from CialDNB/paved-road (see CialDNB/paved-road#256) into paved-road-db',
        'arena-go',
        'Arena Go',
      ),
      'pull from CialDNB/paved-road (see CialDNB/paved-road#256) into arena-go-db',
    );
  });

  it('resetStagingResourceIds resets D1 + KV ids, scoped to kv_namespaces', () => {
    const { text, resetCount } = resetStagingResourceIds(STAGING_SAMPLE);
    assert.equal(resetCount, 2);
    assert.doesNotMatch(text, /358e2840|02ab99a8/);
  });

  it('resetStagingResourceIds does NOT clobber an id outside kv_namespaces (Hyperdrive)', () => {
    const cfg = `{
      "d1_databases": [{ "database_id": "${PLACEHOLDER}" }],
      "kv_namespaces": [{ "binding": "SESSIONS", "id": "${PLACEHOLDER}" }],
      "hyperdrive": [{ "binding": "HD", "id": "keep-this-config-id" }]
    }`;
    assert.match(resetStagingResourceIds(cfg).text, /"id": "keep-this-config-id"/);
  });

  it('stagingIdsArePlaceholders is structural (key order independent)', () => {
    assert.equal(stagingIdsArePlaceholders(STAGING_SAMPLE), false);
    assert.equal(stagingIdsArePlaceholders(resetStagingResourceIds(STAGING_SAMPLE).text), true);
    assert.equal(
      stagingIdsArePlaceholders(
        `{ "d1_databases": [{ "database_id": "${PLACEHOLDER}" }], "kv_namespaces": [{ "id": "${PLACEHOLDER}", "binding": "SESSIONS" }] }`,
      ),
      true,
    );
    assert.equal(stagingIdsArePlaceholders('{}'), false);
    // Fail closed (not a throw) when a slot is the wrong type.
    assert.equal(stagingIdsArePlaceholders('{ "d1_databases": {}, "kv_namespaces": [] }'), false);
  });

  it('parseJsonc preserves `//` inside string values (no URL corruption)', () => {
    assert.equal(parseJsonc('{ "url": "https://a.b/c", "n": 1 }').url, 'https://a.b/c');
    assert.equal(parseJsonc('{ "a": 1 /* note */ } // tail').a, 1);
    assert.equal(parseJsonc('nope'), null);
  });

  it('contaminatingTemplateIds + residualTemplateRefs match the canonical', () => {
    assert.deepEqual(contaminatingTemplateIds(STAGING_SAMPLE).sort(), [
      '02ab99a8697840d79c0e04b2919d518e',
      '358e2840-8dd7-45c4-b59d-18c48b10cb57',
    ]);
    assert.deepEqual(
      residualTemplateRefs([
        { path: 'wrangler.jsonc', content: '"secret_name": "PAVED_ROAD_ANTHROPIC_API_KEY"' },
        {
          path: 'wrangler.staging.jsonc',
          content: '"secret_name": "PAVED_ROAD_ALERT_WEBHOOK_URL"',
        }, // shared, ok
        { path: 'src/platform/bootstrap.ts', content: 'PAVED_ROAD_ANTHROPIC_API_KEY' }, // self-ref
        { path: 'web/App.tsx', content: 'clean' },
      ]),
      ['wrangler.jsonc'],
    );
    // The kit's repository name is exempt, and only that exact name.
    assert.deepEqual(
      residualTemplateRefs([
        { path: 'scripts/kit-checks/checks.sync.json', content: '"source": "CialDNB/paved-road"' },
        { path: 'src/cron/digest.ts', content: '// Until CialDNB/paved-road#256 this list held…' },
        { path: 'scripts/sync.mjs', content: "'CialDNB/paved-road' or the paved-road-db name" },
        { path: 'scripts/fork.mjs', content: "'CialDNB/paved-road-fork'" },
      ]),
      ['scripts/fork.mjs', 'scripts/sync.mjs'],
    );
  });

  it('SELF_REFERENCE_FILES matches the canonical literal (pins this mirror to src/platform/bootstrap.ts)', () => {
    // Reads the TS canonical's literal (the Workers-pool test can't import this .mjs, nor this
    // test the .ts), so the two hand-duplicated copies must be EQUAL, whatever entries a fork adds
    // to both. The kit's own entries are pinned separately below, as a required subset.
    const canonical = canonicalSelfReferenceFiles();
    assert.ok(canonical.length >= KIT_SELF_REFERENCE_FILES.length, canonical.join(' '));
    assert.deepEqual([...SELF_REFERENCE_FILES].sort(), canonical);
  });

  // Forks comment their own entries, and a comment is prose: dnbnews' block reads "The binding
  // gate's own test asserts `isUnforkedTemplate({ name: '…' })`". Matching every quoted span
  // read two comment fragments as entries, so the parity check above failed on a fork that kept
  // its entries in both copies, as the CHANGELOG tells it to. So the literal is read as code.
  it('reads the literal as code: comments are skipped, whatever quotes they hold', () => {
    const fixture = (body) =>
      `const SELF_REFERENCE_FILES = new Set([\n${body}\n]);\nconst x = 'y';\n`;
    // A fork's commented entry, apostrophes and quoted text in the comment.
    assert.deepEqual(
      selfReferenceEntries(
        fixture(
          [
            "  'CLAUDE.md',",
            "  // The binding gate's own test asserts `isUnforkedTemplate({ name: 'x' })`, and the",
            "  // kit's scan is inert there.",
            "  'test/platform/edge-hardening.test.mjs',",
            "  /* a block comment, 'quoted', with a ]); in it */ 'scripts/sync-checks.mjs',",
            "  'src/platform/bootstrap.ts', // trailing: it's the canonical",
          ].join('\n'),
        ),
      ),
      [
        'CLAUDE.md',
        'scripts/sync-checks.mjs',
        'src/platform/bootstrap.ts',
        'test/platform/edge-hardening.test.mjs',
      ],
    );
    // An entry commented out is not in the Set, so it is not read as one: the .mjs mirror keeping
    // it live is drift.
    assert.deepEqual(selfReferenceEntries(fixture("  'CLAUDE.md',\n  // 'GUIDEBOOK.md',")), [
      'CLAUDE.md',
    ]);
    // The reader agrees with the JS engine on this repo's own mirror.
    assert.deepEqual(
      selfReferenceEntries(
        readFileSync(join(import.meta.dirname, '..', '..', 'scripts/new-app.mjs'), 'utf8'),
      ),
      [...SELF_REFERENCE_FILES].sort(),
    );
  });

  it('SELF_REFERENCE_FILES holds every entry the kit requires; a fork may add its own', () => {
    // test/platform/bootstrap.test.ts asserts the same subset for the TS canonical. An exact pin
    // turned every fork's test:scripts red on each kit allowlist change, until someone hand-edited
    // the fork's copy of this file.
    const missing = KIT_SELF_REFERENCE_FILES.filter((p) => !SELF_REFERENCE_FILES.has(p));
    assert.deepEqual(missing, []);
  });

  it('isTemplateSelfReference matches the canonical allowlist', () => {
    for (const p of [
      'docs/X.md',
      '.claude/y',
      '.cursor/rules/paved-road.mdc',
      'CLAUDE.md',
      'scripts/new-app.mjs',
      'scripts/check-agent-guidance-sync.mjs',
      'src/framework/version.ts',
      'test/auth/interstitial.test.ts',
      'test/platform/agent-guidance-sync.test.mjs',
      '.github/workflows/il-paved-road-release.yml',
      'scripts/deployment-target.mjs',
      'scripts/central-proposal.mjs',
    ]) {
      assert.equal(isTemplateSelfReference(p), true, p);
    }
    for (const p of [
      'wrangler.staging.jsonc',
      'package.json',
      'src/auth/interstitial.ts',
      'README.md',
    ]) {
      assert.equal(isTemplateSelfReference(p), false, p);
    }
  });
});

// Carried kit files the kit keeps NEUTRAL. verify:bootstrap's residual scan runs in every renamed
// fork, so a carried file that names the template turns that fork's CI red, and localizing it makes
// the copy diverge from the kit's blob for every later /kit-upgrade (trap T2). New carried files use
// `test-app` instead (P1's follow-ups; B9 review F8). This file rides /kit-upgrade too, so in an
// app it reads the app's copies, which stay neutral when taken whole. A fork may not have one at
// all (a trimmed workflow set without edge-live.yml, say): a file it does not have holds no
// residual, so outside the kit a missing one is left out. In the kit every one must exist. Add a
// carried file here when it is made neutral.
describe('carried kit files stay free of the template name', () => {
  const ROOT = join(import.meta.dirname, '..', '..');
  const NEUTRAL_CARRIED_FILES = [
    // B9 (machine routes)
    'src/cron/machineLiveness.ts',
    'src/framework/batchAudit.ts',
    'src/framework/machine.ts',
    'test/cron/machineLiveness.test.ts',
    'test/framework/batchAudit.test.ts',
    'test/framework/machine-routes.test.ts',
    'test/framework/machine.test.ts',
    // B10 (machine read attribution)
    'test/data/activity.test.ts',
    'test/framework/machine-read-attribution.test.ts',
    // The CIAL bootstrap repair: the carried files the residual scan listed on 2026-10-27.
    '.github/workflows/edge-live.yml',
    'scripts/kit-checks/checks.sync.json',
    'scripts/sync-checks.mjs',
    'src/cron/auditAnomalyDigest.ts',
    'src/cron/reportToRegistry.ts',
    'src/framework/readAudit.ts',
    'src/framework/scopedDb.ts',
    'test/ai/stream.test.ts',
    'test/auth/oidc.test.ts',
    'test/auth/permissions.test.ts',
    'test/auth/run-principal.test.ts',
    'test/auth/service-identity-routes.test.ts',
    'test/auth/service-namespace.test.ts',
    'test/auth/service-principals.test.ts',
    'test/cron/audit-watch.test.ts',
    'test/cron/edgeProbe.test.ts',
    'test/cron/serviceIdentityDigest.test.ts',
    'test/data/read-log.test.ts',
    'test/data/service-identities-migration.test.ts',
    'test/data/service-identities.test.ts',
    'test/framework/authz-denied.test.ts',
    'test/isolation/sensitive-actions.test.ts',
    'test/mcp/tools.test.ts',
    'test/platform/port-ui-scripts.test.mjs',
    'vitest.config.ts',
  ];

  it('the residual scan a renamed fork runs flags none of them', () => {
    const present = isTemplateRepo(ROOT)
      ? NEUTRAL_CARRIED_FILES
      : NEUTRAL_CARRIED_FILES.filter((path) => existsSync(join(ROOT, path)));
    const files = present.map((path) => ({
      path,
      content: readFileSync(join(ROOT, path), 'utf8'),
    }));
    assert.deepEqual(residualTemplateRefs(files), []);
  });
});

// FILES renames only at bootstrap. A carried file listed there gets the template name back with
// each /kit-upgrade, and the fork re-localizes it by hand (step 4, trap T2), so FILES holds a
// carried file only when its structure needs the app's own identity: the deploy names and staging
// host in the CIAL workflows, the app name the tests and the app_identity seed read, the working
// agreement's title. A carried file that names the template only in passing is made neutral
// instead (the describe above). Kit only: it reads the kit's /kit-upgrade diff set, and a fork's
// FILES has already done its work.
describe('FILES holds a carried file only when it needs the app identity', {
  skip: !isTemplateRepo(join(import.meta.dirname, '..', '..')) && 'kit only: this repo is renamed',
}, () => {
  const CARRIED_IDENTITY_FILES = [
    '.github/workflows/ci.yml',
    '.github/workflows/deploy-prod.yml',
    '.github/workflows/provision-production.yml',
    '.github/workflows/provision-staging.yml',
    'CLAUDE.md',
    'schema.sql',
    'test/ai/anthropic.test.ts',
    'test/cron/cron.test.ts',
    'test/health.test.ts',
    'test/helpers/http.ts',
  ];

  it('the entries /kit-upgrade carries are the known set', () => {
    const upgrade = readFileSync(
      join(import.meta.dirname, '..', '..', '.claude', 'skills', 'kit-upgrade', 'SKILL.md'),
      'utf8',
    );
    const diffSet = upgrade.match(/git diff HEAD kit\/main -- ([^`]+)`/)?.[1].split(/\s+/) ?? [];
    assert.ok(diffSet.length > 0, 'the /kit-upgrade skill names its diff set');
    const carried = FILES.filter((f) => diffSet.some((d) => f === d || f.startsWith(`${d}/`)));
    assert.deepEqual(
      carried.sort(),
      CARRIED_IDENTITY_FILES,
      'a carried file in FILES is re-localized by every fork at every upgrade: make it neutral, or add it here and to trap T2 in /kit-upgrade',
    );
  });
});

describe('bootstrap strips the marketplace/plugin packaging', () => {
  const PKG = `{
  "scripts": {
    "verify:agents": "node scripts/check-agent-guidance-sync.mjs",
    "verify:plugin": "node plugins/paved-road/sync-from-harness.mjs --check",
    "ci": "npm run verify:agents && npm run verify:plugin"
  }
}
`;

  const README = `# Some App

An intro paragraph.

<!-- plugin-install:start -->
<!-- stripped from scaffolded apps -->
**Want the harness elsewhere?** Install: CialDNB/paved-road (plugins/paved-road/README.md).
<!-- plugin-install:end -->

## Next section
`;

  it('dropPluginVerifyScript removes the script + its ci reference, idempotently', () => {
    const out = dropPluginVerifyScript(PKG);
    assert.doesNotMatch(out, /verify:plugin/);
    assert.equal(JSON.parse(out).scripts.ci, 'npm run verify:agents');
    assert.equal(dropPluginVerifyScript(out), out); // already clean → no-op
  });

  // Regression: the chain replace used to require verify:plugin be LAST (`(?=")`). Appending any
  // gate after it left the chain reference behind while the script line went, so a scaffolded
  // app's `npm run ci` died on `Missing script: "verify:plugin"` — and the strip still logged
  // success. The fixture above pins the tail position, so only a mid-chain case catches it.
  it('dropPluginVerifyScript strips the ci reference from the MIDDLE of the chain too', () => {
    const mid = PKG.replace(
      '"ci": "npm run verify:agents && npm run verify:plugin"',
      '"ci": "npm run verify:agents && npm run verify:plugin && npm run verify:deps"',
    );
    const out = dropPluginVerifyScript(mid);
    assert.doesNotMatch(out, /verify:plugin/);
    assert.equal(JSON.parse(out).scripts.ci, 'npm run verify:agents && npm run verify:deps');
  });

  // The fixture is a miniature; this pins the behaviour against the package.json that ships.
  it('leaves the REAL package.json with a ci chain that only calls scripts it still defines', () => {
    const real = readFileSync(new URL('../../package.json', import.meta.url), 'utf8');
    const { scripts } = JSON.parse(dropPluginVerifyScript(real));
    for (const ref of scripts.ci.matchAll(/npm run ([\w:-]+)/g)) {
      assert.ok(scripts[ref[1]], `ci calls "${ref[1]}", which the scaffolded package.json lacks`);
    }
  });

  it('isBundledPluginPath matches the shell, not an app-owned plugins dir', () => {
    for (const p of [
      '.claude-plugin/marketplace.json',
      'plugins/paved-road',
      'plugins/paved-road/skills/ship/SKILL.md',
    ]) {
      assert.equal(isBundledPluginPath(p), true, p);
    }
    for (const p of ['plugins/my-own-thing/x.ts', 'src/routes/notes.ts', 'package.json']) {
      assert.equal(isBundledPluginPath(p), false, p);
    }
  });

  it('stripReadmePluginBlock removes the marked block (inclusive), idempotently', () => {
    const out = stripReadmePluginBlock(README);
    assert.doesNotMatch(out, /paved-road/);
    assert.doesNotMatch(out, /plugin-install:(?:start|end)/);
    assert.match(out, /An intro paragraph\.\n\n## Next section/);
    assert.equal(stripReadmePluginBlock(out), out); // markers gone → no-op
  });

  it('stripPluginPackaging deletes the dirs + cleans package.json (idempotent)', () => {
    const root = mkdtempSync(join(tmpdir(), 'pr-strip-'));
    try {
      mkdirSync(join(root, 'plugins/paved-road/skills/ship'), { recursive: true });
      writeFileSync(join(root, 'plugins/paved-road/skills/ship/SKILL.md'), '# ship (paved-road)\n');
      mkdirSync(join(root, '.claude-plugin'), { recursive: true });
      writeFileSync(join(root, '.claude-plugin/marketplace.json'), '{ "name": "paved-road" }\n');
      writeFileSync(join(root, 'package.json'), PKG);
      writeFileSync(join(root, 'README.md'), README);

      stripPluginPackaging(root);

      assert.equal(existsSync(join(root, 'plugins')), false);
      assert.equal(existsSync(join(root, '.claude-plugin')), false);
      const pkg = readFileSync(join(root, 'package.json'), 'utf8');
      assert.doesNotMatch(pkg, /verify:plugin/);
      assert.equal(JSON.parse(pkg).scripts.ci, 'npm run verify:agents');
      const readme = readFileSync(join(root, 'README.md'), 'utf8');
      assert.doesNotMatch(readme, /paved-road/);
      assert.doesNotMatch(readme, /plugin-install:/);

      stripPluginPackaging(root); // no throw when already stripped
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// The rename rewrites CLAUDE.md, the canonical the agent-guidance guard (verify:agents) hashes, so
// a new app's first CI run went red on a stale stamp. The bootstrap re-stamps it, but only when the
// template's stamp was current: the rename is mechanical, so the mirrors need no reconsidering,
// while a stamp that was already stale must stay visible.
describe('the bootstrap re-stamps the agent-guidance manifest after renaming CLAUDE.md', () => {
  const CANON = '# Paved Road — working agreement\nbuilt on the paved road\n';
  const RENAMED = '# Arena Go — working agreement\nbuilt on the paved road\n';

  function guidanceFixture({ agentsAsSymlink = true } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'pr-guidance-'));
    mkdirSync(join(dir, 'docs'), { recursive: true });
    mkdirSync(join(dir, '.cursor', 'rules'), { recursive: true });
    writeFileSync(join(dir, 'CLAUDE.md'), CANON);
    writeFileSync(join(dir, '.cursor', 'rules', 'kit.mdc'), '# cursor rule\n');
    writeFileSync(join(dir, 'docs', 'PLAYBOOKS.md'), '# playbooks\n');
    if (agentsAsSymlink) symlinkSync('CLAUDE.md', join(dir, 'AGENTS.md'));
    else writeFileSync(join(dir, 'AGENTS.md'), CANON);
    writeFileSync(
      join(dir, 'docs', 'agent-guidance.sync.json'),
      `${JSON.stringify({
        source: { path: 'CLAUDE.md', sha256: '' },
        mirrors: [
          { path: 'AGENTS.md', equalsSource: true },
          { path: '.cursor/rules/kit.mdc' },
          { path: 'docs/PLAYBOOKS.md' },
        ],
      })}\n`,
    );
    stampManifest(dir);
    return dir;
  }

  for (const agentsAsSymlink of [true, false]) {
    it(`re-stamps a current stamp for the renamed canonical (AGENTS.md ${agentsAsSymlink ? 'symlink' : 'copy'})`, async () => {
      const dir = guidanceFixture({ agentsAsSymlink });
      try {
        const wasStamped = await agentGuidanceStamped(dir);
        assert.equal(wasStamped, true);
        writeFileSync(join(dir, 'CLAUDE.md'), RENAMED); // what the rename does
        assert.equal(agentGuidanceDrift(dir).length > 0, true); // the red first CI run
        assert.equal(await restampAgentGuidance(dir, wasStamped), 'restamped');
        assert.deepEqual(agentGuidanceDrift(dir), []);
        assert.equal(readFileSync(join(dir, 'AGENTS.md'), 'utf8'), RENAMED);
        // A rerun on the renamed tree has nothing to do.
        assert.equal(await restampAgentGuidance(dir, await agentGuidanceStamped(dir)), 'current');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  it('leaves a stamp that was already stale before the rename, so verify:agents still reports it', async () => {
    const dir = guidanceFixture();
    try {
      writeFileSync(join(dir, 'CLAUDE.md'), `${CANON}an edit nobody reconciled\n`);
      const wasStamped = await agentGuidanceStamped(dir);
      assert.equal(wasStamped, false);
      writeFileSync(join(dir, 'CLAUDE.md'), `${RENAMED}an edit nobody reconciled\n`);
      assert.equal(await restampAgentGuidance(dir, wasStamped), 'stale');
      assert.match(agentGuidanceDrift(dir).join('\n'), /CLAUDE\.md changed since/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('treats a missing or unreadable manifest as not stamped', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pr-guidance-none-'));
    try {
      assert.equal(await agentGuidanceStamped(dir), false);
      mkdirSync(join(dir, 'docs'));
      writeFileSync(join(dir, 'docs', 'agent-guidance.sync.json'), 'not json');
      assert.equal(await agentGuidanceStamped(dir), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the rename leaves the kit's functional names alone", () => {
  // CLAUDE.md is renamed at bootstrap, but `.paved-road/` (the kit's metadata dir that hooks,
  // /port-ui and adopt read) and `/paved-road:` (the plugin's command namespace) keep their names
  // in every app. Renamed, the working agreement contradicts its own tooling: it would send a
  // builder to `.<app>/design.json`, which no hook reads, and to a `/<app>:adopt` that is not
  // there.
  it('CLAUDE.md names neither, so its renamed copy cannot mislead', () => {
    const renamed = renameTemplateRefs(
      readFileSync(join(import.meta.dirname, '..', '..', 'CLAUDE.md'), 'utf8'),
      'talents-v2',
      'Talents V2',
    );
    assert.deepEqual(renamed.match(/\.talents-v2\/|\/talents-v2:/g), null);
  });
});

describe('the residual scan skips generated test output', () => {
  // Local `npm run ci` (and a fork's CI job that runs the suite before its gates) writes Vitest's
  // raw JSON report under .test-results/ BEFORE verify:bootstrap runs, and that report quotes
  // every test title and absolute path. Kit tests that are template self-references
  // (bootstrap.test.ts) name PAVED_ROAD_*, and a template clone's checkout path can contain
  // paved-road, so a renamed app would fail its own gate on the kit's test output. Inert on the
  // template, which is why the kit's CI stayed green.
  const NEW_APP = join(import.meta.dirname, '..', '..', 'scripts', 'new-app.mjs');
  const verify = (cwd) =>
    spawnSync(process.execPath, [NEW_APP, '--verify-only'], { cwd, encoding: 'utf8' });

  it('passes --verify-only with the report under .test-results/, and still flags the same text elsewhere', () => {
    const root = mkdtempSync(join(tmpdir(), 'pr-verify-results-'));
    try {
      writeFileSync(join(root, 'wrangler.jsonc'), '{ "name": "acme-app" }');
      const raw = JSON.stringify({
        testResults: [
          {
            name: `/home/runner/work/${TEMPLATE_KEBAB}/${TEMPLATE_KEBAB}/test/platform/bootstrap.test.ts`,
            assertionResults: [{ title: `keeps the shared ${TEMPLATE_CONSTANT}_ prefix` }],
          },
        ],
      });
      mkdirSync(join(root, RESULTS_DIRECTORY));
      writeFileSync(join(root, RAW_REPORT_PATH), raw);
      const clean = verify(root);
      assert.equal(clean.status, 0, clean.stderr);
      // Control: the scan is live in this tree, so the pass above is the skip, not a dead scan.
      mkdirSync(join(root, 'reports'));
      writeFileSync(join(root, 'reports', 'vitest.json'), raw);
      const flagged = verify(root);
      assert.equal(flagged.status, 1, flagged.stdout);
      assert.match(flagged.stderr, /- reports\/vitest\.json/);
      assert.doesNotMatch(flagged.stderr, /\.test-results/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

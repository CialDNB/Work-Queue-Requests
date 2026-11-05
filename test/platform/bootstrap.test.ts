// Pins the bootstrap rename + tripwire logic. scripts/new-app.mjs mirrors these functions
// in plain JS (node can't import this TS module); if the script drifts from what these
// tests assert, the bug that motivated this file (a hand-rename that left stale paved-road
// refs and carried the template's staging ids) can recur. See src/platform/bootstrap.ts.
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
  contaminatingTemplateIds,
  isTemplateSelfReference,
  KIT_REPOSITORY,
  PROVISION_PLACEHOLDER,
  parseJsonc,
  type RepoFile,
  renameTemplateRefs,
  resetStagingResourceIds,
  residualTemplateRefs,
  SELF_REFERENCE_FILES,
  SHARED_SECRET_NAMES,
  stagingIdsArePlaceholders,
  TEMPLATE_KEBAB,
  TEMPLATE_STAGING_IDS,
} from '../../src/platform/bootstrap';

// A representative slice of wrangler.staging.jsonc: the carried-over ids plus the other
// ids (account_id, store_id) that MUST survive the reset untouched.
const STAGING_SAMPLE = `{
  "name": "paved-road-staging",
  "account_id": "13878ca5057070dd0140af23d2d5508f",
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "paved-road-db-staging",
      "database_id": "358e2840-8dd7-45c4-b59d-18c48b10cb57"
    }
  ],
  "kv_namespaces": [{ "binding": "SESSIONS", "id": "02ab99a8697840d79c0e04b2919d518e" }],
  "secrets_store_secrets": [
    { "binding": "ANTHROPIC_API_KEY", "store_id": "dbed52d86420441baa29b42596b0477e" }
  ],
  "vars": { "AI_GATEWAY_ID": "all-pr-apps" }
}`;

describe('renameTemplateRefs', () => {
  it('swaps both the kebab and display identities', () => {
    const out = renameTemplateRefs(
      'paved-road-db-staging serves the Paved Road app at paved-road.cialdnb.ai',
      'arena-go',
      'Arena Go',
    );
    expect(out).toBe('arena-go-db-staging serves the Arena Go app at arena-go.cialdnb.ai');
    expect(out).not.toContain('paved-road');
  });

  it('leaves the space/concept form for prose to keep ("the paved road")', () => {
    // Narrative comments use the space form, which is a different string from the kebab.
    const out = renameTemplateRefs(
      '// every route stays on the paved road',
      'arena-go',
      'Arena Go',
    );
    expect(out).toBe('// every route stays on the paved road');
  });

  it('inserts a display name containing "$" literally (no replacement-pattern expansion)', () => {
    // replaceAll would read $&/$1/$$ in the replacement as special; split/join must not.
    const out = renameTemplateRefs('Welcome to Paved Road', 'spend-x', 'Spend $& Save $1 $$');
    expect(out).toBe('Welcome to Spend $& Save $1 $$');
  });

  it('leaves the fleet-shared AI Gateway id untouched — it is identical across every app', () => {
    // The gateway is FLEET-SHARED (`all-pr-apps`, DECISIONS 2026-08-28): per-app attribution
    // rides cf-aig-metadata, not the gateway id, so a fork must keep this exact value. The id
    // deliberately contains no `paved-road` token, so the rename has nothing to match — this
    // pins that property (an id like `paved-road-fleet` would silently become `arena-go-fleet`).
    const out = renameTemplateRefs('"AI_GATEWAY_ID": "all-pr-apps"', 'arena-go', 'Arena Go');
    expect(out).toBe('"AI_GATEWAY_ID": "all-pr-apps"');
  });

  it("keeps the kit's own repository name, like the shared secret names", () => {
    // Carried files name the kit as their upstream (sync-checks' canonical repo, an issue link).
    // An app built on the kit still syncs from the kit, so the slug is never renamed.
    const out = renameTemplateRefs(
      'pull from CialDNB/paved-road (see CialDNB/paved-road#256) into paved-road-db',
      'arena-go',
      'Arena Go',
    );
    expect(out).toBe('pull from CialDNB/paved-road (see CialDNB/paved-road#256) into arena-go-db');
  });

  it('renames the per-app SCREAMING_SNAKE secret prefix but leaves the shared secrets', () => {
    const out = renameTemplateRefs(
      '"PAVED_ROAD_ANTHROPIC_API_KEY" "PAVED_ROAD_AI_GATEWAY_TOKEN" "PAVED_ROAD_TURNSTILE_SECRET" "PAVED_ROAD_ALERT_WEBHOOK_URL"',
      'arena-go',
      'Arena Go',
    );
    expect(out).toContain('ARENA_GO_ANTHROPIC_API_KEY');
    expect(out).toContain('ARENA_GO_AI_GATEWAY_TOKEN');
    // The shared secrets are allowlisted: their PAVED_ROAD prefix survives, NOT renamed.
    expect(out).toContain('PAVED_ROAD_TURNSTILE_SECRET'); // one fleet-wide widget — shared, kept
    expect(out).not.toContain('ARENA_GO_TURNSTILE_SECRET');
    expect(out).toContain('PAVED_ROAD_ALERT_WEBHOOK_URL');
    expect(out).not.toContain('ARENA_GO_ALERT_WEBHOOK_URL');
    // No OTHER PAVED_ROAD token survives — strip the shared names, then assert none remain.
    const stripped = out
      .split('PAVED_ROAD_ALERT_WEBHOOK_URL')
      .join('')
      .split('PAVED_ROAD_TURNSTILE_SECRET')
      .join('');
    expect(stripped).not.toContain('PAVED_ROAD');
  });
});

describe('resetStagingResourceIds', () => {
  it('resets the staging D1 + SESSIONS ids to the provisioning placeholder', () => {
    const { text, resetD1, resetKv } = resetStagingResourceIds(STAGING_SAMPLE);
    expect(resetD1).toBe(true);
    expect(resetKv).toBe(true);
    expect(text).toContain(`"database_id": "${PROVISION_PLACEHOLDER}"`);
    expect(text).toContain(`"binding": "SESSIONS", "id": "${PROVISION_PLACEHOLDER}"`);
    // The concrete template ids are gone.
    expect(text).not.toContain('358e2840-8dd7-45c4-b59d-18c48b10cb57');
    expect(text).not.toContain('02ab99a8697840d79c0e04b2919d518e');
  });

  it('never touches account_id, store_id, the database_name label, or the fleet gateway id', () => {
    const { text } = resetStagingResourceIds(STAGING_SAMPLE);
    expect(text).toContain('"account_id": "13878ca5057070dd0140af23d2d5508f"');
    expect(text).toContain('"store_id": "dbed52d86420441baa29b42596b0477e"');
    expect(text).toContain('"database_name": "paved-road-db-staging"');
    expect(text).toContain('"AI_GATEWAY_ID": "all-pr-apps"');
  });

  it('resets EVERY staging id by structure — a 2nd D1 or the CACHE kv cannot survive', () => {
    // The old two-key reset (first database_id + the one SESSIONS id) left these behind.
    const multi = `{
      "d1_databases": [
        { "binding": "DB", "database_id": "tmpl-d1-one" },
        { "binding": "DB2", "database_id": "tmpl-d1-two" }
      ],
      "kv_namespaces": [
        { "binding": "SESSIONS", "id": "tmpl-kv-one" },
        { "binding": "CACHE", "id": "tmpl-kv-two" }
      ]
    }`;
    const { text, resetCount } = resetStagingResourceIds(multi);
    expect(resetCount).toBe(4);
    for (const stale of ['tmpl-d1-one', 'tmpl-d1-two', 'tmpl-kv-one', 'tmpl-kv-two']) {
      expect(text).not.toContain(stale);
    }
  });

  it('scopes the KV reset to kv_namespaces — a foreign binding "id" is left intact', () => {
    // A Hyperdrive/Vectorize binding an app adds has its own "id"; provision only refills
    // DB/SESSIONS, so blanking it would strand the binding. Must survive the reset.
    const withHyperdrive = `{
      "d1_databases": [{ "binding": "DB", "database_id": "358e2840" }],
      "kv_namespaces": [{ "binding": "SESSIONS", "id": "02ab99a8" }],
      "hyperdrive": [{ "binding": "HD", "id": "keep-this-config-id" }]
    }`;
    const { text, resetCount } = resetStagingResourceIds(withHyperdrive);
    expect(resetCount).toBe(2); // D1 + SESSIONS only
    expect(text).toContain('"id": "keep-this-config-id"');
    expect(text).not.toContain('02ab99a8');
  });

  it('is idempotent — re-running on placeholders changes nothing', () => {
    const once = resetStagingResourceIds(STAGING_SAMPLE).text;
    const twice = resetStagingResourceIds(once);
    expect(twice.text).toBe(once);
    expect(twice.resetD1 && twice.resetKv).toBe(true);
  });

  it('reports a missing slot via the reset flags (format-drift guard)', () => {
    const { resetD1, resetKv, resetCount } = resetStagingResourceIds('{ "vars": {} }');
    expect(resetD1).toBe(false);
    expect(resetKv).toBe(false);
    expect(resetCount).toBe(0);
  });
});

describe('stagingIdsArePlaceholders', () => {
  it('is false while the template still carries concrete ids', () => {
    expect(stagingIdsArePlaceholders(STAGING_SAMPLE)).toBe(false);
  });

  it('is true once both ids are reset', () => {
    const { text } = resetStagingResourceIds(STAGING_SAMPLE);
    expect(stagingIdsArePlaceholders(text)).toBe(true);
  });

  it('is false if either slot is missing', () => {
    expect(stagingIdsArePlaceholders('{}')).toBe(false);
  });

  it('parses structurally — key order cannot yield a spurious failure', () => {
    // The old regex required "binding":"SESSIONS" immediately before "id". Reordered keys
    // (id first, binding after) must still verify as placeholder.
    const reordered = `{
      "d1_databases": [{ "database_id": "${PROVISION_PLACEHOLDER}", "binding": "DB" }],
      "kv_namespaces": [{ "id": "${PROVISION_PLACEHOLDER}", "binding": "SESSIONS" }]
    }`;
    expect(stagingIdsArePlaceholders(reordered)).toBe(true);
  });

  it('is false on malformed input (fail closed)', () => {
    expect(stagingIdsArePlaceholders('not json at all')).toBe(false);
  });

  it('is false (not a throw) when a slot is the wrong type — fail closed', () => {
    // Parseable JSON but d1_databases/kv_namespaces is an object/string, not an array.
    expect(stagingIdsArePlaceholders('{ "d1_databases": {}, "kv_namespaces": [] }')).toBe(false);
    expect(stagingIdsArePlaceholders('{ "d1_databases": "x", "kv_namespaces": "y" }')).toBe(false);
  });
});

describe('parseJsonc', () => {
  it('preserves `//` inside string values — a URL is not corrupted by the comment strip', () => {
    // The naive regex strip truncated at the first `//`, breaking any config with a URL value
    // and making the structural checks (stagingIdsArePlaceholders/isTemplateRepo) misfire.
    const cfg = parseJsonc('{ "name": "app", "url": "https://app.cialdnb.ai/x", "n": 1 }');
    expect(cfg).not.toBeNull();
    expect(cfg?.url).toBe('https://app.cialdnb.ai/x');
    expect(cfg?.n).toBe(1);
  });

  it('strips line + block comments outside strings; a `//` inside a string survives', () => {
    const cfg = parseJsonc(`{
      // line comment
      "a": 1, /* block */ "b": "x // not a comment"
    }`);
    expect(cfg).toEqual({ a: 1, b: 'x // not a comment' });
  });

  it('returns null on malformed input', () => {
    expect(parseJsonc('not json')).toBeNull();
    expect(parseJsonc('{ "a": }')).toBeNull();
  });
});

describe('contaminatingTemplateIds', () => {
  it('flags the template’s own staging ids wherever they appear (durable detector)', () => {
    expect(contaminatingTemplateIds(STAGING_SAMPLE).sort()).toEqual(
      [...TEMPLATE_STAGING_IDS].sort(),
    );
  });

  it('is clean once the ids are reset, or replaced with the app’s own', () => {
    expect(contaminatingTemplateIds(resetStagingResourceIds(STAGING_SAMPLE).text)).toEqual([]);
    expect(contaminatingTemplateIds('"database_id": "arena-go-real-staging-id"')).toEqual([]);
  });
});

describe('isTemplateSelfReference', () => {
  it('allows kit narrative and machinery to keep the identity', () => {
    for (const p of [
      'docs/RESOURCES.md',
      'docs/design-briefs/app-registry.md',
      '.claude/hooks/guard-bash.mjs',
      '.claude/skills/new-app/SKILL.md',
      '.cursor/rules/paved-road.mdc',
      'CLAUDE.md',
      'CHANGELOG.md',
      'GUIDEBOOK.md',
      'scripts/new-app.mjs',
      'scripts/check-agent-guidance-sync.mjs',
      'src/framework/version.ts',
      'src/platform/bootstrap.ts',
      'test/auth/interstitial.test.ts',
      'test/platform/naming.test.ts',
      'test/platform/bootstrap.test.ts',
      'test/platform/new-app.test.mjs',
      'test/platform/provision.test.mjs',
      'test/platform/agent-guidance-sync.test.mjs',
      '.github/workflows/il-paved-road-release.yml',
      'scripts/deployment-target.mjs',
      'scripts/central-proposal.mjs',
      './CLAUDE.md',
    ]) {
      expect(isTemplateSelfReference(p), p).toBe(true);
    }
  });

  it('does not exempt app-identifier surfaces', () => {
    for (const p of [
      '.github/workflows/provision-staging.yml',
      '.github/workflows/provision-production.yml',
      '.github/workflows/deploy-prod.yml',
      'package.json',
      'package-lock.json',
      'wrangler.staging.jsonc',
      'test/health.test.ts',
      'test/cron/cron.test.ts',
      'test/ai/anthropic.test.ts',
      'src/routes/notes.ts',
      'src/auth/interstitial.ts',
      'README.md',
    ]) {
      expect(isTemplateSelfReference(p), p).toBe(false);
    }
  });
});

describe('residualTemplateRefs', () => {
  it('flags a forgotten app-identifier ref but not self-references', () => {
    const files: RepoFile[] = [
      { path: '.github/workflows/deploy-prod.yml', content: 'url: https://paved-road.cialdnb.ai' },
      { path: 'docs/GUIDEBOOK.md', content: 'clone github.com/CialDNB/paved-road' },
      { path: 'CLAUDE.md', content: 'the paved-road kit' },
      { path: 'src/index.ts', content: '// onto the paved road (space form, fine)' },
      { path: 'web/src/App.tsx', content: 'export const App = () => <h1>Arena Go</h1>;' },
    ];
    expect(residualTemplateRefs(files)).toEqual(['.github/workflows/deploy-prod.yml']);
  });

  it('returns nothing when every app-identifier ref has been renamed', () => {
    const files: RepoFile[] = [
      { path: 'wrangler.staging.jsonc', content: '"database_name": "arena-go-db-staging"' },
      { path: 'package.json', content: '"name": "arena-go"' },
      { path: 'docs/RESOURCES.md', content: 'paved-road historical note' }, // self-ref, allowed
    ];
    expect(residualTemplateRefs(files)).toEqual([]);
  });

  it('sorts multiple offenders deterministically', () => {
    const files: RepoFile[] = [
      { path: 'test/health.test.ts', content: "expect(body.app).toBe('paved-road')" },
      { path: 'package-lock.json', content: '"name": "paved-road"' },
    ];
    expect(residualTemplateRefs(files)).toEqual(['package-lock.json', 'test/health.test.ts']);
  });

  it('flags a forgotten PER-APP secret prefix (PAVED_ROAD), not the shared secrets', () => {
    const files: RepoFile[] = [
      { path: 'wrangler.jsonc', content: '"secret_name": "PAVED_ROAD_ANTHROPIC_API_KEY"' },
      // The shared secrets are allowlisted (SHARED_SECRET_NAMES), so they must not be flagged
      // even though they carry the PAVED_ROAD token.
      { path: 'wrangler.staging.jsonc', content: '"secret_name": "PAVED_ROAD_ALERT_WEBHOOK_URL"' },
      { path: 'wrangler.prod.jsonc', content: '"secret_name": "PAVED_ROAD_ENTRA_CLIENT_SECRET"' },
    ];
    expect(residualTemplateRefs(files)).toEqual(['wrangler.jsonc']);
  });

  it("ignores the kit's own repository name, and only that exact name", () => {
    const files: RepoFile[] = [
      { path: 'scripts/kit-checks/checks.sync.json', content: '"source": "CialDNB/paved-road"' },
      { path: 'src/cron/digest.ts', content: '// Until CialDNB/paved-road#256 this list held…' },
      { path: 'scripts/sync.mjs', content: "'CialDNB/paved-road' or the paved-road-db name" },
      { path: 'scripts/fork.mjs', content: "'CialDNB/paved-road-fork'" },
    ];
    expect(residualTemplateRefs(files)).toEqual(['scripts/fork.mjs', 'scripts/sync.mjs']);
  });

  it('pins the kit repository name — the .mjs mirror test asserts the SAME literal', () => {
    expect(KIT_REPOSITORY).toBe('CialDNB/paved-road');
  });

  it('pins the shared-secret list — the .mjs mirror test asserts the SAME literal, so either copy drifting fails CI', () => {
    expect([...SHARED_SECRET_NAMES]).toEqual([
      'PAVED_ROAD_ALERT_WEBHOOK_URL',
      'PAVED_ROAD_ENTRA_CLIENT_SECRET',
      'PAVED_ROAD_TURNSTILE_SECRET',
    ]);
  });
});

describe('SELF_REFERENCE_FILES (kit self-reference allowlist)', () => {
  // The canonical allowlist. scripts/new-app.mjs hand-duplicates it, and
  // test/platform/new-app.test.mjs checks the two copies are equal (it reads this file's literal;
  // the .mjs can't be cross-imported into the Workers test pool, it pulls node:child_process).
  const KIT_ENTRIES = [
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
  // The kit's own test config still carries the template's name; a renamed app's does not.
  const IN_KIT = env.APP_NAME === TEMPLATE_KEBAB;

  // A fork may add entries of its own to both copies, so everywhere this is a required subset. An
  // exact pin in the fork turned its test:scripts red on each kit allowlist change, until someone
  // hand-edited the fork's copy of this file.
  it('holds every entry the kit requires; a fork may add its own', () => {
    expect([...SELF_REFERENCE_FILES]).toEqual(expect.arrayContaining(KIT_ENTRIES));
  });

  // In the kit, the list stays exact: an entry exempts a file from the residual scan, so adding
  // one is a decision this test makes visible in review.
  it.skipIf(!IN_KIT)('pins the exact allowlist', () => {
    expect([...SELF_REFERENCE_FILES].sort()).toEqual(KIT_ENTRIES);
  });

  // AICOE-392: version.ts's header names the KIT the fork synced from ("the paved-road KIT version
  // this app is currently synced to"), a legitimate self-reference like CLAUDE.md/CHANGELOG.md —
  // NOT an app identifier to rename. Before it was allowlisted, every fork adopting version.ts
  // tripped verify:bootstrap on that residual `paved-road` token during `new-app.mjs`.
  it('exempts the kit version stamp so a fork adopting it does not trip the tripwire', () => {
    expect(isTemplateSelfReference('src/framework/version.ts')).toBe(true);
    const files: RepoFile[] = [
      {
        path: 'src/framework/version.ts',
        content:
          '// The paved-road KIT version this app is currently synced to.\nexport const KIT_VERSION = "0.1.0";',
      },
    ];
    expect(residualTemplateRefs(files)).toEqual([]);
  });
});

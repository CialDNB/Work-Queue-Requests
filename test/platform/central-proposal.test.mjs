// Pins scripts/central-proposal.mjs: the draft registration (`catalog/apps/<app>.json`, schema
// ilpr.app/v1) a DB Israel app sends the platform owner, and the plain-language decisions printed
// beside it. The draft is read live from the app's own files, so these cases run on synthetic app
// trees in a temp directory.
//
// The script also holds a mirror of the catalog rules central applies to an app entry
// (parseApp() in the central repository's src/delivery/catalog.ts). It is a mirror, not the rule:
// central's own `npm run check` decides. The mirror cases prove each rule fires on a draft that
// breaks it. Nothing here names the template as a literal. Run by `node --test` (test:scripts).
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import {
  buildProposal,
  DEFAULT_CHECKS,
  proposalProblems,
} from '../../scripts/central-proposal.mjs';
import { MARKER_PATH } from '../../scripts/deployment-target.mjs';

const ROOT = join(import.meta.dirname, '..', '..');
const SCRIPT = join(ROOT, 'scripts', 'central-proposal.mjs');
const APP = 'acme-app';
const HOST = `${APP}.staging.dbisrael.ai`;
const SENTINEL = '0'.repeat(32);

const temps = [];
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

/** A DB Israel app's staging config as the bootstrap leaves it, with `edit` applied. */
function stagingConfig(edit = (c) => c) {
  return edit({
    name: `${APP}-staging`,
    main: 'src/index.ts',
    account_id: SENTINEL,
    compatibility_date: '2026-05-15',
    compatibility_flags: ['nodejs_compat'],
    observability: { enabled: true, head_sampling_rate: 1, logs: { invocation_logs: false } },
    placement: { mode: 'smart' },
    workers_dev: false,
    preview_urls: false,
    assets: {
      directory: './web/dist',
      binding: 'ASSETS',
      not_found_handling: 'single-page-application',
      run_worker_first: ['/api/*', '/auth/*', '/_health', '/mcp'],
    },
    triggers: { crons: ['0 3 * * *'] },
    d1_databases: [
      { binding: 'DB', database_name: `${APP}-db-staging`, migrations_dir: 'migrations/d1' },
    ],
    kv_namespaces: [{ binding: 'SESSIONS' }],
    r2_buckets: [{ binding: 'BACKUPS', bucket_name: `${APP}-backups-staging` }],
    send_email: [{ name: 'EMAIL' }],
    secrets: { required: ['ANTHROPIC_API_KEY', 'AI_GATEWAY_TOKEN'] },
    secrets_store_secrets: [{ binding: 'ALERT_WEBHOOK_URL', store_id: SENTINEL, secret_name: 'X' }],
    vars: {
      APP_NAME: APP,
      APP_ENV: 'staging',
      DASHBOARD_HOST: HOST,
      MAIL_FROM: 'auth@invalid.example',
      MAIL_FROM_NAME: 'Acme App (staging)',
      CF_ACCOUNT_ID: '',
      AI_GATEWAY_ID: '',
      AI_DEFAULT_MODEL: 'claude-sonnet-4-6',
      AI_MAX_CALL_USD: '0.5',
      SESSION_TTL_SEC: '86400',
      ALLOWED_EMAIL_DOMAINS: '',
      ALERT_EMAIL: '',
      TURNSTILE_SITE_KEY: '',
      ENTRA_CLIENT_ID: '',
      ENTRA_ALLOWED_TENANTS: '',
      ENTRA_EMAIL_DOMAINS: '',
      AUDIT_DEPLOY_ACTORS: '',
      AGENT_ENABLED: 'off',
    },
  });
}

/** A synthetic DB Israel app tree; `files` (path → text, or an object written as JSON) override. */
function appTree(files = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'central-proposal-'));
  temps.push(dir);
  const all = {
    'wrangler.jsonc': { name: APP },
    'wrangler.staging.jsonc': `// Local development and tests only.\n${JSON.stringify(stagingConfig(), null, 2)}\n`,
    'package.json': { name: APP, scripts: { 'build:web': 'vite build' } },
    'schema.sql': 'CREATE TABLE x (id TEXT);\n',
    [MARKER_PATH]: '{ "version": 1, "deploymentTarget": "dbisrael" }\n',
    ...files,
  };
  for (const [path, content] of Object.entries(all)) {
    if (content === null) continue;
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(
      join(dir, path),
      typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`,
    );
  }
  return dir;
}
const withStaging = (edit) => ({
  'wrangler.staging.jsonc': `${JSON.stringify(stagingConfig(edit), null, 2)}\n`,
});

/** sha256 over every file under `dir`. */
function treeHash(dir) {
  const h = createHash('sha256');
  const walk = (rel) => {
    for (const e of readdirSync(join(dir, rel), { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const child = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(child);
      else h.update(`${child}\0`).update(readFileSync(join(dir, child)));
    }
  };
  walk('');
  return h.digest('hex');
}

const cli = (cwd, args = []) =>
  spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd,
    encoding: 'utf8',
    env: Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))),
  });
const transcript = (r) => `exit ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`;
const decisionsText = (result) => result.decisions.join('\n');

describe('the registration proposal', () => {
  it('is the ilpr.app/v1 draft read from the app files, and passes the mirror once its id is filled in', () => {
    const dir = appTree();
    const result = buildProposal({ root: dir, repositoryId: 4242 });
    const p = result.proposal;
    assert.deepEqual(Object.keys(p), [
      'schema',
      'app',
      'repository',
      'build',
      'database',
      'capabilities',
      'runtime_secrets',
      'optional_runtime_secrets',
      'schedules',
      'checks',
      'stages',
    ]);
    assert.equal(p.schema, 'ilpr.app/v1');
    assert.equal(p.app, APP);
    assert.deepEqual(p.repository, { id: 4242, slug: `CialDNB/${APP}`, branch: 'main' });
    assert.deepEqual(p.build, {
      profile: 'worker-assets/v1',
      script: 'build:web',
      main: 'src/index.ts',
      assets_directory: 'web/dist',
      compatibility_date: '2026-05-15',
      compatibility_flags: ['nodejs_compat'],
      not_found_handling: 'single-page-application',
      run_worker_first: ['/api/*', '/auth/*', '/_health', '/mcp'],
    });
    assert.deepEqual(p.database, { migrations_directory: 'migrations/d1', baseline: 'schema.sql' });
    assert.deepEqual(p.capabilities, {
      d1: [{ binding: 'DB' }],
      kv: [{ binding: 'SESSIONS' }],
      r2: [],
    });
    assert.deepEqual(p.runtime_secrets, [], 'no AI, so no required secret');
    assert.deepEqual(p.optional_runtime_secrets, []);
    assert.deepEqual(p.schedules, ['0 3 * * *']);
    assert.deepEqual(p.checks, DEFAULT_CHECKS);
    assert.deepEqual(DEFAULT_CHECKS, {
      ingress: 'waf-restricted',
      health_path: '/_health',
      protected_path: '/api/me',
      degraded_health: 'fail',
    });
    assert.deepEqual(p.stages.staging, {
      enabled: true,
      hostnames: [HOST],
      vars: {
        APP_NAME: APP,
        APP_ENV: 'staging',
        DASHBOARD_HOST: HOST,
        MAIL_FROM: 'auth@invalid.example',
        MAIL_FROM_NAME: 'Acme App (staging)',
        SESSION_TTL_SEC: '86400',
        ALLOWED_EMAIL_DOMAINS: '',
        TURNSTILE_SITE_KEY: '',
        ENTRA_CLIENT_ID: '',
        ENTRA_ALLOWED_TENANTS: '',
        ENTRA_EMAIL_DOMAINS: '',
        AUDIT_DEPLOY_ACTORS: '',
        AGENT_ENABLED: 'off',
      },
    });
    assert.deepEqual(p.stages.production, { enabled: false, hostnames: [], vars: {} });
    assert.deepEqual(proposalProblems(p), []);
    assert.deepEqual(result.fill, []);
  });

  it('is deterministic, and without a repository id says what to fill in, which the mirror refuses', () => {
    const dir = appTree();
    assert.deepEqual(buildProposal({ root: dir }), buildProposal({ root: dir }));
    const result = buildProposal({ root: dir });
    assert.equal(result.proposal.repository.id, 0);
    assert.match(result.fill.join('\n'), /repository\.id/);
    assert.match(result.fill.join('\n'), /gh api repos\/CialDNB\/acme-app --jq \.id/);
    assert.match(proposalProblems(result.proposal).join('\n'), /repository\.id/);
  });

  it('names every owner decision in plain language', () => {
    const text = decisionsText(buildProposal({ root: appTree(), repositoryId: 1 }));
    for (const says of [
      // Sign-in: Entra, its secret and its redirect URI.
      /ENTRA_CLIENT_SECRET/,
      new RegExp(`https://${HOST.replaceAll('.', '\\.')}/auth/oidc/callback`),
      /ILOPS-8950/,
      // AI: off unless approved, and what it takes.
      /ILOPS-8949/,
      /ANTHROPIC_API_KEY/,
      /AI_GATEWAY_TOKEN/,
      /AI_GATEWAY_ID/,
      /CF_ACCOUNT_ID/,
      // Backups, crons, optional secrets, the dropped keys, ingress and health, invocation logs.
      /BACKUPS/,
      /ILOPS-8891/,
      /at most 5/,
      /REGISTRY_TOKEN/,
      /ILOPS-8968/,
      /placement/,
      /routes/,
      /Secrets Store/,
      /send_email/,
      /waf-restricted/,
      /"accept"/,
      /invocation_logs/,
      /PIA/,
    ]) {
      assert.match(text, says);
    }
    assert.doesNotMatch(text, /cialdnb\.(?:ai|com)/, 'no CIAL hostname in the printed decisions');
  });

  it('lists the variables the code reads that the config does not set', () => {
    const text = decisionsText(buildProposal({ root: appTree(), repositoryId: 1 }));
    for (const name of ['READ_AUDIT', 'BACKUP_RETENTION_DAYS', 'MACHINE_SYNC_RUN']) {
      assert.ok(text.includes(name), name);
    }
    // Test knobs are not decisions.
    assert.equal(text.includes('MCP_WAITUNTIL_CAP_MS'), false);
  });

  it('moves a variable named like a secret to the optional secrets, and flags a variable the kit does not know', () => {
    const dir = appTree(
      withStaging((c) => ({ ...c, vars: { ...c.vars, PARTNER_API_KEY: 'x', ACME_MODE: 'on' } })),
    );
    const result = buildProposal({ root: dir, repositoryId: 1 });
    assert.equal('PARTNER_API_KEY' in result.proposal.stages.staging.vars, false);
    assert.deepEqual(result.proposal.optional_runtime_secrets, ['PARTNER_API_KEY']);
    assert.equal(result.proposal.stages.staging.vars.ACME_MODE, 'on');
    assert.match(decisionsText(result), /PARTNER_API_KEY/);
    assert.match(decisionsText(result), /ACME_MODE/);
    assert.deepEqual(proposalProblems(result.proposal), []);
  });

  it('moves a variable the vocabulary marks a secret to the optional secrets, its value left out, whatever its name', () => {
    // Neither name matches central's secret pattern, but src/env.ts reads both as secrets. Built
    // here, not real: a webhook address and a key.
    const webhook = ['https://hooks', 'example', 'invalid/T0/B0/x'].join('.');
    const sealKey = 'k'.repeat(44);
    const dir = appTree(
      withStaging((c) => ({
        ...c,
        vars: { ...c.vars, ALERT_WEBHOOK_URL: webhook, SEAL_KEY: sealKey },
      })),
    );
    const result = buildProposal({ root: dir, repositoryId: 1 });
    const vars = result.proposal.stages.staging.vars;
    assert.equal('ALERT_WEBHOOK_URL' in vars, false);
    assert.equal('SEAL_KEY' in vars, false);
    assert.deepEqual(result.proposal.optional_runtime_secrets, ['ALERT_WEBHOOK_URL', 'SEAL_KEY']);
    const printed = cli(dir, ['--repository-id', '1']);
    assert.equal(printed.status, 0, transcript(printed));
    for (const value of [webhook, sealKey]) {
      assert.equal(printed.stdout.includes(value), false, 'a secret value is never printed');
    }
    assert.match(decisionsText(result), /ALERT_WEBHOOK_URL, SEAL_KEY/);
    assert.deepEqual(proposalProblems(result.proposal), []);
  });

  it('keeps every R2 bucket but BACKUPS, and flags more than five schedules', () => {
    const crons = ['0 1 * * *', '0 2 * * *', '0 3 * * *', '0 4 * * *', '0 5 * * *', '0 6 * * *'];
    const dir = appTree(
      withStaging((c) => ({
        ...c,
        triggers: { crons },
        r2_buckets: [...c.r2_buckets, { binding: 'MEDIA', bucket_name: 'm' }],
      })),
    );
    const result = buildProposal({ root: dir, repositoryId: 1 });
    assert.deepEqual(result.proposal.capabilities.r2, [{ binding: 'MEDIA' }]);
    assert.deepEqual(result.proposal.schedules, crons);
    assert.match(decisionsText(result), /6 schedules/);
    assert.match(proposalProblems(result.proposal).join('\n'), /at most 5/);
  });

  it('takes the Israel values for the computed variables, whatever the config holds', () => {
    const dir = appTree(
      withStaging((c) => ({
        ...c,
        vars: {
          ...c.vars,
          DASHBOARD_HOST: 'old.example',
          MAIL_FROM: 'x@old.example',
          APP_ENV: 'x',
        },
      })),
    );
    const vars = buildProposal({ root: dir, repositoryId: 1 }).proposal.stages.staging.vars;
    assert.equal(vars.DASHBOARD_HOST, HOST);
    assert.equal(vars.MAIL_FROM, 'auth@invalid.example');
    assert.equal(vars.APP_ENV, 'staging');
  });
});

describe('the catalog mirror refuses each rule central applies', () => {
  const valid = () => structuredClone(buildProposal({ root: appTree(), repositoryId: 7 }).proposal);
  const cases = [
    ['an unknown key', (p) => Object.assign(p, { extra: 1 }), /unknown key "extra"/],
    ['another schema', (p) => Object.assign(p, { schema: 'ilpr.app/v2' }), /schema/],
    ['a 33-character name', (p) => Object.assign(p, { app: `a${'b'.repeat(31)}c` }), /app/],
    [
      'a repository outside the organization',
      (p) => Object.assign(p.repository, { slug: 'Other/x' }),
      /organization/,
    ],
    [
      'a dot segment in a build path',
      (p) => Object.assign(p.build, { main: 'src/../x.ts' }),
      /dot segment/,
    ],
    ['an unknown build profile', (p) => Object.assign(p.build, { profile: 'x' }), /profile/],
    [
      'a capability with an optional flag',
      (p) => p.capabilities.r2.push({ binding: 'BACKUPS', optional: true }),
      /unknown key "optional"/,
    ],
    [
      'the provider key as an optional secret',
      (p) => p.optional_runtime_secrets.push('ANTHROPIC_API_KEY'),
      /cannot be optional/,
    ],
    [
      'the provider key without the gateway token',
      (p) => p.runtime_secrets.push('ANTHROPIC_API_KEY'),
      /requires AI_GATEWAY_TOKEN/,
    ],
    [
      'the provider key without a gateway variable',
      (p) => p.runtime_secrets.push('ANTHROPIC_API_KEY', 'AI_GATEWAY_TOKEN'),
      /non-empty AI_GATEWAY_ID/,
    ],
    ['a schedule that is not a cron', (p) => p.schedules.push('@daily'), /schedules/],
    ['ASSETS as a secret', (p) => p.optional_runtime_secrets.push('ASSETS'), /collide/],
    [
      'a variable named like a binding',
      (p) => Object.assign(p.stages.staging.vars, { DB: 'x' }),
      /collides/,
    ],
    [
      'a variable named like a secret',
      (p) => Object.assign(p.stages.staging.vars, { X_TOKEN: 'x' }),
      /looks like a secret/,
    ],
    [
      'a long variable',
      (p) => Object.assign(p.stages.staging.vars, { X: 'x'.repeat(501) }),
      /short string/,
    ],
    [
      'another staging hostname',
      (p) => Object.assign(p.stages.staging, { hostnames: ['acme.dbisrael.ai'] }),
      /canonical/,
    ],
    [
      'a hostname outside the zone',
      (p) => Object.assign(p.stages.staging, { hostnames: ['acme-app.example.com'] }),
      /outside dbisrael\.ai/,
    ],
    [
      'a production host under the staging suffix',
      (p) => Object.assign(p.stages.production, { hostnames: [HOST] }),
      /staging suffix/,
    ],
    [
      'production on with no hostname',
      (p) => Object.assign(p.stages.production, { enabled: true }),
      /hostname grant/,
    ],
    [
      'production without staging',
      (p) => {
        Object.assign(p.stages.staging, { enabled: false });
        Object.assign(p.stages.production, { enabled: true, hostnames: ['acme.dbisrael.ai'] });
      },
      /production requires staging/,
    ],
    ['an ingress outside the two', (p) => Object.assign(p.checks, { ingress: 'open' }), /ingress/],
    [
      'a degraded-health policy outside the two',
      (p) => Object.assign(p.checks, { degraded_health: 'ignore' }),
      /degraded_health/,
    ],
    [
      'a D1 capability without a database',
      (p) => Object.assign(p, { database: null }),
      /database declaration/,
    ],
    [
      'a CF_ACCOUNT_ID that is no account',
      (p) => Object.assign(p.stages.staging.vars, { CF_ACCOUNT_ID: 'x' }),
      /CF_ACCOUNT_ID/,
    ],
  ];
  it('passes the valid draft', () => {
    assert.deepEqual(proposalProblems(valid()), []);
  });
  for (const [what, breakIt, says] of cases) {
    it(`refuses ${what}`, () => {
      const p = valid();
      breakIt(p);
      assert.match(proposalProblems(p).join('\n'), says);
    });
  }
});

describe('npm run central:proposal', () => {
  it('prints the draft and the decisions, and writes nothing', () => {
    const dir = appTree();
    const before = treeHash(dir);
    const r = cli(dir, ['--repository-id', '99', '--repository', 'CialDNB/acme-app-repo']);
    assert.equal(r.status, 0, transcript(r));
    const json = r.stdout.slice(r.stdout.indexOf('{'), r.stdout.indexOf('\n}\n') + 2);
    const draft = JSON.parse(json);
    assert.deepEqual(draft.repository, { id: 99, slug: 'CialDNB/acme-app-repo', branch: 'main' });
    assert.match(r.stdout, /Decisions/);
    assert.match(r.stdout, /writes nothing/);
    assert.equal(treeHash(dir), before);
    assert.equal(
      cli(dir, ['--repository-id', '99', '--repository', 'CialDNB/acme-app-repo']).stdout,
      r.stdout,
    );
  });

  it('refuses a usage error with exit 1', () => {
    const dir = appTree();
    for (const args of [
      ['--repository-id', 'abc'],
      ['--repository-id', '0'],
      ['--nope'],
      ['--repository'],
    ]) {
      const r = cli(dir, args);
      assert.equal(r.status, 1, `${args.join(' ')}: ${transcript(r)}`);
      assert.match(r.stderr, /Usage/);
    }
  });

  it('says so on a tree that is not a DB Israel app, and still prints the draft', () => {
    const r = cli(appTree({ [MARKER_PATH]: null }));
    assert.equal(r.status, 0, transcript(r));
    assert.match(r.stderr, /not a DB Israel app/);
    assert.match(r.stdout, /"schema": "ilpr\.app\/v1"/);
  });
});

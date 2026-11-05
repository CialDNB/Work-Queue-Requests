// Pins the D1 ownership preflight (scripts/check-d1-identity.mjs) — the backstop that refuses
// to migrate a database belonging to a different app. Every app built on the kit shares one
// Cloudflare account, an API token cannot be scoped to one D1, and Cloudflare logs NOTHING for
// /d1/.../query — so this check is the last thing standing between a wrong `database_id` and DDL
// on a sibling app's live data. Its asymmetry is the whole design and is tested case by case:
// only POSITIVE evidence of another app fails; an unprovisioned database passes; an UNKNOWN
// fails closed.
//
// Run by `node --test` (reads files via node:fs), so it's a *.test.mjs, outside the
// `test/**/*.test.ts` glob.
import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  DEFAULT_MIGRATIONS_DIR,
  declaredD1Bindings,
  ENV_CONFIG,
  expectedApp,
  findStampingMigration,
  IDENTITY_SQL,
  identityVerdict,
  MIGRATED_BINDING,
  migrationsDirFor,
  parseIdentity,
  probeIdentity,
} from '../../scripts/check-d1-identity.mjs';
import { parseJsonc, TEMPLATE_KEBAB } from '../../scripts/new-app.mjs';

const root = new URL('../../', import.meta.url);
const read = (p) => readFileSync(new URL(p, root), 'utf8');
// This repo's own app name: the template's in the kit, the app's after the bootstrap renames both
// the var and the seeds. The seeds must equal it, since the preflight compares them.
const APP_NAME = parseJsonc(read('wrangler.jsonc')).vars.APP_NAME;
const seedsApp = (sql) =>
  sql.includes(`INSERT OR IGNORE INTO app_identity (key, value) VALUES ('app', '${APP_NAME}')`);

/** What the kit ships: a migration under the pinned dir that seeds THIS app. */
const KIT_STAMP = { file: 'migrations/d1/0000_kit_app_identity.sql', app: 'arena-go' };

describe('expectedApp', () => {
  it('reads vars.APP_NAME, not the worker name', () => {
    // The staging worker is `<app>-staging` but its database identity is plain `<app>`.
    assert.equal(
      expectedApp({ name: 'arena-go-staging', vars: { APP_NAME: 'arena-go' } }),
      'arena-go',
    );
  });

  it('returns null when APP_NAME is missing or empty', () => {
    for (const cfg of [{}, { vars: {} }, { vars: { APP_NAME: '' } }, null, undefined]) {
      assert.equal(expectedApp(cfg), null);
    }
  });
});

describe('parseIdentity', () => {
  it('reads the value out of a bare-array envelope', () => {
    assert.equal(
      parseIdentity(JSON.stringify([{ results: [{ value: 'arena-go' }], success: true }])),
      'arena-go',
    );
  });

  it('reads the value out of a { result: [...] } envelope', () => {
    assert.equal(
      parseIdentity(JSON.stringify({ result: [{ results: [{ value: 'arena-go' }] }] })),
      'arena-go',
    );
  });

  it('returns null for zero rows rather than throwing', () => {
    assert.equal(parseIdentity(JSON.stringify([{ results: [], success: true }])), null);
    assert.equal(parseIdentity(JSON.stringify([])), null);
  });

  it('throws on output that is not JSON (caller turns this into a fail-closed)', () => {
    assert.throws(() => parseIdentity('Authentication error [code: 10000]'), /not JSON/);
  });

  // Regression: an unrecognized envelope must NOT read as "no rows". Zero rows means
  // "unprovisioned, carry on", so a future wrangler that renames the envelope would silently
  // disable the whole backstop while printing a reassuring message.
  it('throws on a valid-JSON envelope it does not recognize, rather than reporting no rows', () => {
    for (const stdout of ['{"foo":1}', '{"result":{"rows":[]}}', '"a string"', '42']) {
      assert.throws(() => parseIdentity(stdout), /recognizable result envelope|not JSON/, stdout);
    }
  });

  it('an unrecognized envelope reaches the verdict as a FAIL, not a pass', () => {
    const v = identityVerdict({
      app: 'arena-go',
      env: 'production',
      probe: { ok: true, stdout: '{"foo":1}' },
    });
    assert.equal(v.failed, true);
    assert.match(v.message, /owner is unknown/);
  });
});

describe('identityVerdict — only positive evidence of another app fails', () => {
  const probeOk = (value) => ({ ok: true, stdout: JSON.stringify([{ results: [{ value }] }]) });

  it('passes when the identity is this app', () => {
    const v = identityVerdict({ app: 'arena-go', env: 'production', probe: probeOk('arena-go') });
    assert.equal(v.failed, false);
    assert.match(v.message, /ok/);
  });

  it('FAILS when the database belongs to another app, and names both', () => {
    const v = identityVerdict({
      app: 'arena-go',
      env: 'production',
      probe: probeOk('app-pay-management'),
    });
    assert.equal(v.failed, true);
    assert.match(v.message, /app-pay-management/);
    assert.match(v.message, /arena-go/);
    // The remedy must point at the config, not at working around the check.
    assert.match(v.message, /database_id/);
    // ...AND at the other explanation: a mis-pointed sibling won the acknowledged first-deploy
    // race and stamped THIS app's database, so it is the rightful owner — whose config is
    // correct — that gets blocked. Telling them only to "fix database_id" bricks them; the
    // runbook is what gets them unstuck. Found in review.
    assert.match(v.message, /\(a\)[\s\S]*\(b\)/);
    assert.match(v.message, /first \(unguarded\) deploy stamped it/);
    assert.match(v.message, /docs\/runbooks\/d1-rehome\.md/);
    assert.match(v.message, /Do NOT work around this check/);
  });

  it('the re-homing runbook the message points at exists and says the load-bearing things', () => {
    const runbook = read('docs/runbooks/d1-rehome.md');
    // The two stories, the human-only DROP (the harness blocks it by design), and the trap that
    // d1_migrations already records the 0000 file so a migration re-run will NOT re-stamp.
    assert.match(runbook, /DROP TABLE app_identity/);
    assert.match(runbook, /guard-bash/);
    assert.match(runbook, /d1_migrations/);
    assert.match(
      runbook,
      /wrangler d1 execute DB --remote --file migrations\/d1\/0000_kit_app_identity\.sql/,
    );
    assert.doesNotMatch(
      runbook,
      /wrangler d1 execute [a-z-]+-db\b/,
      'addresses the binding, never a name',
    );
  });

  it('passes loudly on an unprovisioned database (no app_identity table) that a local migration will stamp', () => {
    const v = identityVerdict({
      app: 'arena-go',
      env: 'staging',
      probe: { ok: false, stderr: 'D1_ERROR: no such table: app_identity' },
      stamp: KIT_STAMP,
    });
    assert.equal(v.failed, false);
    // Must not read as a clean bill of health — this deploy really is unchecked.
    assert.match(v.message, /NOT OWNERSHIP-CHECKED/);
    assert.match(v.message, /db:apply:staging/);
    // And it names the file that makes "the next deploy is guarded" true.
    assert.match(v.message, /0000_kit_app_identity\.sql/);
  });

  it('passes loudly when the table exists but carries no app row, given a local stamp', () => {
    const v = identityVerdict({
      app: 'arena-go',
      env: 'production',
      probe: { ok: true, stdout: '[]' },
      stamp: KIT_STAMP,
    });
    assert.equal(v.failed, false);
    assert.match(v.message, /NOT OWNERSHIP-CHECKED/);
    assert.match(v.message, /db:apply/);
  });

  it('FAILS CLOSED on an unknown error — an unreadable database is not a safe one', () => {
    for (const stderr of [
      'Authentication error [code: 10000]',
      'fetch failed: ECONNRESET',
      "Couldn't find a D1 DB",
    ]) {
      const v = identityVerdict({
        app: 'arena-go',
        env: 'production',
        probe: { ok: false, stderr },
      });
      assert.equal(v.failed, true, stderr);
      assert.match(v.message, /owner is unknown/);
    }
  });

  it('FAILS CLOSED on malformed wrangler output', () => {
    const v = identityVerdict({
      app: 'arena-go',
      env: 'production',
      probe: { ok: true, stdout: 'not json' },
    });
    assert.equal(v.failed, true);
    assert.match(v.message, /owner is unknown/);
  });

  it('FAILS when the config carries no APP_NAME to compare against', () => {
    const v = identityVerdict({ app: null, env: 'production', probe: probeOk('arena-go') });
    assert.equal(v.failed, true);
    assert.match(v.message, /APP_NAME/);
  });
});

describe('probeIdentity builds the right wrangler invocation', () => {
  const capture = () => {
    const calls = [];
    const run = (cmd, args) => {
      calls.push({ cmd, args });
      return '[]';
    };
    return { calls, run };
  };

  it('targets the DB binding remotely and asks for JSON', () => {
    const { calls, run } = capture();
    probeIdentity('production', { run });
    const { cmd, args } = calls[0];
    assert.equal(cmd, 'npx');
    // The BINDING, never a database name — the binding resolves to the config's pinned id.
    assert.deepEqual(args.slice(0, 6), ['wrangler', 'd1', 'execute', 'DB', '--remote', '--json']);
    assert.equal(args.at(-1), IDENTITY_SQL);
    assert.ok(!args.includes('--config'), 'production uses the default config');
  });

  it('passes the staging config for staging', () => {
    const { calls, run } = capture();
    probeIdentity('staging', { run });
    assert.ok(calls[0].args.includes('--config'));
    assert.ok(calls[0].args.includes(ENV_CONFIG.staging));
  });

  it('turns a thrown child-process error into a not-ok probe rather than propagating', () => {
    const run = () => {
      const err = new Error('exit 1');
      err.stderr = 'no such table: app_identity';
      throw err;
    };
    const probe = probeIdentity('production', { run });
    assert.equal(probe.ok, false);
    assert.match(probe.stderr, /no such table/);
  });
});

describe('schema.sql declares the identity row and freezes it', () => {
  const schema = read('schema.sql');

  it('creates app_identity and seeds it with the app name', () => {
    assert.match(schema, /CREATE TABLE IF NOT EXISTS app_identity/);
    // The seeded value is the app's APP_NAME; the bootstrap renames both per app.
    assert.ok(seedsApp(schema), `schema.sql must seed app_identity with '${APP_NAME}'`);
  });

  it('freezes the row against UPDATE and DELETE, so a deploy cannot quietly re-home a database', () => {
    assert.match(schema, /CREATE TRIGGER IF NOT EXISTS app_identity_no_update/);
    assert.match(schema, /CREATE TRIGGER IF NOT EXISTS app_identity_no_delete/);
    assert.match(schema, /app_identity is immutable/);
  });

  it(`is on the bootstrap rename list, so a scaffolded app does not claim to be ${TEMPLATE_KEBAB}`, () => {
    const newApp = read('scripts/new-app.mjs');
    const files = newApp.slice(newApp.indexOf('const FILES = ['));
    assert.match(files.slice(0, files.indexOf(']')), /'schema\.sql'/);
  });
});

describe('both deploy paths run the preflight before any DDL', () => {
  const cases = [
    ['.github/workflows/ci.yml', '--env staging'],
    ['.github/workflows/deploy-prod.yml', '--env production'],
  ];
  for (const [file, envArg] of cases) {
    it(`${file} preflights before migrating`, () => {
      const text = read(file);
      const preflightAt = text.indexOf(`check-d1-identity.mjs ${envArg}`);
      const migrateAt = text.search(/npm run db:migrate/);
      assert.ok(preflightAt !== -1, 'preflight step present');
      assert.ok(migrateAt !== -1, 'migrate step present');
      assert.ok(preflightAt < migrateAt, 'preflight runs BEFORE migrations');
    });

    it(`${file} gives the preflight a Cloudflare token (it is a network check)`, () => {
      const text = read(file);
      const stepAt = text.indexOf('D1 ownership preflight');
      const window = text.slice(stepAt, text.indexOf('check-d1-identity.mjs', stepAt));
      assert.match(window, /CLOUDFLARE_API_TOKEN/);
    });
  }
});

// The one-deploy window is a PROMISE, and the preflight may only make it when this repo can keep
// it. `migrations/` is deliberately outside the /kit-upgrade diff set, so a fork that adopted
// scripts/ + .github/ and stopped there has no stamping migration — and "unguarded this once"
// would silently be "unguarded forever", the backstop permanently inert on the databases it
// exists for. Found in review; these cases pin the closure.
describe('the absent-identity pass is conditional on a local stamping migration', () => {
  const absent = { ok: true, stdout: '[]' };

  it('FAILS when nothing in the repo stamps the migrated binding — with the copy-by-hand remedy', () => {
    const v = identityVerdict({
      app: 'arena-go',
      env: 'staging',
      probe: absent,
      stamp: null,
      migrationsDir: 'migrations/d1',
    });
    assert.equal(v.failed, true);
    assert.match(v.message, /nothing under migrations\/d1\/ stamps it/);
    assert.match(v.message, /0000_kit_app_identity\.sql/);
    assert.match(v.message, /kit-upgrade diff set/);
    assert.match(v.message, /"arena-go"/);
    assert.doesNotMatch(v.message, /NOT OWNERSHIP-CHECKED/);
  });

  it('holds the fresh-table path (no such table) to the same rule', () => {
    const v = identityVerdict({
      app: 'arena-go',
      env: 'production',
      probe: { ok: false, stderr: 'D1_ERROR: no such table: app_identity' },
      stamp: null,
    });
    assert.equal(v.failed, true);
    assert.match(v.message, /nothing under/);
  });

  it('FAILS when the local migration would stamp ANOTHER name — before the immutable stamp lands', () => {
    const v = identityVerdict({
      app: 'arena-go',
      env: 'production',
      probe: absent,
      stamp: { file: 'migrations/d1/0000_kit_app_identity.sql', app: 'test-app' },
    });
    assert.equal(v.failed, true);
    assert.match(v.message, /would stamp it as "test-app", not "arena-go"/);
    assert.match(v.message, /immutable/);
    assert.match(v.message, /vars\.APP_NAME/);
  });

  it('passes loudly on a NON-migrated binding and says nothing stamps it automatically', () => {
    const v = identityVerdict({
      app: 'arena-go',
      env: 'staging',
      probe: absent,
      binding: 'REPORTING_DB',
      stamp: null,
    });
    assert.equal(v.failed, false);
    assert.match(v.message, /NOT OWNERSHIP-CHECKED for binding REPORTING_DB/);
    assert.match(v.message, /nothing stamps it automatically/);
    assert.match(v.message, /wrangler d1 execute REPORTING_DB --remote/);
    assert.match(v.message, /--config wrangler\.staging\.jsonc/);
  });

  it('the migrated binding is the one every db:migrate script targets', () => {
    assert.equal(MIGRATED_BINDING, 'DB');
    const pkg = JSON.parse(read('package.json'));
    assert.match(pkg.scripts['db:migrate'], new RegExp(`apply ${MIGRATED_BINDING} `));
    assert.match(pkg.scripts['db:migrate:staging'], new RegExp(`apply ${MIGRATED_BINDING} `));
  });

  it('a present identity is unaffected by the stamp (it only matters on the absent path)', () => {
    const present = { ok: true, stdout: JSON.stringify([{ results: [{ value: 'arena-go' }] }]) };
    assert.equal(
      identityVerdict({ app: 'arena-go', env: 'production', probe: present }).failed,
      false,
    );
    const other = { ok: true, stdout: JSON.stringify([{ results: [{ value: 'app-x' }] }]) };
    assert.equal(
      identityVerdict({ app: 'arena-go', env: 'production', probe: other, stamp: KIT_STAMP })
        .failed,
      true,
    );
  });
});

describe('findStampingMigration finds the stamp by content, not by filename', () => {
  const SEED = "INSERT OR IGNORE INTO app_identity (key, value) VALUES ('app', 'arena-go');\n";
  const rootWith = (files) => {
    const dir = mkdtempSync(join(tmpdir(), 'd1-stamp-'));
    for (const [name, text] of Object.entries(files)) {
      mkdirSync(join(dir, name, '..'), { recursive: true });
      writeFileSync(join(dir, name), text);
    }
    return dir;
  };

  it('finds a RENUMBERED kit migration (a fork folds 0000 into its own sequence)', () => {
    const root = rootWith({
      'migrations/d1/0001_read_log.sql': 'CREATE TABLE IF NOT EXISTS read_log (id TEXT);\n',
      'migrations/d1/0007_kit_app_identity.sql': `CREATE TABLE IF NOT EXISTS app_identity (key TEXT PRIMARY KEY, value TEXT NOT NULL);\n${SEED}`,
    });
    assert.deepEqual(findStampingMigration('migrations/d1', { root }), {
      file: 'migrations/d1/0007_kit_app_identity.sql',
      app: 'arena-go',
    });
  });

  it('tolerates whitespace and case differences in the seed statement', () => {
    const root = rootWith({
      'migrations/d1/0000_x.sql':
        "insert or ignore into app_identity ( key , value )\n  values ( 'app' , 'arena-go' );",
    });
    assert.equal(findStampingMigration('migrations/d1', { root })?.app, 'arena-go');
  });

  it('returns null when no migration seeds the row, and when the dir does not exist', () => {
    const root = rootWith({
      'migrations/d1/0001_other.sql': 'CREATE TABLE IF NOT EXISTS t (a);\n',
    });
    assert.equal(findStampingMigration('migrations/d1', { root }), null);
    assert.equal(findStampingMigration('migrations/nowhere', { root }), null);
  });

  it('the real repo ships the stamp under the pinned migrations_dir, seeding the template name', () => {
    assert.deepEqual(findStampingMigration('migrations/d1'), {
      file: 'migrations/d1/0000_kit_app_identity.sql',
      app: APP_NAME,
    });
  });

  it("migrationsDirFor reads the binding's migrations_dir, falling back to wrangler's default", () => {
    assert.equal(
      migrationsDirFor({ d1_databases: [{ binding: 'DB', migrations_dir: 'db/migs' }] }, 'DB'),
      'db/migs',
    );
    assert.equal(
      migrationsDirFor({ d1_databases: [{ binding: 'DB' }] }, 'DB'),
      DEFAULT_MIGRATIONS_DIR,
    );
    assert.equal(migrationsDirFor({}, 'DB'), DEFAULT_MIGRATIONS_DIR);
    assert.equal(DEFAULT_MIGRATIONS_DIR, 'migrations');
    for (const cfgFile of Object.values(ENV_CONFIG)) {
      assert.equal(
        migrationsDirFor(parseJsonc(read(cfgFile)), MIGRATED_BINDING),
        'migrations/d1',
        cfgFile,
      );
    }
  });
});

// Regression: schema.sql is the FRESH-INSTALL baseline and never runs against an
// already-provisioned database. Without a migration, every database that existed before this
// change stays unstamped and the backstop is permanently inert on exactly the databases it
// exists to protect. See migrations/d1/README.md — live apps change schema through migrations.
describe('existing databases get stamped too', () => {
  const migration = read('migrations/d1/0000_kit_app_identity.sql');

  it('ships a kit migration that mirrors the baseline app_identity block', () => {
    assert.match(migration, /CREATE TABLE IF NOT EXISTS app_identity/);
    assert.ok(seedsApp(migration), `the migration must seed app_identity with '${APP_NAME}'`);
    assert.match(migration, /CREATE TRIGGER IF NOT EXISTS app_identity_no_update/);
    assert.match(migration, /CREATE TRIGGER IF NOT EXISTS app_identity_no_delete/);
  });

  it("numbers it 0000 so it cannot collide with an app's own 0001+ migrations", () => {
    const newApp = read('scripts/new-app.mjs');
    const files = newApp.slice(newApp.indexOf('const FILES = ['));
    assert.match(
      files.slice(0, files.indexOf(']')),
      /'migrations\/d1\/0000_kit_app_identity\.sql'/,
    );
  });

  it('is idempotent, so a fresh install applying baseline-then-migration is a no-op', () => {
    assert.ok(!/CREATE TABLE (?!IF NOT EXISTS)/.test(migration), 'tables guarded');
    assert.ok(!/INSERT INTO/.test(migration), 'seed uses INSERT OR IGNORE');
  });
});

// Regression: checking only the `DB` binding left a bypass that the attributability gate cannot
// see, because that gate compares NAMES — declare a second d1 binding named like this app's but
// carrying a SIBLING's database_id, and the Worker reads their data at runtime. This matters most
// where people reach Cloudflare only through the repo: a config edit in a PR is the whole surface,
// and CI runs it with an account-wide token.
describe('every declared d1 binding is asked, not just DB', () => {
  it('lists all d1 bindings from the config', () => {
    assert.deepEqual(
      declaredD1Bindings({
        d1_databases: [{ binding: 'DB' }, { binding: 'REPORTING_DB' }, { binding: 'ARCHIVE' }],
      }),
      ['DB', 'REPORTING_DB', 'ARCHIVE'],
    );
  });

  it('falls back to DB when the config declares none, so it never silently checks nothing', () => {
    for (const cfg of [{}, { d1_databases: [] }, null, undefined]) {
      assert.deepEqual(declaredD1Bindings(cfg), ['DB']);
    }
  });

  it('skips malformed entries rather than probing an undefined binding', () => {
    assert.deepEqual(
      declaredD1Bindings({ d1_databases: [{ binding: 'DB' }, {}, { binding: '' }] }),
      ['DB'],
    );
  });

  it('probeIdentity targets the binding it is given', () => {
    const seen = [];
    const run = (_cmd, args) => {
      seen.push(args[3]);
      return '[]';
    };
    probeIdentity('production', { run, binding: 'REPORTING_DB' });
    probeIdentity('production', { run });
    assert.deepEqual(seen, ['REPORTING_DB', 'DB']);
  });
});

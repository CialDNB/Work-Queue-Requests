// Pins scripts/check-kit-migrations.mjs — the gate that every kit migration has reached an app,
// matched by content under whatever number the fork gave it. Plain node:fs, so it runs under
// `node --test` via `test:scripts`.
//
// The fork layouts are SYNTHETIC but built from the kit's REAL migrations and the committed
// manifest, so "a renumbered copy passes" is proven against the files forks actually copy, not
// against a toy. Nothing here writes the kit's own name as a literal (a template identifier in a
// test file reds a fork's verify:bootstrap, #178) — the unforked identity is TEMPLATE_KEBAB.
//
// WHERE IT RUNS. The kit's migrations are on disk only in the kit. In an app, migrations/d1 is the
// app's own: its identity migration seeds the app's name (the one edit the gate requires, and what
// the bootstrap writes), its own migrations follow, and a fork may renumber the kit's. So what is
// built from KIT_FILES runs in the kit only (KIT_ONLY: isTemplateRepo, the wrangler.jsonc name the
// checker's `unforked` also reads): the "an app" and "the kit" describes, whose two pure cases
// (malformed pins, the *.sql listing) skip with them, and the two manifest cases that hold this
// repo's folder to the manifest as the kit's. In an app the gate itself, verify:kit-migrations,
// checks that folder. The cases built from inline SQL or the manifest alone run everywhere.
// bootstrap-e2e.test.mjs runs this file in a generated app of each target, before and after the
// app's first own migration.
import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  APP_NAME_PLACEHOLDER,
  appFailures,
  checkKitMigrations,
  kitFailures,
  MANIFEST_FILE,
  MIGRATIONS_DIR,
  migrationHash,
  NORMALISATION,
  nextOrdinal,
  normaliseSql,
  parseManifest,
  run,
  serialiseManifest,
  slugOf,
  sqlFiles,
} from '../../scripts/check-kit-migrations.mjs';
import { isTemplateRepo, TEMPLATE_KEBAB } from '../../scripts/new-app.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
// The options of what reads this repo's migrations/d1 as the kit's (see WHERE IT RUNS).
const KIT_ONLY = {
  skip:
    !isTemplateRepo(REPO) &&
    "kit only: in an app, migrations/d1 is the app's own; verify:kit-migrations checks it",
};
const KIT_DIR = join(REPO, MIGRATIONS_DIR);
const KIT_FILES = Object.fromEntries(
  sqlFiles(readdirSync(KIT_DIR)).map((name) => [name, readFileSync(join(KIT_DIR, name), 'utf8')]),
);
const KIT_MANIFEST_TEXT = readFileSync(join(REPO, MANIFEST_FILE), 'utf8');
const KIT_MANIFEST = parseManifest(KIT_MANIFEST_TEXT);
const IDENTITY_FILE = '0000_kit_app_identity.sql';
const APP = 'acme-ledger';

const ROOTS = [];
after(() => {
  for (const root of ROOTS) rmSync(root, { recursive: true, force: true });
});

/** The DB binding as a config declares it: where wrangler applies migrations from. */
const dbBinding = (extra = { migrations_dir: MIGRATIONS_DIR }) => [
  { binding: 'DB', database_name: 'synthetic', database_id: 'synthetic', ...extra },
];

/** A repo root on disk: a production config naming `name` whose DB binding applies from
 *  `applied`, a migrations folder `folder` holding `files`, and the manifest. */
function makeRoot({
  name = APP,
  files = {},
  manifest = KIT_MANIFEST_TEXT,
  dir = true,
  folder = MIGRATIONS_DIR,
  d1 = dbBinding(),
  staging = null,
} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'kit-migrations-'));
  ROOTS.push(root);
  const config = { name, vars: { APP_NAME: name }, d1_databases: d1 };
  writeFileSync(join(root, 'wrangler.jsonc'), `// synthetic\n${JSON.stringify(config)}\n`);
  if (staging !== null) {
    writeFileSync(join(root, 'wrangler.staging.jsonc'), `${JSON.stringify(staging)}\n`);
  }
  mkdirSync(join(root, 'scripts'));
  if (manifest !== null) writeFileSync(join(root, MANIFEST_FILE), manifest);
  if (dir) {
    mkdirSync(join(root, folder), { recursive: true });
    for (const [file, text] of Object.entries(files)) {
      writeFileSync(join(root, folder, file), text);
    }
  }
  return root;
}

/** The kit's identity migration as a fork must adopt it: the seed is the fork's own name. */
function adoptedIdentity(app = APP) {
  const kit = KIT_FILES[IDENTITY_FILE];
  const seeded = kit.replace(`'${TEMPLATE_KEBAB}'`, `'${app}'`);
  assert.notEqual(seeded, kit, 'the kit identity migration seeds the template name');
  return seeded;
}

/** A fork's folder: its own migrations first, then the kit's renumbered after them, the way
 *  insights did it (0004_read_log.sql / 0005_read_log_kind.sql), with the header rewritten. */
function renumberedFork(app = APP) {
  const files = {
    [IDENTITY_FILE]: adoptedIdentity(app),
    '0001_customers.sql': 'CREATE TABLE IF NOT EXISTS customers (id INTEGER PRIMARY KEY);\n',
    '0002_orders.sql': 'CREATE TABLE IF NOT EXISTS orders (id INTEGER PRIMARY KEY);\n',
  };
  let ordinal = 3;
  for (const name of Object.keys(KIT_FILES)) {
    if (name === IDENTITY_FILE) continue;
    const renumbered = `${String(ordinal++).padStart(4, '0')}_${slugOf(name)}`;
    files[renumbered] =
      `-- ADOPTED FROM THE KIT (kit file ${name}), renumbered into this app's own sequence.\r\n` +
      KIT_FILES[name].replace(/\n/g, '\r\n');
  }
  return files;
}

describe('the committed manifest', () => {
  it('parses, under the checker’s own normalisation', () => {
    assert.equal(KIT_MANIFEST.error, undefined, KIT_MANIFEST.error);
    assert.equal(KIT_MANIFEST.normalisation, NORMALISATION);
  });

  it('pins every kit migration, and nothing else', KIT_ONLY, () => {
    assert.deepEqual(KIT_MANIFEST.migrations.map((m) => m.file).sort(), Object.keys(KIT_FILES));
  });

  it('is exactly what --write would write (sorted, stable)', () => {
    assert.equal(serialiseManifest(KIT_MANIFEST.migrations), KIT_MANIFEST_TEXT);
  });

  it('this repo passes, as the kit: every pin present and unchanged', KIT_ONLY, () => {
    const result = checkKitMigrations(REPO);
    assert.deepEqual(result.failures, []);
    assert.equal(result.unforked, true);
    assert.equal(result.matched.length, Object.keys(KIT_FILES).length);
  });

  it('carries no template identifier (it rides /kit-upgrade into every fork)', () => {
    assert.ok(!KIT_MANIFEST_TEXT.includes(TEMPLATE_KEBAB));
  });
});

describe('normaliseSql — what a correct copy may change', () => {
  const base = "CREATE TABLE t (\n  a TEXT NOT NULL DEFAULT 'x' -- note\n);\n";

  it('ignores comments, whitespace, CRLF and a BOM', () => {
    const variants = [
      "-- header rewritten by a fork\nCREATE TABLE t (a TEXT NOT NULL DEFAULT 'x');",
      "\uFEFFCREATE TABLE t (\r\n\ta TEXT   NOT NULL DEFAULT 'x' /* block */\r\n);  \r\n",
      "CREATE /* a\nmulti-line\ncomment */ TABLE t ( a TEXT NOT NULL DEFAULT 'x' );",
    ];
    // The token boundary a comment or newline stands for is kept as one space, so `( a` and
    // `(\n  a` agree but `(a` does not — copies differ in layout, never by joining tokens.
    const want = normaliseSql(base, null);
    assert.equal(want, "CREATE TABLE t ( a TEXT NOT NULL DEFAULT 'x' );");
    assert.equal(normaliseSql(variants[1], null), want);
    assert.equal(normaliseSql(variants[2], null), want);
    assert.equal(normaliseSql(variants[0], null), "CREATE TABLE t (a TEXT NOT NULL DEFAULT 'x');");
  });

  it('keeps quoted text byte for byte — a `--` in a string is data', () => {
    const sql = "SELECT '-- not a comment', \"col -- name\", `x /* y */`, [a--b], 'it''s';";
    assert.equal(normaliseSql(sql, null), sql);
    assert.equal(normaliseSql("SELECT 'a  b';", null), "SELECT 'a  b';");
    assert.notEqual(normaliseSql("SELECT 'a  b';", null), normaliseSql("SELECT 'a b';", null));
  });

  it('sees a real change as a different hash', () => {
    const edits = [
      "CREATE TABLE t (a TEXT DEFAULT 'x');",
      "CREATE TABLE t (a TEXT NOT NULL DEFAULT 'y');",
      "CREATE TABLE t (a INTEGER NOT NULL DEFAULT 'x');",
      "create table t (a TEXT NOT NULL DEFAULT 'x');",
    ];
    for (const edit of edits) assert.notEqual(migrationHash(edit, null), migrationHash(base, null));
  });

  it('turns the app’s own name, as a whole SQL literal, into the placeholder', () => {
    const seed = (name) => `INSERT INTO app_identity (key, value) VALUES ('app', '${name}');`;
    assert.equal(
      normaliseSql(seed(APP), APP),
      `INSERT INTO app_identity (key, value) VALUES ('app', ${APP_NAME_PLACEHOLDER});`,
    );
    assert.equal(
      migrationHash(seed(APP), APP),
      migrationHash(seed(TEMPLATE_KEBAB), TEMPLATE_KEBAB),
    );
    // A seed that is not THIS app's name is not substituted — the fork that forgot to re-seed.
    assert.notEqual(migrationHash(seed(TEMPLATE_KEBAB), APP), migrationHash(seed(APP), APP));
    // Only a whole literal: a longer string that contains the name is data.
    assert.equal(normaliseSql(`SELECT '${APP}-x';`, APP), `SELECT '${APP}-x';`);
    // Only in the seed position: the same literal anywhere else is data too.
    assert.equal(normaliseSql(`SELECT '${APP}';`, APP), `SELECT '${APP}';`);
    // No app name at all: nothing is substituted.
    assert.equal(normaliseSql(seed(APP), null), seed(APP));
  });

  it('refuses a literal that already reads as the placeholder, when a name is being seeded', () => {
    const forged = `INSERT INTO app_identity (key, value) VALUES ('app', ${APP_NAME_PLACEHOLDER});`;
    assert.equal(normaliseSql(forged, APP), null);
    assert.equal(migrationHash(forged, APP), null);
    // Without a name nothing is substituted, so the text is ordinary data and hashes as such.
    assert.equal(normaliseSql(forged, null), forged);
  });

  it('survives unterminated quotes and comments without throwing', () => {
    for (const bad of ["SELECT 'open", 'SELECT "open', 'SELECT [open', 'SELECT 1 /* open']) {
      assert.equal(typeof normaliseSql(bad, null), 'string');
    }
  });
});

describe('an app — every kit migration matched by content, whatever its number', KIT_ONLY, () => {
  it('a renumbered fork with rewritten headers and CRLF passes', () => {
    const root = makeRoot({ files: renumberedFork() });
    const result = checkKitMigrations(root);
    assert.deepEqual(result.failures, []);
    assert.equal(result.unforked, false);
    const kit = Object.keys(KIT_FILES);
    assert.deepEqual(
      result.matched.map((m) => m.kit),
      kit,
    );
    // Each one was found under the fork's own number, not the kit's.
    assert.ok(result.matched.some((m) => m.kit !== m.app));
    const cli = run([], root);
    assert.equal(cli.code, 0);
    assert.match(cli.out, /present, matched by content/);
    assert.match(cli.out, /→ migrations\/d1\/0003_read_log\.sql/);
  });

  it('a fork that is missing a kit migration fails, naming the file and where to copy it', () => {
    const files = renumberedFork();
    const dropped = Object.keys(files).find((f) => slugOf(f) === 'service_identities.sql');
    assert.ok(dropped, 'the fixture carries the service-identities migration');
    delete files[dropped];
    const { failures } = checkKitMigrations(makeRoot({ files }));
    assert.equal(failures.length, 1);
    assert.match(failures[0], /kit migration 0004_service_identities\.sql has no copy/);
    assert.match(
      failures[0],
      /git show kit\/main:migrations\/d1\/0004_service_identities\.sql > migrations\/d1\/\d{4}_service_identities\.sql/,
    );
    const cli = run([], makeRoot({ files }));
    assert.equal(cli.code, 1);
    assert.match(cli.out, /Kit migration guard FAILED/);
  });

  it('suggests consecutive ordinals after the fork’s highest, in kit order', () => {
    const files = { [IDENTITY_FILE]: adoptedIdentity(), '0007_mine.sql': 'SELECT 1;' };
    const { failures } = appFailures(KIT_MANIFEST, files, APP);
    const targets = failures.map((f) => / > migrations\/d1\/(\S+)$/.exec(f)?.[1]);
    assert.deepEqual(targets, [
      '0008_read_log.sql',
      '0009_read_log_kind.sql',
      '0010_api_token_scopes.sql',
      '0011_service_identities.sql',
      '0012_read_log_upstream.sql',
      '0013_agent_tables.sql',
    ]);
  });

  it('a copy whose statements were edited fails as MODIFIED, naming both files', () => {
    const files = renumberedFork();
    const edited = Object.keys(files).find((f) => slugOf(f) === 'read_log_kind.sql');
    files[edited] = files[edited].replace(/CREATE TRIGGER/, 'CREATE TRIGGER IF NOT EXISTS x_');
    assert.notEqual(files[edited], renumberedFork()[edited], 'the fixture edit landed');
    const { failures } = checkKitMigrations(makeRoot({ files }));
    assert.equal(failures.length, 1);
    assert.match(failures[0], new RegExp(`${MIGRATIONS_DIR}/${edited} carries kit migration`));
    assert.match(failures[0], /0002_read_log_kind\.sql's name but not its statements/);
    assert.match(failures[0], /git show kit\/main:migrations\/d1\/0002_read_log_kind\.sql/);
  });

  it('an edited copy under a different name is still caught — as missing', () => {
    const files = renumberedFork();
    const edited = Object.keys(files).find((f) => slugOf(f) === 'read_log.sql');
    const text = `${files[edited]}\nCREATE INDEX IF NOT EXISTS extra ON read_log (principal);\n`;
    delete files[edited];
    files['0099_our_ledger.sql'] = text;
    const { failures } = checkKitMigrations(makeRoot({ files }));
    assert.equal(failures.length, 1);
    assert.match(failures[0], /kit migration 0001_read_log\.sql has no copy/);
  });

  it('the identity migration must seed THIS app’s name', () => {
    const forgot = renumberedFork();
    forgot[IDENTITY_FILE] = KIT_FILES[IDENTITY_FILE]; // still seeds the template's name
    const { failures } = checkKitMigrations(makeRoot({ files: forgot }));
    assert.equal(failures.length, 1);
    assert.match(failures[0], /carries kit migration 0000_kit_app_identity\.sql's name/);
    assert.match(failures[0], new RegExp(`exactly your vars\\.APP_NAME \\("${APP}"\\)`));

    const absent = renumberedFork();
    delete absent[IDENTITY_FILE];
    const missing = checkKitMigrations(makeRoot({ files: absent })).failures;
    assert.equal(missing.length, 1);
    assert.match(missing[0], /KEEPING the 0000 number/);
    assert.match(missing[0], new RegExp(`\\("${APP}"\\)`));
  });

  it('an APP_NAME equal to a literal some kit migration carries is not an edit', () => {
    // 'client' and 'internal' are read-ledger classes, 'aurora' a read_log kind, 'now' a datetime
    // argument, and 'app' the identity key right before the seed: an app may be named any of them.
    for (const app of ['client', 'internal', 'aurora', 'now', 'app']) {
      const files = renumberedFork(app);
      assert.deepEqual(appFailures(KIT_MANIFEST, files, app).failures, [], app);
    }
  });

  it('a seed of the placeholder text itself matches no app’s identity', () => {
    const files = renumberedFork();
    files[IDENTITY_FILE] = KIT_FILES[IDENTITY_FILE].replace(
      `'${TEMPLATE_KEBAB}'`,
      APP_NAME_PLACEHOLDER,
    );
    const { failures } = appFailures(KIT_MANIFEST, files, APP);
    assert.equal(failures.length, 1);
    assert.match(failures[0], /carries kit migration 0000_kit_app_identity\.sql's name/);
  });

  it('accepts a prior revision the kit re-pinned', () => {
    const files = renumberedFork();
    const target = Object.keys(files).find((f) => slugOf(f) === 'api_token_scopes.sql');
    files[target] = `${files[target]}\nSELECT 'an older revision';\n`;
    const old = migrationHash(files[target], APP);
    const manifest = {
      ...KIT_MANIFEST,
      migrations: KIT_MANIFEST.migrations.map((m) =>
        m.file === '0003_api_token_scopes.sql' ? { ...m, priorRevisions: [old] } : m,
      ),
    };
    assert.deepEqual(appFailures(manifest, files, APP).failures, []);
    assert.equal(appFailures(KIT_MANIFEST, files, APP).failures.length, 1);
  });

  it('fails closed without the manifest, with an unreadable one, or one from another normaliser', () => {
    const files = renumberedFork();
    const absent = checkKitMigrations(makeRoot({ files, manifest: null })).failures;
    assert.equal(absent.length, 1);
    assert.match(absent[0], /could not read .* nothing can be cleared/);

    const garbled = checkKitMigrations(makeRoot({ files, manifest: '{ not json' })).failures;
    assert.deepEqual(garbled, [`${MANIFEST_FILE}: not valid JSON`]);

    const future = JSON.stringify({ normalisation: NORMALISATION + 1, migrations: [] });
    const other = checkKitMigrations(makeRoot({ files, manifest: future })).failures;
    assert.equal(other.length, 1);
    assert.match(other[0], /written under normalisation/);
  });

  it('refuses a malformed pin rather than reading around it', () => {
    const cases = [
      [{ normalisation: NORMALISATION }, /"migrations" must be an array/],
      [{ normalisation: NORMALISATION, migrations: ['x'] }, /is not an object/],
      [{ normalisation: NORMALISATION, migrations: [{ file: 'x.sql', sha256: 'a' }] }, /NNNN_slug/],
      [
        { normalisation: NORMALISATION, migrations: [{ file: '0001_a.sql', sha256: 'a' }] },
        /sha256/,
      ],
      [
        {
          normalisation: NORMALISATION,
          migrations: [
            { file: '0001_a.sql', sha256: 'a'.repeat(64) },
            { file: '0001_a.sql', sha256: 'b'.repeat(64) },
          ],
        },
        /twice/,
      ],
      [
        {
          normalisation: NORMALISATION,
          migrations: [{ file: '0001_a.sql', sha256: 'a'.repeat(64), priorRevisions: 'x' }],
        },
        /priorRevisions/,
      ],
      [[], /not a JSON object/],
    ];
    for (const [body, pattern] of cases) {
      assert.match(parseManifest(JSON.stringify(body)).error ?? '', pattern);
    }
  });

  it('reports an unreadable migration instead of crashing', () => {
    const root = makeRoot({ files: renumberedFork() });
    mkdirSync(join(root, MIGRATIONS_DIR, '0099_not_a_file.sql'));
    const { failures } = checkKitMigrations(root);
    assert.equal(failures.length, 1);
    assert.match(failures[0], /0099_not_a_file\.sql: could not read \(EISDIR\)/);
  });

  it('with no migrations folder, says so and names every kit migration', () => {
    const { failures } = checkKitMigrations(makeRoot({ dir: false }));
    assert.match(failures[0], /could not list/);
    assert.equal(failures.length, 1 + Object.keys(KIT_FILES).length);
  });

  it('only *.sql files count — a README or dotfile is never a migration', () => {
    assert.deepEqual(sqlFiles(['README.md', '.DS_Store', '0002_b.sql', '0001_a.sql']), [
      '0001_a.sql',
      '0002_b.sql',
    ]);
    assert.equal(nextOrdinal([]), '0000');
    assert.equal(nextOrdinal(['0002_x.sql', '0002_y.sql', 'legacy.sql']), '0003');
    assert.equal(nextOrdinal(['0009_x.sql'], 2), '0012');
  });

  it('reads the folder wrangler applies: the DB binding’s migrations_dir, not a fixed path', () => {
    const moved = makeRoot({
      files: renumberedFork(),
      folder: 'db/migrations',
      d1: dbBinding({ migrations_dir: './db/migrations/' }),
    });
    const result = checkKitMigrations(moved);
    assert.deepEqual(result.failures, []);
    assert.match(run([], moved).out, /→ db\/migrations\/0003_read_log\.sql/);

    // A complete migrations/d1 that wrangler never applies clears nothing: the applied folder,
    // here the one a binding with no migrations_dir gets (wrangler's default, migrations/), lacks
    // every kit migration.
    const stale = makeRoot({ files: renumberedFork(), d1: dbBinding({}) });
    const { failures } = checkKitMigrations(stale);
    assert.equal(failures.length, Object.keys(KIT_FILES).length, failures.join('\n'));
    assert.match(failures[0], /0000_kit_app_identity\.sql has no copy in migrations\/\./);
    assert.match(
      failures.at(-1),
      /git show kit\/main:migrations\/d1\/0006_agent_tables\.sql > migrations\/\d{4}_/,
    );
  });

  it('refuses a staging config that applies from another folder, and any migrations_pattern', () => {
    const elsewhere = { d1_databases: dbBinding({ migrations_dir: 'db/staging' }) };
    const split = checkKitMigrations(makeRoot({ files: renumberedFork(), staging: elsewhere }));
    assert.equal(split.failures.length, 1, split.failures.join('\n'));
    assert.match(split.failures[0], /wrangler\.staging\.jsonc applies the DB migrations from/);

    const same = { d1_databases: dbBinding() };
    assert.deepEqual(
      checkKitMigrations(makeRoot({ files: renumberedFork(), staging: same })).failures,
      [],
    );
    // A staging config with no DB binding migrates nothing, so it has no folder to disagree on.
    const none = { d1_databases: [] };
    assert.deepEqual(
      checkKitMigrations(makeRoot({ files: renumberedFork(), staging: none })).failures,
      [],
    );
    // An env block binding DB elsewhere is the same split, inside one file.
    const envSplit = makeRoot({ files: renumberedFork() });
    const withEnv = {
      name: APP,
      vars: { APP_NAME: APP },
      d1_databases: dbBinding(),
      env: { preview: { d1_databases: dbBinding({ migrations_dir: 'db/preview' }) } },
    };
    writeFileSync(join(envSplit, 'wrangler.jsonc'), JSON.stringify(withEnv));
    const inFile = checkKitMigrations(envSplit).failures;
    assert.equal(inFile.length, 1, inFile.join('\n'));
    assert.match(inFile[0], /^wrangler\.jsonc applies the DB migrations from db\/preview\//);

    const patterned = makeRoot({
      files: renumberedFork(),
      d1: dbBinding({ migrations_dir: MIGRATIONS_DIR, migrations_pattern: '*.up.sql' }),
    });
    const { failures } = checkKitMigrations(patterned);
    assert.equal(failures.length, 1, failures.join('\n'));
    assert.match(failures[0], /wrangler\.jsonc: the DB binding sets "migrations_pattern"/);
  });

  it('refuses --write in an app: the manifest is the kit’s record', () => {
    const root = makeRoot({ files: renumberedFork() });
    const out = run(['--write'], root);
    assert.equal(out.code, 2);
    assert.match(out.out, /for the kit itself/);
    assert.equal(readFileSync(join(root, MANIFEST_FILE), 'utf8'), KIT_MANIFEST_TEXT);
  });
});

describe('the kit — the manifest held to the folder', KIT_ONLY, () => {
  const kitRoot = (files = KIT_FILES, manifest = KIT_MANIFEST_TEXT) =>
    makeRoot({ name: TEMPLATE_KEBAB, files, manifest });

  it('a new kit migration with no pin fails until --write pins it', () => {
    const files = { ...KIT_FILES, '0006_widgets.sql': 'CREATE TABLE widgets (id INTEGER);\n' };
    const root = kitRoot(files);
    const { failures } = checkKitMigrations(root);
    assert.equal(failures.length, 1);
    assert.match(failures[0], /0006_widgets\.sql is a kit migration no pin covers/);
    assert.match(failures[0], /--write/);
    // An unbootstrapped app reads as the kit; the message must not send it to --write alone.
    assert.match(failures[0], /npm run new-app/);

    const written = run(['--write'], root);
    assert.equal(written.code, 0, written.out);
    assert.equal(written.out, 'pinned 0006_widgets.sql');
    assert.deepEqual(checkKitMigrations(root).failures, []);
    // The existing pins are untouched; the new one is appended in order.
    const after = parseManifest(readFileSync(join(root, MANIFEST_FILE), 'utf8'));
    assert.deepEqual(after.migrations.slice(0, -1), KIT_MANIFEST.migrations);
    assert.equal(after.migrations.at(-1).file, '0006_widgets.sql');
  });

  it('an edited kit migration fails as immutable; a comment edit does not', () => {
    const commented = {
      ...KIT_FILES,
      '0001_read_log.sql': `-- clarified\n${KIT_FILES['0001_read_log.sql']}`,
    };
    assert.deepEqual(checkKitMigrations(kitRoot(commented)).failures, []);

    const edited = {
      ...KIT_FILES,
      '0001_read_log.sql': `${KIT_FILES['0001_read_log.sql']}\nSELECT 1;\n`,
    };
    const root = kitRoot(edited);
    const { failures } = checkKitMigrations(root);
    assert.equal(failures.length, 1);
    assert.match(failures[0], /0001_read_log\.sql changed after it was pinned/);
    assert.match(failures[0], /ship the change as a NEW migration/);

    const refused = run(['--write'], root);
    assert.equal(refused.code, 1);
    assert.match(refused.out, /nothing written/);
    assert.equal(readFileSync(join(root, MANIFEST_FILE), 'utf8'), KIT_MANIFEST_TEXT);
  });

  // A re-pin exists for a statement change no fork can have applied yet — typically a fix. The old
  // text is then exactly what a fork that copied early must NOT keep, so by default it stops being
  // accepted; --keep-prior is the deliberate exception for an equivalent rewrite.
  const repinned = (argv) => {
    const edited = {
      ...KIT_FILES,
      '0001_read_log.sql': `${KIT_FILES['0001_read_log.sql']}\nSELECT 1;\n`,
    };
    const root = kitRoot(edited);
    const out = run(['--write', '--repin', '0001_read_log.sql', ...argv], root);
    assert.equal(out.code, 0, out.out);
    assert.deepEqual(checkKitMigrations(root).failures, []);
    const manifest = parseManifest(readFileSync(join(root, MANIFEST_FILE), 'utf8'));
    const pin = manifest.migrations.find((m) => m.file === '0001_read_log.sql');
    return { out: out.out, manifest, pin };
  };
  const before = KIT_MANIFEST.migrations.find((m) => m.file === '0001_read_log.sql');

  it('--repin records the new hash and revokes the old one', () => {
    const { out, manifest, pin } = repinned([]);
    assert.match(out, /re-pinned 0001_read_log\.sql \(the old hash is no longer accepted\)/);
    assert.notEqual(pin.sha256, before.sha256);
    assert.deepEqual(pin.priorRevisions, []);
    // A fork still holding the old text now fails — as MODIFIED, pointing at the kit's new text.
    const { failures } = appFailures(manifest, renumberedFork(), APP);
    assert.equal(failures.length, 1, failures.join('\n'));
    assert.match(
      failures[0],
      /carries kit migration 0001_read_log\.sql's name but not its statements/,
    );
    assert.match(failures[0], /git show kit\/main:migrations\/d1\/0001_read_log\.sql/);
  });

  it('--repin --keep-prior keeps the old hash accepted, for an equivalent rewrite', () => {
    const { out, manifest, pin } = repinned(['--keep-prior']);
    assert.match(out, /re-pinned 0001_read_log\.sql \(the old hash stays accepted\)/);
    assert.deepEqual(pin.priorRevisions, [before.sha256]);
    assert.deepEqual(appFailures(manifest, renumberedFork(), APP).failures, []);
  });

  it('the kit’s identity migration may not seed the placeholder, and --write will not pin it', () => {
    const forged = {
      ...KIT_FILES,
      [IDENTITY_FILE]: KIT_FILES[IDENTITY_FILE].replace(
        `'${TEMPLATE_KEBAB}'`,
        APP_NAME_PLACEHOLDER,
      ),
    };
    const root = kitRoot(forged);
    const { failures } = checkKitMigrations(root);
    assert.equal(failures.length, 1, failures.join('\n'));
    assert.match(failures[0], /0000_kit_app_identity\.sql carries the literal '\{\{APP_NAME\}\}'/);
    const out = run(['--write', '--repin', IDENTITY_FILE], root);
    assert.equal(out.code, 1);
    assert.match(out.out, /nothing written/);
  });

  it('a pinned kit migration deleted or renamed fails, and --write will not drop its pin', () => {
    const files = { ...KIT_FILES };
    delete files['0002_read_log_kind.sql'];
    const root = kitRoot(files);
    const { failures } = checkKitMigrations(root);
    assert.equal(failures.length, 1);
    assert.match(failures[0], /pins 0002_read_log_kind\.sql, which is gone/);
    const out = run(['--write'], root);
    assert.equal(out.code, 1);
    assert.match(out.out, /gone from migrations\/d1\/ — restore it/);
  });

  it('--write builds a missing manifest from scratch, and refuses to overwrite a broken one', () => {
    const fresh = kitRoot(KIT_FILES, null);
    assert.equal(run(['--write'], fresh).code, 0);
    assert.equal(readFileSync(join(fresh, MANIFEST_FILE), 'utf8'), KIT_MANIFEST_TEXT);

    const broken = kitRoot(KIT_FILES, '{ not json');
    const out = run(['--write'], broken);
    assert.equal(out.code, 1);
    assert.match(out.out, /nothing written: .*not valid JSON/);
  });

  it('usage errors exit 2', () => {
    assert.equal(run(['--repin', 'x.sql']).code, 2);
    assert.equal(run(['--write', '--repin']).code, 2);
    assert.equal(run(['--write', '--keep-prior']).code, 2);
    assert.equal(run(['--keep-prior']).code, 2);
    assert.equal(run(['--write', '--repin', 'nope.sql'], kitRoot()).code, 1);
  });

  it('kitFailures is pure over a file map', () => {
    assert.deepEqual(kitFailures(KIT_MANIFEST, KIT_FILES, TEMPLATE_KEBAB), []);
  });
});

// This file is deliberately NOT in the /kit-upgrade diff set: most of it holds the kit's own
// manifest against the kit's own folder (KIT_ONLY above). The gate travels, its pins of the kit's
// tree do not.
describe('wiring', () => {
  it('runs in `npm run ci`, and in the CI workflow as a plain node step', () => {
    const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'));
    assert.equal(pkg.scripts['verify:kit-migrations'], 'node scripts/check-kit-migrations.mjs');
    assert.match(pkg.scripts.ci, /&& npm run verify:kit-migrations &&/);
    // `node …`, not `npm run …`: ci.yml rides /kit-upgrade and package.json does not, so a fork
    // runs the gate from the day it adopts the workflow, before it has added the npm script.
    const ci = readFileSync(join(REPO, '.github', 'workflows', 'ci.yml'), 'utf8');
    assert.match(ci, /^ {6}- run: node scripts\/check-kit-migrations\.mjs$/m);
  });

  it('runs in the production deploy before any migration is applied', () => {
    // deploy-prod.yml re-verifies with `npm run ci`, which in a fork lacks the gate until its
    // package.json gains the script (a manual step). The workflow rides /kit-upgrade like ci.yml,
    // so it runs the gate as its own `node` step — before the D1 preflight and `db:migrate`.
    const prod = readFileSync(join(REPO, '.github', 'workflows', 'deploy-prod.yml'), 'utf8');
    const gate = prod.search(/^ {8}run: node scripts\/check-kit-migrations\.mjs$/m);
    assert.ok(gate > 0, 'deploy-prod.yml runs node scripts/check-kit-migrations.mjs');
    for (const later of ['check-d1-identity.mjs --env production', 'npm run db:migrate']) {
      const at = prod.indexOf(later);
      assert.ok(at > gate, `the gate runs before ${later}`);
    }
  });
});

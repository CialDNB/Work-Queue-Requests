// Pins the database-migration wiring: the runner is wired into BOTH deploy paths and
// the D1 config points at migrations/d1, so a session can't quietly unwire "migrations
// apply on deploy" without CI noticing. Run by `node --test` (reads files via node:fs),
// so it's a *.test.mjs, outside the `test/**/*.test.ts` glob.
import { strict as assert } from 'node:assert';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { describe, it } from 'node:test';

const root = new URL('../../', import.meta.url);
const read = (p) => readFileSync(new URL(p, root), 'utf8');
const pkg = JSON.parse(read('package.json'));

describe('D1 migration scripts', () => {
  it('exposes migrate scripts for local, staging, and production', () => {
    assert.equal(pkg.scripts['db:migrate:local'], 'wrangler d1 migrations apply DB --local');
    // The two remote ones run for a CIAL app only: the deployment-target reader refuses a DB
    // Israel app first (test/platform/deployment-target.test.mjs, DECISIONS 2026-10-27).
    const cialOnly = 'node scripts/deployment-target.mjs --require cial && ';
    assert.equal(
      pkg.scripts['db:migrate:staging'],
      `${cialOnly}wrangler d1 migrations apply DB --remote --config wrangler.staging.jsonc`,
    );
    assert.equal(pkg.scripts['db:migrate'], `${cialOnly}wrangler d1 migrations apply DB --remote`);
  });

  it('points wrangler at migrations/d1 in both prod and staging config', () => {
    for (const cfg of ['wrangler.jsonc', 'wrangler.staging.jsonc']) {
      assert.match(read(cfg), /"migrations_dir"\s*:\s*"migrations\/d1"/, `${cfg} migrations_dir`);
    }
  });

  it('ships the migrations directories (empty but present)', () => {
    for (const dir of ['migrations/d1', 'migrations/supabase']) {
      assert.ok(existsSync(new URL(dir, root)), `${dir} exists`);
      assert.ok(existsSync(new URL(`${dir}/README.md`, root)), `${dir}/README.md exists`);
    }
  });
});

// THE CROSS-APP INVARIANT (DECISIONS 2026-08-18). Every `wrangler d1` command in this repo
// addresses the database by its BINDING (`DB`), never by its `database_name`. The binding
// resolves through the wrangler config, whose `database_id` is pinned to a uuid — wrangler's
// getDatabaseByNameOrBinding() short-circuits on that and makes no API call. A raw NAME that
// does not match `database_name` in the config falls through to
// `GET /accounts/{id}/d1/database/{name}` — an ACCOUNT-WIDE lookup. Every app built on the kit
// shares one Cloudflare account, so on that path a stale or copied name resolves to a SIBLING
// APP'S DATABASE and migrations run DDL against it. Cloudflare audit-logs nothing for
// /d1/.../query, so that would be silent. One identifier, pinned in one place, is the fix.
//
// Pinned everywhere a command can run from: every package.json script (not only `db:*` — a
// `seed:demo` running `wrangler d1 execute` is as live as `db:apply`), every workflow, and every
// script under scripts/. Pinned for every subcommand that takes a database, not only `execute`
// and `migrations` (D1_TARGETED). A command the pin cannot read fails rather than passing unread.
// This block stands alone (constants, readers, one describe) so a fork can lift it whole.

// wrangler 4.151.3's d1 commands (`wrangler d1 --help` and its `migrations` and `time-travel`
// groups), split by whether the positional names an EXISTING database. Each targeted one resolves
// it through getDatabaseByNameOrBinding() or getDatabaseInfoFromConfig(), binding and
// database_name alike, so each is pinned to `DB`. `delete` is the sharpest: on the account-wide
// fall-through a stale name deletes a sibling's database. `create` names the database it is about
// to make and `list` takes no positional, so neither has a target. A subcommand in neither set
// fails until it is classified here, so the next one wrangler ships cannot pass as "not one we
// check".
const D1_TARGETED = new Set([
  'delete',
  'execute',
  'export',
  'info',
  'insights',
  'migrations apply',
  'migrations create',
  'migrations list',
  'time-travel info',
  'time-travel restore',
]);
const D1_UNTARGETED = new Set(['create', 'list']);
const D1_GROUPS = new Set(['migrations', 'time-travel']);
const D1_FIRST_WORDS = new Set([...D1_TARGETED, ...D1_UNTARGETED].map((s) => s.split(' ')[0]));
// A token that IS wrangler: bare, a path ending in it, or a pinned `wrangler@x.y.z`.
const WRANGLER_TOKEN = /\bwrangler(?:@\S+)?$/;

// `wrangler d1 <subcommand> <target>`: d1 straight after wrangler (a pinned `wrangler@x.y.z`
// too), and the target is the token right after the subcommand, so flags go after it — which is
// how every command in the kit is written. The tokens sit in a lookahead so that
// `wrangler d1 list && wrangler d1 delete x` yields both commands, not the first alone.
const D1_COMMAND = /\bwrangler(?:@\S+)?\s+d1\s+(?=(\S+)(?:\s+(\S+))?(?:\s+(\S+))?)/g;

// The net under D1_COMMAND: on a line that runs wrangler, every ` d1 ` word must sit straight
// after it. `wrangler -c x d1 execute …` or `wrangler $FLAGS d1 …` is a command the strict form
// cannot read, so it fails instead of passing unchecked.
const unreadable = (line) =>
  [...line.matchAll(/(\S+)\s+d1(?=\s|$)/g)].some(
    (m) => /\bwrangler\b/.test(line.slice(0, m.index + m[1].length)) && !WRANGLER_TOKEN.test(m[1]),
  );

// The argv form a script spawns wrangler with (`run('npx', ['wrangler', 'd1', 'execute', binding,
// …])`), rendered back into a command line, a non-literal element as `${expr}`, so it meets the
// same reader. An array holding 'd1' counts when 'wrangler' comes anywhere before it (flags in
// between too, so an unknown subcommand there still fails as unclassified) or a d1 subcommand
// follows it (an argv built apart from the spawn); central-proposal's ['d1', 'kv', 'r2'] is neither.
function argvCommands(text) {
  const out = [];
  for (const [, body] of text.matchAll(/\[([^\]]*)\]/g)) {
    const els = body
      .split(',')
      .map((e) => e.trim())
      .filter(Boolean)
      .map((e) => e.match(/^(['"`])(.*)\1$/s)?.[2] ?? `\${${e}}`);
    const i = els.indexOf('d1');
    if (i === -1) continue;
    if (els.slice(0, i).some((e) => WRANGLER_TOKEN.test(e)) || D1_FIRST_WORDS.has(els[i + 1])) {
      out.push(`wrangler ${els.slice(i).join(' ')}`);
    }
  }
  return out;
}

// Comment lines are prose, not commands (check-d1-identity.mjs documents the
// `wrangler d1 execute --json` output it parses), so a script is read without them. A comment
// trailing a code line is still read, and so is a shell `case` default branch (`*) …`).
const codeOnly = (text) =>
  text
    .split('\n')
    .filter((l) => !/^\s*(?:#|\/\/|\/\*|\*(?!\)))/.test(l))
    .join('\n');

/**
 * Every `wrangler d1` command in `text` as { sub, target, line, argv }, and every way one breaks
 * the rule. `allowed` names the `<subcommand> <target>` pairs besides `DB` this one source may
 * pass (the scripts/ exception below); `argv` also reads the spawn-argv form.
 */
function auditD1(where, text, { allowed = [], argv = false } = {}) {
  // A shell line continuation is one command: `wrangler d1 execute \⏎  DB`.
  const src = text.replace(/\\\r?\n[ \t]*/g, ' ');
  const commands = [];
  for (const s of [src, ...(argv ? argvCommands(src) : [])]) {
    for (const m of s.matchAll(D1_COMMAND)) {
      const [, a, b, c] = m;
      const line = s.slice(m.index).split('\n')[0].trim();
      const [sub, target] = D1_GROUPS.has(a) ? [`${a} ${b}`, c] : [a, b];
      commands.push({ sub, target, line, argv: s !== src });
    }
  }
  const problems = [];
  for (const { sub, target, line } of commands) {
    if (D1_UNTARGETED.has(sub)) continue;
    if (!D1_TARGETED.has(sub)) {
      problems.push(
        `${where}: unclassified "wrangler d1 ${sub}" — add it to D1_TARGETED or ` +
          `D1_UNTARGETED in test/platform/migrations.test.mjs: ${line}`,
      );
    } else if (target !== 'DB' && !allowed.includes(`${sub} ${target}`)) {
      problems.push(`${where} must target the DB binding, got "${target}" in: ${line}`);
    }
  }
  for (const line of src.split('\n').filter(unreadable)) {
    problems.push(
      `${where}: a wrangler d1 command this pin cannot read — write it as ` +
        `\`wrangler d1 <subcommand> DB [flags]\`: ${line.trim()}`,
    );
  }
  return { commands, problems };
}

// The one source that may pass a binding other than `DB`: check-d1-identity.mjs probes EVERY d1
// binding the config declares (a second binding carrying a sibling's database_id is the bypass it
// exists to catch), so its probe and the hand-stamp command it prints pass `${binding}` — always a
// value of declaredD1Bindings(), a `binding` key from the config's own d1_databases, which
// resolves through that config's pinned database_id. Still a binding, never a database_name.
// Allowed for that `execute` alone: any other subcommand on `${binding}` there gets reviewed.
const BINDING_VAR = `\${binding}`;
const SCRIPT_TARGETS = { 'scripts/check-d1-identity.mjs': [`execute ${BINDING_VAR}`] };

describe('D1 is addressed by its binding, never by its database_name', () => {
  it('in every package.json script, not only db:*', () => {
    const problems = [];
    let found = 0;
    for (const [name, cmd] of Object.entries(pkg.scripts)) {
      const audit = auditD1(name, cmd);
      problems.push(...audit.problems);
      found += audit.commands.length;
    }
    assert.deepEqual(problems, []);
    assert.ok(found >= 6, `expected the db:* d1 scripts, found ${found} d1 commands`);
  });

  it('in every workflow — the provisioning seed steps included', () => {
    // The seed steps used to name the database (`wrangler d1 execute <app>-db …`), justified as
    // "the config is still a placeholder there". It is not: the same job ran provision.mjs two
    // steps earlier, which wrote the real database_id into the config ON DISK, and the step in
    // between (`npm run db:apply:staging`) already resolves the binding. A raw name renamed to a
    // SIBLING's (the fork-from-a-sibling case) would fall through to wrangler's account-wide
    // name lookup and seed an owner row into that sibling's users table, unlogged. Reverses
    // DECISIONS 2026-06-17 rejected-option (b); see 2026-08-18. Comments are read too: a
    // commented-out step is one keystroke from running.
    const workflows = readdirSync(new URL('.github/workflows/', root)).filter((f) =>
      /\.ya?ml$/.test(f),
    );
    const problems = [];
    const seen = [];
    for (const file of workflows) {
      const audit = auditD1(file, read(`.github/workflows/${file}`));
      problems.push(...audit.problems);
      if (audit.commands.some((c) => D1_TARGETED.has(c.sub))) seen.push(file);
    }
    assert.deepEqual(problems, []);
    // The commands this pin exists for must actually be present, or the loop proves nothing.
    for (const f of [
      'provision-staging.yml',
      'provision-production.yml',
      'ci.yml',
      'deploy-prod.yml',
    ]) {
      assert.ok(seen.includes(f), `${f} has a wrangler d1 command`);
    }
  });

  it('in every script under scripts/ — spawned argv and printed commands alike', () => {
    // Every FILE under scripts/ that is a script: by extension, or an extensionless executable by
    // its shebang (`scripts/seed` starting `#!/usr/bin/env bash` runs just the same).
    const files = readdirSync(new URL('scripts/', root), { recursive: true })
      .map((f) => `scripts/${f}`)
      .filter((f) => statSync(new URL(f, root)).isFile())
      .filter((f) => /\.(?:sh|bash|zsh|[cm]?js|ts)$/.test(f) || read(f).startsWith('#!'));
    const problems = [];
    const identity = [];
    for (const file of files) {
      const audit = auditD1(file, codeOnly(read(file)), {
        argv: true,
        allowed: SCRIPT_TARGETS[file],
      });
      problems.push(...audit.problems);
      if (file === 'scripts/check-d1-identity.mjs') identity.push(...audit.commands);
    }
    assert.deepEqual(problems, []);
    // The exception must still be earned, and both readers must have read a real command, or
    // this proves nothing: the identity probe (argv) and the hand-stamp command it prints (text).
    const earned = identity.filter((c) => c.sub === 'execute' && c.target === BINDING_VAR);
    assert.ok(
      earned.some((c) => c.argv),
      'check-d1-identity.mjs probe read as argv',
    );
    assert.ok(
      earned.some((c) => !c.argv),
      'check-d1-identity.mjs hand-stamp command read as text',
    );
  });

  it('goes red on every shape it claims to read', () => {
    // A reader that silently stopped matching would turn the three cases above into loops over
    // nothing, green. Each of these must fail FOR ITS OWN REASON, the expected message rather than
    // any problem (a broken continuation join still fails, on target "\\"); the ones after pass.
    const named = 'must target the DB binding, got "my-app-db';
    const red = [
      ...[...D1_TARGETED].map((sub) => [`npx wrangler d1 ${sub} my-app-db --remote`, named]),
      ['npx wrangler@4.151.3 d1 export my-app-db --output dump.sql', named],
      [`wrangler d1 list && wrangler d1 ${'delete'} my-app-db -y`, named],
      ['npx wrangler d1 execute \\\n  my-app-db --remote', named],
      ['wrangler d1 execute --remote my-app-db', 'got "--remote"'],
      ['wrangler -c wrangler.staging.jsonc d1 execute DB --remote', 'cannot read'],
      ['wrangler $FLAGS d1 execute DB', 'cannot read'],
      ['wrangler d1 backup DB', 'unclassified "wrangler d1 backup"'],
      ["run('npx', ['wrangler', 'd1', 'execute', 'my-app-db', '--remote'])", named],
      [
        "execFileSync('npx', ['wrangler', 'd1', 'migrations', 'apply', dbName])",
        `got "\${dbName}"`,
      ],
      ["const args = ['d1', 'time-travel', 'restore', name, '--timestamp', ts];", `got "\${name}"`],
      ["run('npx', ['wrangler@4.151.3', 'd1', 'backup', 'DB'])", 'unclassified'],
      ["run('npx', ['wrangler', '-c', cfg, 'd1', 'backup', 'DB'])", 'unclassified'],
      ["// prose\nexecSync('npx wrangler d1 info my-app-db')", named],
      ['case "$1" in\n  *) npx wrangler d1 execute my-app-db --remote ;;\nesac', named],
    ];
    for (const [src, expect] of red) {
      const { problems } = auditD1('red', codeOnly(src), { argv: true });
      assert.ok(
        problems.some((p) => p.includes(expect)),
        `must fail with "${expect}": ${src}\n  got: ${JSON.stringify(problems)}`,
      );
    }
    // The scripts/ allowance covers its one subcommand, not every subcommand on that target.
    const allowed = SCRIPT_TARGETS['scripts/check-d1-identity.mjs'];
    assert.deepEqual(auditD1('ok', `wrangler d1 execute ${BINDING_VAR}`, { allowed }).problems, []);
    assert.notDeepEqual(
      auditD1('red', `wrangler d1 export ${BINDING_VAR}`, { allowed }).problems,
      [],
      'the allowance does not reach another subcommand',
    );

    const green = [
      'wrangler d1 execute DB --remote --file schema.sql',
      'npx wrangler d1 migrations list DB --remote --config wrangler.staging.jsonc || true',
      'wrangler d1 list',
      'wrangler d1 create my-app-db',
      'npx wrangler d1 execute \\\n  DB --remote --file schema.sql',
      "run('npx', ['wrangler', 'd1', 'time-travel', 'info', 'DB', '--json'])",
      "const RESOURCE_KINDS = ['d1', 'kv', 'r2'];",
      codeOnly('# wrangler d1 info my-app-db\n * `wrangler d1 execute --json` output'),
    ];
    for (const src of green) {
      assert.deepEqual(auditD1('green', src, { argv: true }).problems, [], `must pass: ${src}`);
    }
  });
});

describe('deploy paths run migrations before shipping the Worker', () => {
  // staging auto-deploy (ci.yml) + manual prod (deploy-prod.yml) both migrate, both envs.
  // The D1 runner regex matches the env's apply command DISTINCTLY — the prod one uses a
  // negative lookahead so `npm run db:migrate` can't be satisfied by `db:migrate:supabase`
  // (deleting the prod D1 step would otherwise pass on that prefix).
  const cases = [
    ['.github/workflows/ci.yml', /npm run db:migrate:staging\b/],
    ['.github/workflows/deploy-prod.yml', /npm run db:migrate(?!:)/],
  ];
  for (const [file, runnerRe] of cases) {
    it(`${file} applies D1 + Supabase migrations ahead of the deploy`, () => {
      const text = read(file);
      const migrateAt = text.search(runnerRe);
      const supabaseAt = text.indexOf('db:migrate:supabase');
      // Anchor on the deploy STEP, not the word "deploy" in a header comment.
      const deployAt = text.indexOf('name: Deploy to');
      assert.ok(migrateAt !== -1, 'D1 migrate command present');
      assert.ok(supabaseAt !== -1, 'Supabase migrate step present');
      assert.ok(deployAt !== -1, 'deploy step present');
      assert.ok(migrateAt < deployAt, 'D1 migrations run before deploy');
      assert.ok(supabaseAt < deployAt, 'Supabase migrations run before deploy');
    });
  }

  it('gates each deploy on its OWN-environment Supabase secret (staging is isolated from prod)', () => {
    // Staging migrates the staging project; prod migrates the prod project — two separate
    // Supabase instances, mirroring the two D1 databases (no staging→prod data bleed).
    assert.match(
      read('.github/workflows/ci.yml'),
      /SUPABASE_DB_URL:\s*\$\{\{\s*secrets\.SUPABASE_DB_URL_STAGING\s*\}\}/,
      'staging uses SUPABASE_DB_URL_STAGING',
    );
    assert.doesNotMatch(
      read('.github/workflows/ci.yml'),
      /secrets\.SUPABASE_DB_URL\s*\}\}/,
      'staging must NOT use the prod SUPABASE_DB_URL',
    );
    assert.match(
      read('.github/workflows/deploy-prod.yml'),
      /SUPABASE_DB_URL:\s*\$\{\{\s*secrets\.SUPABASE_DB_URL\s*\}\}/,
      'prod uses SUPABASE_DB_URL',
    );
  });
});

describe('Supabase runner is inert-by-default', () => {
  it('exists, is executable, and skips when SUPABASE_DB_URL is unset', () => {
    const script = 'scripts/migrate-supabase.sh';
    assert.ok(existsSync(new URL(script, root)), 'script exists');
    assert.ok(statSync(new URL(script, root)).mode & 0o111, 'script is executable');
    const text = read(script);
    assert.match(text, /SUPABASE_DB_URL:-/, 'guards on SUPABASE_DB_URL');
    assert.match(text, /_kit_schema_migrations/, 'tracks applied migrations');
    assert.match(text, /kit:no-transaction/, 'supports the no-transaction opt-out');
  });
});

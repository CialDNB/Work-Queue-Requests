// Tests for the editor-agnostic git-native guards (.claude/hooks/lib/block-*.mjs): the twins of
// guard-bash that give Cursor / VS Code / plain-git users the same protected-branch protection,
// and the secrets-file commit guard. Runs each guard as a subprocess the way .githooks/ invokes
// it: the commit guards read the branch / index via git (so they need a real throwaway repo); the
// push guard reads a refspec on stdin. Plain `node --test`, wired into CI via `test:hooks`.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { isProtectedBranch, PROTECTED_BRANCHES } from './lib/protected-branches.mjs';
import { initRepo, repoGit } from './lib/throwaway-repo.mjs';

const COMMIT_GUARD = fileURLToPath(new URL('./lib/block-protected-commit.mjs', import.meta.url));
const PUSH_GUARD = fileURLToPath(new URL('./lib/block-protected-push.mjs', import.meta.url));
const SECRET_GUARD = fileURLToPath(new URL('./lib/block-secret-commit.mjs', import.meta.url));

// Clear the ambient overrides so a developer/CI who has one exported can't silently flip the
// "blocks" assertions to pass-open; a test that wants an override sets it explicitly via `env`
// (spread last, so it wins).
function childEnv(env) {
  return {
    ...process.env,
    PAVEDROAD_ALLOW_PROTECTED: '',
    PAVEDROAD_ALLOW_SECRET_FILE: '',
    ...env,
  };
}

// Exit code of the commit guard with cwd = repo (0 = allow, 1 = block).
function commitExit(cwd, env = {}) {
  try {
    execFileSync(process.execPath, [COMMIT_GUARD], { cwd, stdio: 'ignore', env: childEnv(env) });
    return 0;
  } catch (e) {
    return e.status ?? 1;
  }
}

// Exit code of the push guard fed `stdin` (the refspec lines git would pass).
function pushExit(stdin, env = {}) {
  try {
    execFileSync(process.execPath, [PUSH_GUARD], {
      input: stdin,
      stdio: ['pipe', 'ignore', 'ignore'],
      env: childEnv(env),
    });
    return 0;
  } catch (e) {
    return e.status ?? 1;
  }
}

test('protected-branches definition is the shared source of truth', () => {
  assert.deepEqual(PROTECTED_BRANCHES, ['main', 'master']);
  assert.equal(isProtectedBranch('main'), true);
  assert.equal(isProtectedBranch('master'), true);
  assert.equal(isProtectedBranch(' main '), true); // trims
  assert.equal(isProtectedBranch('feature/x'), false);
  assert.equal(isProtectedBranch(''), false);
  assert.equal(isProtectedBranch(null), false);
});

test('commit guard blocks on main/master, allows a feature branch', () => {
  const onMain = initRepo('main');
  const onMaster = initRepo('master');
  const onFeature = initRepo('feature/x');
  try {
    assert.equal(commitExit(onMain), 1);
    assert.equal(commitExit(onMaster), 1);
    assert.equal(commitExit(onFeature), 0);
  } finally {
    for (const d of [onMain, onMaster, onFeature]) rmSync(d, { recursive: true, force: true });
  }
});

test('commit guard honors the PAVEDROAD_ALLOW_PROTECTED escape hatch', () => {
  const onMain = initRepo('main');
  try {
    assert.equal(commitExit(onMain, { PAVEDROAD_ALLOW_PROTECTED: '1' }), 0);
  } finally {
    rmSync(onMain, { recursive: true, force: true });
  }
});

test('commit guard fails open outside a git repo', () => {
  assert.equal(commitExit(tmpdir()), 0);
});

test('push guard blocks a refspec targeting main/master', () => {
  assert.equal(pushExit('refs/heads/x abc refs/heads/main def\n'), 1);
  assert.equal(pushExit('refs/heads/x abc refs/heads/master def\n'), 1);
  // Catches main in ANY ref line, not just the first.
  assert.equal(
    pushExit('refs/heads/a 1 refs/heads/feature 2\nrefs/heads/b 3 refs/heads/main 4\n'),
    1,
  );
  // A DELETE-push of main (`git push origin --delete main`) — git sends "(delete)" as the
  // single-token local ref, so parts[2] is still refs/heads/main. Deleting main must be blocked.
  assert.equal(
    pushExit(
      '(delete) 0000000000000000000000000000000000000000 refs/heads/main 0000000000000000000000000000000000000000\n',
    ),
    1,
  );
});

test('push guard allows feature-branch pushes, tags, and tolerates non-refspec input', () => {
  assert.equal(pushExit('refs/heads/x abc refs/heads/feature/x def\n'), 0);
  assert.equal(pushExit('refs/heads/x abc refs/heads/release/v2 def\n'), 0);
  // A tag push targets refs/tags/* — not a protected BRANCH, so it's allowed (the strip only
  // matches refs/heads/, so refs/tags/main stays "refs/tags/main", which isn't protected).
  assert.equal(pushExit('refs/tags/v1 abc refs/tags/v1 def\n'), 0);
  assert.equal(pushExit('refs/tags/main abc refs/tags/main def\n'), 0);
  assert.equal(pushExit(''), 0); // empty stdin → nothing to judge
  assert.equal(pushExit('garbage line\n'), 0); // malformed → ignored
});

test('push guard honors the PAVEDROAD_ALLOW_PROTECTED escape hatch', () => {
  assert.equal(
    pushExit('refs/heads/x abc refs/heads/main def\n', { PAVEDROAD_ALLOW_PROTECTED: '1' }),
    0,
  );
});

// The secrets guard against the repo's index (cwd = repo): exit status + what it printed.
function secretCheck(cwd, env = {}) {
  const r = spawnSync(process.execPath, [SECRET_GUARD], {
    cwd,
    encoding: 'utf8',
    env: childEnv(env),
  });
  return { status: r.status, stderr: r.stderr };
}

// A throwaway repo on a feature branch, with `files` (path → text) written and committed by
// force, so a later edit stages against a HEAD version. Fixture values are deliberately not
// secret-shaped: CI's gitleaks scan reads every branch.
function secretRepo(files = {}) {
  const dir = initRepo('feature/x');
  const git = repoGit(dir);
  const write = (path, text) => {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), text);
  };
  for (const [path, text] of Object.entries(files)) write(path, text);
  if (Object.keys(files).length > 0) {
    git('add', '-f', '--', ...Object.keys(files));
    git('commit', '-m', 'fixtures');
  }
  return { dir, git, write };
}

test('secret guard blocks a force-added secrets file at any depth, naming it', () => {
  const { dir, git, write } = secretRepo();
  try {
    for (const path of [
      '.env',
      'tools/bruno/cf-provisioning/.env',
      'tools/bruno/cf-provisioning/.env.bak',
      '.dev.vars',
      'tools/secrets-migrator/.dev.vars.staging',
      '.secrets.json',
      '.secrets.production.json',
    ]) {
      write(path, 'VALUE=x\n');
      git('add', '-f', '--', path);
      const { status, stderr } = secretCheck(dir);
      assert.equal(status, 1, path);
      assert.match(stderr, new RegExp(`    ${path.replaceAll('.', '\\.')}\\n`), path);
      git('reset', '-q');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('secret guard allows templates, look-alike names, and removing a tracked secrets file', () => {
  const { dir, git, write } = secretRepo({ 'old/.env': 'VALUE=x\n' });
  try {
    for (const path of [
      '.env.example',
      'tools/bruno/cf-provisioning/.env.example',
      '.dev.vars.example',
      '.envrc',
      'src/env.ts',
      'secrets.json',
      'README.md',
    ])
      write(path, 'VALUE=x\n');
    git('add', '-A');
    git('rm', '-q', '--cached', 'old/.env');
    assert.equal(secretCheck(dir).status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('secret guard blocks a value pasted into a committed template, allows other edits', () => {
  const template = [
    '# comment',
    'BLANK=',
    'PLACEHOLDER=replace-me',
    'QUOTED = "replace-me"',
    '',
  ].join('\n');
  const { dir, git, write } = secretRepo({
    '.dev.vars.example': template,
    'tools/bruno/cf-provisioning/.env.example': template,
  });
  const staged = (path, text) => {
    write(path, text);
    git('add', '--', path);
    const result = secretCheck(dir);
    git('reset', '-q', '--hard');
    return result;
  };
  try {
    for (const path of ['.dev.vars.example', 'tools/bruno/cf-provisioning/.env.example']) {
      const filled = staged(path, template.replace('BLANK=', 'BLANK=filled'));
      assert.equal(filled.status, 1, `${path}: blank filled in`);
      assert.match(filled.stderr, new RegExp(`${path.replaceAll('.', '\\.')}  \\(BLANK\\)`));
    }
    const path = '.dev.vars.example';
    assert.equal(staged(path, template.replace('=replace-me', '=filled')).status, 1);
    assert.equal(staged(path, template.replace('"replace-me"', '"filled"')).status, 1);
    // Clearing a value, adding a key, re-quoting the same value, editing comments: no leak.
    assert.equal(staged(path, template.replace('=replace-me', '=')).status, 0);
    assert.equal(staged(path, `${template}NEW_KEY=default\n`).status, 0);
    assert.equal(staged(path, template.replace('=replace-me', '="replace-me"')).status, 0);
    assert.equal(staged(path, template.replace('# comment', '# reworded')).status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('secret guard honors the PAVEDROAD_ALLOW_SECRET_FILE escape hatch', () => {
  const { dir, git, write } = secretRepo();
  try {
    write('.env', 'VALUE=x\n');
    git('add', '-f', '.env');
    const { status, stderr } = secretCheck(dir, { PAVEDROAD_ALLOW_SECRET_FILE: '1' });
    assert.equal(status, 0);
    assert.match(stderr, /PAVEDROAD_ALLOW_SECRET_FILE=1/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('secret guard fails open outside a git repo', () => {
  assert.equal(secretCheck(tmpdir()).status, 0);
});

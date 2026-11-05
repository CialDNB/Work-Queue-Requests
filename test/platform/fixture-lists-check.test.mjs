// Pins the fork check in CHANGELOG "Ordered fixture batches in the D1 test helper", fork step 3:
// the `git diff … | grep` line that lists the lines of `TABLES`, `WORM_TABLES` and the KV prefix
// list that an upgrade's merge removed. The step says a whole-file take of test/helpers/db.ts
// shows up there as the lines that held the fork's entries, and nothing else tells a fork they
// are gone: no kit test writes to a fork's tables or prefixes. So this runs the documented line,
// as the CHANGELOG writes it, in scratch git repos holding fork-shaped copies of the kit's
// CURRENT helper:
//   - a whole-file take prints a line naming every fork entry, before AND after the adopt is
//     committed (#289 review R2: `git diff HEAD` printed nothing once the adopt was committed);
//   - an entry with a trailing `//` comment counts, and so does a list written one entry per line
//     (#289 review R1: two forks have commented TABLES entries, one an expanded prefix list);
//   - a correct re-merge, and a fork with no entries of its own, print nothing.
// A kit change that renames or reshapes these lists turns this red. Forks run this check on every
// upgrade that crosses this release, so such a change needs its own manual step.
//
// This is a drift tripwire for the documented command, not proof that a merge is right.
// Kit only: CHANGELOG.md is the kit's own release notes. Run by `node --test` (test:scripts).
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
// The kit itself: its marketplace manifest never survives into a fork (new-app strips it).
const IN_KIT = existsSync(join(REPO, '.claude-plugin', 'marketplace.json'));
const HELPER = 'test/helpers/db.ts';

// The scratch repos must never reach the repo running the suite: a GIT_DIR or GIT_WORK_TREE
// leaked from a hook or a rebase would point every command below at it. Drop every GIT_*
// variable, and ignore the machine's git config (signing, hooks, default branch).
const ENV = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')),
);
ENV.GIT_CONFIG_NOSYSTEM = '1';
ENV.GIT_CONFIG_GLOBAL = '/dev/null';
const CONFIG = [
  ['user.name', 'fork'],
  ['user.email', 'fork@example.invalid'],
  ['commit.gpgsign', 'false'],
  ['core.hooksPath', '/dev/null'],
  ['init.defaultBranch', 'main'],
].flatMap(([key, value]) => ['-c', `${key}=${value}`]);

function git(cwd, ...args) {
  const run = spawnSync('git', [...CONFIG, ...args], { cwd, env: ENV, encoding: 'utf8' });
  assert.equal(run.status, 0, `git ${args.join(' ')}: ${run.stderr}`);
}

// Fork step 3's command, exactly as the CHANGELOG entry writes it.
function documentedCheck() {
  const changelog = readFileSync(join(REPO, 'CHANGELOG.md'), 'utf8');
  const start = changelog.indexOf('**Ordered fixture batches in the D1 test helper');
  assert.ok(start > 0, 'the ordered-fixture-batches CHANGELOG entry');
  const ends = ['\n- **', '\n## ']
    .map((marker) => changelog.indexOf(marker, start))
    .filter((at) => at > 0);
  const entry = changelog.slice(start, ends.length ? Math.min(...ends) : undefined);
  const commands = [
    ...entry.matchAll(/`(git diff [^`]*-- test\/helpers\/db\.ts \| grep -E [^`]+)`/g),
  ];
  assert.equal(commands.length, 1, 'fork step 3 gives one `git diff … | grep -E …` check');
  return commands[0][1];
}

// The shells the command is pasted into: sh everywhere, zsh where it exists (macOS's default),
// without the machine's startup files.
const SHELLS = [
  ['sh', []],
  ['zsh', ['-f']],
].filter(([shell, flags]) => spawnSync(shell, [...flags, '-c', 'true'], { env: ENV }).status === 0);

const KIT = readFileSync(join(REPO, HELPER), 'utf8');

function mustFind(src, anchor) {
  const at = src.indexOf(anchor);
  assert.ok(
    at >= 0,
    `${HELPER} no longer has \`${anchor.trim()}\`. The CHANGELOG fork check finds the fork's ` +
      'entries by it: update the check, and give forks a manual step for the new shape.',
  );
  return at;
}

// The quoted names between `opener` and `closer`, comments stripped.
function namesIn(src, opener, closer) {
  const start = mustFind(src, opener) + opener.length;
  const body = src.slice(start, src.indexOf(closer, start));
  return [...body.replace(/\/\/.*$/gm, '').matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

// Rewrites a list one entry per line, as Biome does once it outgrows a line, with `extra` (whole
// lines, comments allowed) at the end.
function expand(src, opener, closer, indent, extra) {
  const start = mustFind(src, opener);
  const end = src.indexOf(closer, start + opener.length);
  const entries = [...namesIn(src, opener, closer).map((name) => `'${name}',`), ...extra];
  const body = entries.map((entry) => `${indent}  ${entry}\n`).join('');
  return `${src.slice(0, start)}${opener}\n${body}${indent}${src.slice(end)}`;
}

const TABLES_OPEN = 'const TABLES = [\n';
const WORM_OPEN = 'const WORM_TABLES = [';
const PREFIX_OPEN = 'for (const prefix of [';

// The release before this one: the kit has since added a table (here, its first TABLES entry).
// A correct re-merge then ADDS that line, which the check must not print.
function olderKit() {
  const start = mustFind(KIT, TABLES_OPEN);
  const first = /\n {2}'[^']+',\n/.exec(KIT.slice(start));
  assert.ok(first, 'TABLES has an entry');
  const at = start + first.index;
  return KIT.slice(0, at) + KIT.slice(at + first[0].length - 1);
}

// The fork's entries in the kit's own list shapes: TABLES one per line (one of them commented),
// WORM_TABLES and the prefix list on one line each.
function inlineFork(src) {
  mustFind(src, TABLES_OPEN);
  let out = src.replace(
    TABLES_OPEN,
    `${TABLES_OPEN}  'orders',\n  'order_settings', // one row; an absent row reads as the default\n`,
  );
  mustFind(out, WORM_OPEN);
  out = out.replace(WORM_OPEN, `${WORM_OPEN}'stage_events', `);
  mustFind(out, PREFIX_OPEN);
  return out.replace(PREFIX_OPEN, `${PREFIX_OPEN}'cart:', `);
}

// The same entries once WORM_TABLES and the prefix list have grown to one entry per line, each
// fork entry with a trailing comment.
function expandedFork(src) {
  mustFind(src, TABLES_OPEN);
  let out = src.replace(
    TABLES_OPEN,
    `${TABLES_OPEN}  'orders', // children before parents\n  'order_settings', // one row\n`,
  );
  out = expand(out, WORM_OPEN, ']', '', ["'stage_events', // its triggers refuse DELETE"]);
  const prefixLine = out.lastIndexOf('\n', mustFind(out, PREFIX_OPEN)) + 1;
  const indent = out.slice(prefixLine, out.indexOf(PREFIX_OPEN));
  return expand(out, PREFIX_OPEN, ']', indent, ["'cart:', // the basket"]);
}

const FORK_ENTRIES = ['orders', 'order_settings', 'stage_events', 'cart:'];

describe('the CHANGELOG fork check for test/helpers/db.ts lists (ordered fixture batches)', {
  skip: IN_KIT ? false : "kit only: CHANGELOG.md is the kit's own release notes",
}, () => {
  let root;
  let check;
  before(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'fixture-lists-check-')));
    check = documentedCheck();
  });
  after(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  // A fork on its main with `forkMain`, then on an upgrade branch with `merged` in the work tree
  // (committed when `commit`). Returns what the documented check prints, per shell.
  let n = 0;
  function runCheck(forkMain, merged, { commit }) {
    const dir = join(root, `fork-${++n}`);
    mkdirSync(join(dir, 'test', 'helpers'), { recursive: true });
    git(dir, 'init', '-q');
    writeFileSync(join(dir, HELPER), forkMain);
    git(dir, 'add', HELPER);
    git(dir, 'commit', '-q', '-m', 'fork main before the upgrade');
    git(dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    git(dir, 'checkout', '-q', '-b', 'kit-upgrade');
    writeFileSync(join(dir, HELPER), merged);
    if (commit) git(dir, 'commit', '-q', '-am', 'adopt the kit helper');
    return SHELLS.map(([shell, flags]) => {
      const run = spawnSync(shell, [...flags, '-c', check], {
        cwd: dir,
        env: ENV,
        encoding: 'utf8',
      });
      // grep exits 1 when it prints nothing; git's own failure shows only on stderr.
      assert.ok(run.status === 0 || run.status === 1, `${shell}: exit ${run.status}`);
      assert.equal(run.stderr, '', `${shell}: the check failed to run`);
      return { shell, printed: run.stdout.split('\n').filter(Boolean) };
    });
  }

  for (const [shape, fork] of [
    ['the kit list shapes', inlineFork],
    ['one entry per line, commented', expandedFork],
  ]) {
    for (const commit of [false, true]) {
      const when = commit ? 'after the adopt is committed' : 'before the adopt is committed';

      it(`a whole-file take prints a line for every fork entry (${shape}, ${when})`, () => {
        for (const { shell, printed } of runCheck(fork(olderKit()), KIT, { commit })) {
          for (const name of FORK_ENTRIES) {
            assert.ok(
              printed.some((line) => line.startsWith('-') && line.includes(`'${name}'`)),
              `${shell}: no printed line names the fork's '${name}':\n${printed.join('\n')}`,
            );
          }
        }
      });

      it(`a correct re-merge prints nothing (${shape}, ${when})`, () => {
        for (const { shell, printed } of runCheck(fork(olderKit()), fork(KIT), { commit })) {
          assert.deepEqual(printed, [], `${shell}: a merge that kept every entry`);
        }
      });
    }
  }

  it('a fork with no entries of its own prints nothing when it takes the kit file', () => {
    for (const { shell, printed } of runCheck(olderKit(), KIT, { commit: true })) {
      assert.deepEqual(printed, [], `${shell}: a pure-kit fork`);
    }
  });
});

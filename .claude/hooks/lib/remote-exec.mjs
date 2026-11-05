// Unpinned remote package execution: the parser behind guard-bash's vendor-docs rule. It lives in
// its own module because it is two parsers (a shell lexer and npm's argument parsing), not a
// regex; guard-bash.mjs imports findUnpinnedRemoteExec and turns a hit into its deny message.
// Mirrored into the plugin with the other portable hook files (verify:plugin keeps them equal).
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

// Vendor docs are data, not instructions (CLAUDE.md "Never do"; DECISIONS 2026-09-23 "Vendor docs
// are data, not instructions"). The shape they most often hand an agent is
// `npx --yes <pkg>@latest …`: download whatever the registry serves right now and execute it,
// outside package-lock.json and the 24h verify:deps gate. This rule blocks npm's remote-exec
// runners (`npx`; `npm exec` and every spelling npm accepts for it, `x` and `exe`; `npm
// init|create <initializer>`, which npm runs as `npm exec create-<initializer>`) when a package
// they would fetch is UNPINNED:
//   • a dist-tag or range (`@latest`, `@next`, `@^1`, `@1`, `@1.x`, `@*`, `@`), resolved at run time;
//   • a bare name (`foo`, `@scope/foo`) that is not installed where npm looks, so npm fetches
//     the registry's latest;
//   • an `npm:` alias without an exact version (npm never resolves an alias from the local tree);
//   • a git / URL / `user/repo` source (`user/repo.tgz` included), mutable and off-registry;
//   • any registry spec while a non-default `--registry` is in play (it can serve anything);
//   • a spec the guard cannot see: built from `$VAR` / `$( … )`, empty, or appended by xargs.
// ALLOWED: an exact version (`foo@1.2.3`, prerelease/build included, since a version published
// to the public registry never changes); a name npm resolves locally (`npx wrangler`, `npx tsc`
// after `npm ci`); a local path or tarball (`./x`, `file:../y`, `x.tgz`); and a run whose final
// `yes` is false (`--no`, npx's `--no-install`, `--yes=false`), which npm refuses to install for.
//
// `--yes` is deliberately NOT the trigger: npm assumes it whenever stdin is not a TTY (npm-exec
// docs; libnpmexec's noTTY check), and an agent's Bash tool never has one.
//
// HOW IT READS A COMMAND — two parsers, each mirroring the real one rather than guessing:
//   1. A small shell lexer (quotes, escapes, `\⏎` continuations, comments, operators,
//      redirections, heredocs) finds every place the shell EXECUTES code: each simple command,
//      `$( … )`, backticks, `<( … )`, `( … )`, the payload of `sh -c` / `eval` / `su -c` /
//      `watch` / `env -S` / `npx -c`, a heredoc or here-string a shell reads, and `echo …` or a
//      heredoc piped into a shell. A word that IS `npx` / `npm` is judged wherever it sits in an
//      executed command (after `timeout 60`, `sudo -u x`, `nice -n 10`, `if`, `find -exec` …)
//      except as an argument of a command that only prints or searches text (`echo`, `grep`,
//      `rg`, `git`, `gh` …). So `grep -rn "npx -y …"`, a commit message and a PR body pass. Where
//      one of those commands runs a shell command itself, that command is judged: `git rebase
//      --exec`, `git bisect run`, `git submodule foreach`, a `git -c` / `git config` value
//      (`alias.x=!…`, `core.pager`, `core.sshCommand` …), `gh alias set --shell`, awk's
//      `system()` and pipes, sed's `e`, a shell `alias`, and `GIT_SSH_COMMAND` / `GIT_EDITOR` /
//      `PAGER`-style variables. A heredoc read by anything but a shell is text, though its
//      `$( … )` still runs unless the delimiter is quoted (`<<'EOF'`), exactly as in the shell.
//   2. npm's own argument parsing: npx-cli.js's pre-pass, then nopt with npm 11's option table
//      (switches, string and value options, shorthands, unique-prefix abbreviations) and npm's
//      command abbreviations (`npm exe`, `npm cre`). Options after `npm exec <pkg>` are still
//      npm's (`npm exec foo --package=bar@latest`); after `npx <pkg>` they belong to the tool.
//      `yes` is last-wins (`--no --yes` installs). An option the table does not know (a newer
//      npm's) is read BOTH ways, as a switch and as taking the next word, and blocks if either
//      reading finds an unpinned spec. The table is npm 11's, the kit's floor (.npmrc needs
//      npm ≥ 11.10); regenerate it from @npmcli/config's definitions when npm adds options.
// Local resolution mirrors libnpmexec: the tree at npm's localPrefix (the nearest ancestor with
// package.json or node_modules; `--prefix` / `-C` override it), where a package counts only if
// its package.json `name` matches, plus, for a positional name, the project's own `bin` and
// node_modules/.bin walking up. It follows a chained `cd` / `pushd` / `popd`; a target built
// from `$VAR` / `$( … )` makes the directory unknown, and then no bare name counts as installed.
//
// SCOPE — like the rest of guard-bash, a convenience rail, not a sandbox. It does not see what a
// variable holds (`bash -c "$CMD"`, `$RUNNER -y x`), a script written to disk and run later (a
// command stored by this very command, `git config alias.x '!…'` or `gh alias set`, is judged
// when it is stored; one already in a config file is not seen), `curl … | sh`, a command sent to
// another machine as one string (`ssh host "npx …"`), or pnpm dlx / yarn dlx / bunx (not the
// kit's package manager); the CLAUDE.md rule covers those in prose. Known false positives, each
// with an easy way out: a range the local install satisfies (use the bare name), a globally
// installed tool (call it directly), a scoped package hoisted only to a workspace root, a
// relative tarball path containing `/` but no `./` (write `./dir/x.tgz`), an option npm 11 does
// not know, and an unpinned runner an awk program only prints while it also runs a command.

const HOME = homedir();
const MAX_DEPTH = 24;
// Words the guard may walk in total. Each runner re-reads the words after it, so a command
// stuffed with thousands of them would otherwise cost quadratic time, and a hook that times
// out lets the command run. Real commands use a tiny fraction of this.
const WORK_LIMIT = 200_000;
const wordList = (s) => s.trim().split(/\s+/);

// npm 11.19.1's config keys by how nopt reads them (@npmcli/config/lib/definitions). A switch
// takes no value (only a literal true/false, and the lookaheads below); a string option takes
// the next word unless it looks like an option; a value option always takes the next word.
const NPM_SWITCHES = new Set(
  wordList(
    'all allow-same-version allow-scripts-pending allow-scripts-pin audit bin-links browser ' +
      'bypass-2fa color commit-hooks dangerously-allow-all-scripts description dev ' +
      'diff-ignore-all-space diff-name-only diff-no-prefix diff-text dry-run engine-strict ' +
      'expect-results force foreground-scripts format-package-lock fund git-tag-version global ' +
      'global-style if-present ignore-scripts include-attestations include-staged ' +
      'include-workspace-root init-private install-links json legacy-bundling legacy-peer-deps ' +
      'link long offline omit-lockfile-registry-resolved optional package-lock package-lock-only ' +
      'packages-all parseable prefer-dedupe prefer-offline prefer-online production progress ' +
      'provenance read-only rebuild-bundle save save-bundle save-dev save-exact save-optional ' +
      'save-peer save-prod shrinkwrap sign-git-commit sign-git-tag strict-allow-scripts ' +
      'strict-peer-deps strict-ssl timing unicode update-notifier usage version versions ' +
      'workspaces workspaces-update yes',
  ),
);
const NPM_STRINGS = new Set(
  wordList(
    'call diff-dst-prefix diff-src-prefix editor git heading init-author-email init-author-name ' +
      'init-license init-type init.author.email init.author.name init.license message ' +
      'pack-destination preid save-prefix scope searchexclude searchopts shell tag ' +
      'tag-version-prefix user-agent viewer',
  ),
);
const NPM_VALUES = new Set(
  wordList(
    '_auth access allow-directory allow-file allow-git allow-remote allow-scripts also ' +
      'audit-level auth-type before ca cache cache-max cache-min cafile cert cidr cpu depth diff ' +
      'diff-unified expect-result-count expires fetch-retries fetch-retry-factor ' +
      'fetch-retry-maxtimeout fetch-retry-mintimeout fetch-timeout globalconfig https-proxy ' +
      'include init-author-url init-module init-version init.author.url init.module init.version ' +
      'install-strategy key libc local-address location lockfile-version loglevel logs-dir ' +
      'logs-max maxsockets min-release-age min-release-age-exclude name node-gyp node-options ' +
      'noproxy omit only orgs orgs-permission os otp package packages ' +
      'packages-and-scopes-permission password prefix provenance-file proxy registry ' +
      'replace-registry-host sbom-format sbom-type scopes script-shell searchlimit searchstaleness ' +
      'token-description umask userconfig which workspace',
  ),
);
const NPM_OPTIONS = [...NPM_SWITCHES, ...NPM_STRINGS, ...NPM_VALUES];
const NPM_OPTION_SET = new Set(NPM_OPTIONS);
// Switches whose type also admits a word: [null, Boolean(, String)] and ['always', Boolean].
const NULLABLE = (la) => la === 'null';
const SWITCH_LOOKAHEAD = {
  browser: (la) => la === 'null' || !/^-[^-]/.test(la),
  color: (la) => la === 'always',
  'expect-results': NULLABLE,
  optional: NULLABLE,
  production: NULLABLE,
  workspaces: NULLABLE,
  yes: NULLABLE,
};
const NPM_SHORTHANDS = {
  'enjoy-by': '--before',
  d: '--loglevel info',
  dd: '--loglevel verbose',
  ddd: '--loglevel silly',
  quiet: '--loglevel warn',
  q: '--loglevel warn',
  s: '--loglevel silent',
  silent: '--loglevel silent',
  verbose: '--loglevel verbose',
  desc: '--description',
  help: '--usage',
  local: '--no-global',
  n: '--no-yes',
  no: '--no-yes',
  porcelain: '--parseable',
  readonly: '--read-only',
  reg: '--registry',
  iwr: '--include-workspace-root',
  ws: '--workspaces',
  a: '--all',
  c: '--call',
  f: '--force',
  g: '--global',
  L: '--location',
  l: '--long',
  m: '--message',
  p: '--parseable',
  C: '--prefix',
  S: '--save',
  B: '--save-bundle',
  D: '--save-dev',
  E: '--save-exact',
  O: '--save-optional',
  P: '--save-prod',
  '?': '--usage',
  H: '--usage',
  h: '--usage',
  v: '--version',
  w: '--workspace',
  y: '--yes',
};
const SHORTHAND_KEYS = Object.keys(NPM_SHORTHANDS);
const shorthand = (k) => (Object.hasOwn(NPM_SHORTHANDS, k) ? wordList(NPM_SHORTHANDS[k]) : null);
// npx-cli.js's pre-pass, which finds the package argument before npm exec parses the rest.
const NPX_REMOVED = new Set([
  'always-spawn',
  'ignore-existing',
  'shell-auto-fallback',
  'npm',
  'node-arg',
  'n',
]);
const NPX_SWITCHES = new Set([
  ...NPM_SWITCHES,
  'always-spawn',
  'ignore-existing',
  'shell-auto-fallback',
  'no-install',
  'quiet',
  'q',
  'version',
  'v',
  'help',
  'h',
]);
const NPX_OPTS = new Set([
  'npm',
  'node-arg',
  'n',
  'package',
  'p',
  'cache',
  'userconfig',
  'call',
  'c',
  'shell',
]);
// Every `npm <word>` npm dereferences to exec or init (lib/utils/cmd-list.js, abbreviations too).
const NPM_EXEC_CMDS = new Set(['exe', 'exec', 'x']);
const NPM_INIT_CMDS = new Set([
  'cr',
  'cre',
  'crea',
  'creat',
  'create',
  'ini',
  'init',
  'inn',
  'inni',
  'innit',
]);

// nopt's abbreviation rule: an exact name, or a prefix no other name shares.
function abbrevOf(p, names) {
  if (names.includes(p)) return p;
  const hits = names.filter((n) => n.startsWith(p));
  return hits.length === 1 ? hits[0] : undefined;
}

// nopt's resolveShort: `-y` → --yes, `-yq` → --yes --loglevel warn, `--reg` → --registry.
function resolveShort(arg) {
  const a = arg.replace(/^-+/, '');
  if (NPM_OPTION_SET.has(a)) return null;
  const exact = shorthand(a);
  if (exact) return exact;
  if (a && [...a].every((ch) => Object.hasOwn(NPM_SHORTHANDS, ch))) {
    return [...a].flatMap(shorthand);
  }
  if (abbrevOf(a, NPM_OPTIONS)) return null;
  const s = abbrevOf(a, SHORTHAND_KEYS);
  return s ? shorthand(s) : null;
}

// npx-cli.js, line for line: expand shorthands, rewrite -p / --shell / --no-install, drop the
// removed flags, skip each option's value, and put `--` in front of the first positional.
function npxPrepass(argvIn) {
  const argv = [...argvIn];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') break;
    if (!/^-/.test(arg)) {
      argv.splice(i, 0, '--');
      break;
    }
    const [key, ...v] = arg.replace(/^-+/, '').split('=');
    if (key === 'p') argv[i] = ['--package', ...v].join('=');
    else if (key === 'shell') argv[i] = ['--script-shell', ...v].join('=');
    else if (key === 'no-install') argv[i] = '--yes=false';
    else if (shorthand(key) && !NPX_REMOVED.has(key)) {
      argv.splice(i, 1, ...shorthand(key), ...(v.length ? [v.join('=')] : []));
      i--;
      continue;
    }
    if (NPX_REMOVED.has(key)) {
      argv.splice(i, 1);
      i--;
    }
    if (
      v.length === 0 &&
      !NPX_SWITCHES.has(key) &&
      (NPX_OPTS.has(key) || !/^-/.test(String(argv[i + 1])))
    ) {
      if (NPX_REMOVED.has(key)) argv.splice(i + 1, 1);
      else i++;
    }
  }
  return argv;
}

function setOpt(opts, key, val) {
  if (key === 'package') opts.package.push(typeof val === 'string' ? val : '');
  else if (key === 'registry' || key.endsWith(':registry')) opts.registries.push([key, val]);
  else if (key === 'yes' || key === 'call' || key === 'prefix') opts[key] = val;
}

// nopt as npm runs it: options anywhere until `--`, the last value wins. `valueIfUnknown` reads
// an option the table does not know as taking the next word (as a newer npm might) instead of
// as a switch (what npm 11's nopt does with it).
function nopt(argvIn, valueIfUnknown) {
  const argv = [...argvIn];
  const opts = { package: [], registries: [], unknown: false };
  const remain = [];
  for (let i = 0; i < argv.length; i++) {
    let arg = argv[i];
    if (/^-{2,}$/.test(arg)) {
      remain.push(...argv.slice(i + 1));
      break;
    }
    if (!(arg[0] === '-' && arg.length > 1)) {
      remain.push(arg);
      continue;
    }
    const at = arg.indexOf('=');
    const hadEq = at > -1;
    if (hadEq) {
      argv.splice(i, 1, arg.slice(0, at), arg.slice(at + 1));
      arg = arg.slice(0, at);
    }
    const expanded = resolveShort(arg);
    if (expanded) {
      argv.splice(i, 1, ...expanded);
      if (arg !== expanded[0]) {
        i--;
        continue;
      }
    }
    let key = arg.replace(/^-+/, '');
    let no = null;
    while (key.toLowerCase().startsWith('no-')) {
      no = !no;
      key = key.slice(3);
    }
    key = abbrevOf(key, NPM_OPTIONS) ?? key;
    const unknown = !NPM_OPTION_SET.has(key) && !hadEq && no === null;
    if (unknown) opts.unknown = true;
    let la = argv[i + 1];
    if (no !== null || NPM_SWITCHES.has(key) || (unknown && !valueIfUnknown)) {
      let val = !no;
      if (la === 'true' || la === 'false') {
        val = la === 'true' ? !no : !!no;
        i++;
      } else if (
        la !== undefined &&
        Object.hasOwn(SWITCH_LOOKAHEAD, key) &&
        SWITCH_LOOKAHEAD[key](la)
      ) {
        val = la === 'null' ? null : la;
        i++;
      }
      setOpt(opts, key, val);
      continue;
    }
    if (NPM_STRINGS.has(key) || unknown) {
      if (la === undefined) la = '';
      else if (/^-{1,2}[^-]+/.test(la)) {
        la = '';
        i--;
      }
    }
    if (la && /^-{2,}$/.test(la)) {
      la = undefined;
      i--;
    }
    setOpt(opts, key, la === undefined ? true : la);
    i++;
  }
  return { opts, remain };
}

const noptReadings = (argv) => {
  const first = nopt(argv, false);
  return first.opts.unknown ? [first, nopt(argv, true)] : [first];
};

// ---- A small POSIX-shell lexer ---------------------------------------------------------------
// It returns a command list: [{ words, subs, heredocs, herestrings, pipeIn, pipeOut, bg }]. A
// word is its text after quote removal, with `$VAR` kept as written and a substitution standing
// in as `$(…)`, so a word containing `$` or a backtick is one the shell computes at run time.
// `subs` holds the nested command lists the shell runs to build this command: substitutions,
// subshells, process substitutions. Not a full parser (no aliases, functions or globbing): it
// only has to find every place code can run.

function lexScript(src, depth) {
  if (depth > MAX_DEPTH) throw new Error('the command nests too deeply for the guard to read');
  return lexList({ src, pos: 0, depth }, false);
}

function lexNested(lx) {
  lx.depth++;
  if (lx.depth > MAX_DEPTH) throw new Error('the command nests too deeply for the guard to read');
  const cmds = lexList(lx, true);
  lx.depth--;
  return cmds;
}

const newCommand = (pipeIn) => ({
  words: [],
  subs: [],
  heredocs: [],
  herestrings: [],
  pipeIn,
  pipeOut: false,
  bg: false,
});

function lexList(lx, inParens) {
  const { src } = lx;
  const cmds = [];
  let cmd = newCommand(false);
  let pending = []; // heredocs whose bodies start after the next newline
  const finish = (op) => {
    cmd.pipeOut = op === '|';
    cmd.bg = op === '&';
    if (cmd.words.length || cmd.subs.length || cmd.heredocs.length || cmd.herestrings.length) {
      cmds.push(cmd);
    }
    cmd = newCommand(op === '|');
  };
  while (lx.pos < src.length) {
    const c = src[lx.pos];
    const c2 = src[lx.pos + 1];
    if (c === ' ' || c === '\t' || c === '\r') lx.pos++;
    else if (c === '\\' && c2 === '\n') lx.pos += 2;
    else if (c === '\n') {
      lx.pos++;
      finish(';');
      readHeredocs(lx, pending);
      pending = [];
    } else if (c === '#') {
      const nl = src.indexOf('\n', lx.pos);
      lx.pos = nl === -1 ? src.length : nl;
    } else if (c === ';') {
      lx.pos += c2 === ';' || c2 === '&' ? 2 : 1;
      finish(';');
    } else if ((c === '&' || c === '|') && c2 === c) {
      lx.pos += 2;
      finish(';');
    } else if (c === '|') {
      lx.pos += c2 === '&' ? 2 : 1;
      finish('|');
    } else if (c === '&' && c2 === '>') {
      lx.pos++;
      readRedirect(lx, cmd, pending);
    } else if (c === '&') {
      lx.pos++;
      finish('&');
    } else if (c === ')') {
      lx.pos++;
      if (inParens) {
        finish(';');
        return cmds;
      }
    } else if (c === '(') {
      const end = arithmeticEnd(src, lx.pos);
      if (end > -1) {
        cmd.subs.push(...scanExpansions(src.slice(lx.pos + 2, end - 2), lx.depth + 1));
        lx.pos = end;
      } else {
        lx.pos++;
        cmd.subs.push(lexNested(lx));
      }
    } else if (c === '<' || c === '>') readRedirect(lx, cmd, pending);
    else {
      const before = lx.pos;
      const w = readWord(lx, cmd, pending);
      if (w) cmd.words.push(w);
      else if (lx.pos === before) lx.pos++; // never stall on a character no branch consumed
    }
  }
  finish(';');
  return cmds;
}

// `((…))` / `$((…))` is arithmetic when the inner `(` closes right before the outer one;
// otherwise it is a subshell inside a subshell or a substitution, as bash decides it too.
function arithmeticEnd(src, at) {
  if (src[at + 1] !== '(') return -1;
  let depth = 0;
  for (let k = at + 1; k < src.length; k++) {
    if (src[k] === '(') depth++;
    else if (src[k] === ')' && --depth === 0) return src[k + 1] === ')' ? k + 2 : -1;
  }
  return -1;
}

function readWord(lx, cmd, pending) {
  const { src } = lx;
  const start = lx.pos;
  // `2>&1`, `10<x`: an fd number glued to a redirection operator is not a word.
  const fd = /^\d+(?=[<>])/.exec(src.slice(lx.pos, lx.pos + 12));
  if (fd) {
    lx.pos += fd[0].length;
    readRedirect(lx, cmd, pending);
    return null;
  }
  let text = '';
  if (/^~(?=$|[/\s;&|()<>])/.test(src.slice(lx.pos, lx.pos + 2))) {
    text = HOME;
    lx.pos++;
  }
  while (lx.pos < src.length) {
    const c = src[lx.pos];
    if (c === '(' && text !== '') {
      text += c; // mid-word `(` is literal (extglob, `f()`); only a word-initial one opens a subshell
      lx.pos++;
    } else if (' \t\r\n;&|()<>'.includes(c)) break;
    else if (c === '\\') {
      if (src[lx.pos + 1] !== '\n') text += src[lx.pos + 1] ?? '';
      lx.pos += 2;
    } else if (c === "'") {
      const end = src.indexOf("'", lx.pos + 1);
      const stop = end === -1 ? src.length : end;
      text += src.slice(lx.pos + 1, stop);
      lx.pos = stop + 1;
    } else if (c === '"') {
      lx.pos++;
      text += readExpanding(lx, cmd, '"');
    } else if (c === '$' && src[lx.pos + 1] === "'") {
      lx.pos += 2;
      text += readAnsiC(lx);
    } else if (c === '$' && src[lx.pos + 1] === '"') lx.pos++;
    else if (c === '$' || c === '`') text += readExpansion(lx, cmd);
    else {
      text += c;
      lx.pos++;
    }
  }
  return lx.pos === start ? null : { text };
}

// The inside of "…" (or a heredoc body, when `close` is null): only \ $ and ` are special.
function readExpanding(lx, cmd, close) {
  const { src } = lx;
  let text = '';
  while (lx.pos < src.length && src[lx.pos] !== close) {
    const c = src[lx.pos];
    if (c === '\\') {
      const n = src[lx.pos + 1] ?? '';
      if (n !== '\n') text += '$`"\\'.includes(n) && n !== '' ? n : c + n;
      lx.pos += 2;
    } else if (c === '$' || c === '`') text += readExpansion(lx, cmd);
    else {
      text += c;
      lx.pos++;
    }
  }
  lx.pos++;
  return text;
}

// `$( … )`, `$(( … ))`, `${ … }`, `$name`, or a backtick substitution at lx.pos. What the shell
// runs to expand it goes onto cmd.subs; the returned text stands in for the value.
function readExpansion(lx, cmd) {
  const { src } = lx;
  if (src[lx.pos] === '`') {
    let raw = '';
    let k = lx.pos + 1;
    for (; k < src.length && src[k] !== '`'; k++) {
      if (src[k] === '\\' && '`$\\'.includes(src[k + 1] ?? '')) k++;
      raw += src[k] ?? '';
    }
    lx.pos = k + 1;
    cmd.subs.push(lexScript(raw, lx.depth + 1));
    return '$(…)';
  }
  const next = src[lx.pos + 1];
  if (next === '(') {
    const end = arithmeticEnd(src, lx.pos + 1);
    if (end > -1) {
      cmd.subs.push(...scanExpansions(src.slice(lx.pos + 3, end - 2), lx.depth + 1));
      lx.pos = end;
      return '$((…))';
    }
    lx.pos += 2;
    cmd.subs.push(lexNested(lx));
    return '$(…)';
  }
  if (next === '{') {
    lx.pos += 2;
    while (lx.pos < src.length && src[lx.pos] !== '}') {
      const c = src[lx.pos];
      if (c === '\\') lx.pos += 2;
      else if (c === '"') {
        lx.pos++;
        readExpanding(lx, cmd, '"');
      } else if (c === '$' || c === '`') readExpansion(lx, cmd);
      else lx.pos++;
    }
    lx.pos++;
    return '$VAR';
  }
  const name = /^(?:[A-Za-z_]\w*|[0-9@*#?$!-])/.exec(src.slice(lx.pos + 1, lx.pos + 256));
  lx.pos += 1 + (name ? name[0].length : 0);
  return `$${name ? name[0] : ''}`;
}

// $'…' (ANSI-C quoting): the escapes decoded, so `$'\x6epx'` reads as the npx it runs.
function readAnsiC(lx) {
  const { src } = lx;
  const simple = { n: '\n', t: '\t', r: '\r', a: '\x07', b: '\b', e: '\x1b', f: '\f', v: '\v' };
  let text = '';
  while (lx.pos < src.length && src[lx.pos] !== "'") {
    const m = /^\\(?:x([0-9A-Fa-f]{1,2})|u([0-9A-Fa-f]{1,4})|([0-7]{1,3})|([\s\S]))/.exec(
      src.slice(lx.pos, lx.pos + 6),
    );
    if (!m) text += src[lx.pos++];
    else {
      const [all, hex, uni, oct, ch] = m;
      const code = hex ?? uni;
      if (code) text += String.fromCharCode(Number.parseInt(code, 16));
      else if (oct) text += String.fromCharCode(Number.parseInt(oct, 8));
      else text += simple[ch] ?? ch;
      lx.pos += all.length;
    }
  }
  lx.pos++;
  return text;
}

function readRedirect(lx, cmd, pending) {
  const { src } = lx;
  const op = /^(?:<<<|<<-|<<|<>|<&|>&|>>|>\||<\(|>\(|<|>)/.exec(src.slice(lx.pos, lx.pos + 3))[0];
  lx.pos += op.length;
  if (op === '<(' || op === '>(') {
    cmd.subs.push(lexNested(lx));
    cmd.words.push({ text: '/dev/fd/63' }); // a process substitution is an argument (a path)
    return;
  }
  while (src[lx.pos] === ' ' || src[lx.pos] === '\t') lx.pos++;
  const start = lx.pos;
  const target = readWord(lx, cmd, pending);
  if (op === '<<' || op === '<<-') {
    const doc = {
      cmd,
      delim: target?.text ?? '',
      quoted: /['"\\]/.test(src.slice(start, lx.pos)),
      stripTabs: op === '<<-',
      body: '',
    };
    cmd.heredocs.push(doc);
    pending.push(doc);
  } else if (op === '<<<' && target) cmd.herestrings.push(target);
}

// Heredoc bodies start on the line after the command. An unquoted delimiter means the body is
// expanded, so its `$( … )` and backticks run whatever reads the body.
function readHeredocs(lx, pending) {
  const { src } = lx;
  for (const doc of pending) {
    const lines = [];
    while (lx.pos < src.length) {
      const nl = src.indexOf('\n', lx.pos);
      const end = nl === -1 ? src.length : nl;
      const line = src.slice(lx.pos, end);
      lx.pos = end + 1;
      if ((doc.stripTabs ? line.replace(/^\t+/, '') : line) === doc.delim) break;
      lines.push(line);
    }
    doc.body = lines.join('\n');
    if (!doc.quoted) doc.cmd.subs.push(...scanExpansions(doc.body, lx.depth + 1));
  }
}

// The command lists a piece of expanding text (a heredoc body, arithmetic) would run.
function scanExpansions(text, depth) {
  if (depth > MAX_DEPTH) throw new Error('the command nests too deeply for the guard to read');
  const holder = newCommand(false);
  readExpanding({ src: text, pos: 0, depth }, holder, null);
  return holder.subs;
}

// ---- Where the shell runs a word, and what npm would do with it -----------------------------
const RUNNERS = { npx: 'npx', 'npx-cli.js': 'npx', npm: 'npm', 'npm-cli.js': 'npm' };
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'ash', 'mksh']);
const KEYWORDS = new Set([
  'if',
  'then',
  'elif',
  'else',
  'fi',
  'while',
  'until',
  'do',
  'done',
  '!',
  '{',
  '}',
  'esac',
]);
// Commands that only print, search or record text: a runner NAMED in their arguments is text.
// Where one of them runs a shell command of its own (git's `rebase --exec`, awk's `system()` …),
// EMBEDDED below pulls that command out, and it is judged like any other.
const TEXT_COMMANDS = new Set(
  wordList(
    'echo printf grep egrep fgrep rg ag ack git gh jq yq sed gsed awk gawk mawk nawk man ' +
      'which whereis type hash test [ [[ : true false logger cat head tail less more wc tee ' +
      'touch mkdir ls for select case export declare typeset local readonly alias unalias ' +
      'printenv',
  ),
);
// Commands that run the rest of their arguments as a command. `values`: short options taking a
// value; `long`: long ones; `operands`: fixed arguments before the command (timeout's duration).
const TIMEOUT = { values: 'sk', long: ['signal', 'kill-after'], operands: 1 };
const WRAPPERS = {
  sudo: {
    values: 'CDghpRrTtUu',
    long: ['chdir', 'close-from', 'group', 'host', 'prompt', 'chroot', 'role', 'type', 'user'],
    assigns: true,
  },
  doas: { values: 'uC' },
  env: { values: 'uCSP', long: ['unset', 'chdir', 'split-string'], assigns: true },
  exec: { values: 'a' },
  command: {},
  builtin: {},
  nohup: {},
  setsid: {},
  chronic: {},
  unbuffer: {},
  time: { values: 'fo', long: ['format', 'output'] },
  nice: { values: 'n', long: ['adjustment'] },
  timeout: TIMEOUT,
  gtimeout: TIMEOUT,
  stdbuf: { values: 'ioe', long: ['input', 'output', 'error'] },
  caffeinate: { values: 'tw' },
  xargs: { values: 'adEILnPsJRS', long: ['arg-file', 'delimiter', 'eof', 'replace', 'max-args'] },
  watch: { values: 'n', long: ['interval'] },
};
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*\+?=/;
// Builtins whose assignments outlive the command.
const EXPORTS = new Set(['export', 'declare', 'typeset', 'readonly']);
// Variables whose value git, gh, a pager or an editor runs as a shell command. A leading `!` (a
// shell alias passed as GIT_CONFIG_VALUE_<n>) is dropped before the value is read.
const COMMAND_VAR =
  /^(?:GIT_(?:SSH_COMMAND|EDITOR|SEQUENCE_EDITOR|PAGER|EXTERNAL_DIFF|PROXY_COMMAND|CONFIG_VALUE_\d+)|GH_(?:EDITOR|PAGER|BROWSER)|EDITOR|VISUAL|PAGER|MANPAGER|BROWSER)=([\s\S]*)$/;
const base = (text) => text.slice(text.lastIndexOf('/') + 1).toLowerCase();
const joinText = (ws) => ws.map((w) => w.text).join(' ');

// Index of the first word after a wrapper's options and fixed operands.
function skipOptions(words, i, wrap, assigns) {
  let k = i;
  while (k < words.length) {
    const a = words[k].text;
    if (a === '--') return k + 1 + (wrap.operands ?? 0);
    if (wrap.assigns && ASSIGNMENT.test(a)) assigns?.push(a);
    else if (a.startsWith('--')) k += wrap.long?.includes(a.slice(2)) ? 1 : 0;
    else if (/^-./.test(a)) {
      const letters = a.slice(1);
      const v = [...letters].findIndex((ch) => wrap.values?.includes(ch));
      if (v > -1 && v === letters.length - 1) k++;
    } else if (a !== '-') break;
    k++;
  }
  return k + (wrap.operands ?? 0);
}

// The word the shell actually runs: past assignments, keywords and wrappers.
function commandHead(words) {
  const assigns = [];
  let at = 0;
  while (at < words.length) {
    const text = words[at].text;
    if (ASSIGNMENT.test(text)) {
      assigns.push(text);
      at++;
    } else if (KEYWORDS.has(text)) at++;
    else if (Object.hasOwn(WRAPPERS, base(text))) {
      at = skipOptions(words, at + 1, WRAPPERS[base(text)], assigns);
    } else break;
  }
  const name = at < words.length ? base(words[at].text) : '';
  return { at, assigns, name, textOnly: TEXT_COMMANDS.has(name) };
}

// A shell's options: whether -c (run the next operand) or -s (read stdin) is set, and where
// its first operand sits.
function shellArgs(words, j) {
  let c = false;
  let s = false;
  let k = j + 1;
  for (; k < words.length; k++) {
    const a = words[k].text;
    if (a === '--' || a === '-') {
      k++;
      break;
    }
    if (/^[-+][A-Za-z]+$/.test(a)) {
      if (a[0] === '-' && a.includes('c')) c = true;
      if (a[0] === '-' && a.includes('s')) s = true;
      if (/[oO]$/.test(a)) k++; // -o option / +O shopt name
    } else if (a.startsWith('--')) {
      if (a === '--rcfile' || a === '--init-file') k++;
    } else break;
  }
  return { c, s, operand: k < words.length ? k : -1 };
}

// Does this command run a shell that reads its script from stdin (`bash`, `sudo sh -s`)?
function readsScriptFromStdin(words) {
  const head = commandHead(words);
  if (head.at >= words.length || head.textOnly) return false;
  for (let j = head.at; j < words.length; j++) {
    if (!SHELLS.has(base(words[j].text))) continue;
    const s = shellArgs(words, j);
    if (!s.c && (s.s || s.operand === -1)) return true;
  }
  return false;
}

// npm reads npm_config_* from the environment (CLI flags win over it).
function npmEnv(env, text) {
  const m = /^npm_config_(\w+)=([\s\S]+)$/i.exec(text);
  if (!m) return;
  const key = m[1].replace(/(?!^)_/g, '-').toLowerCase();
  if (key === 'package') env.package.push(m[2]);
  else if (key === 'registry') env.registries.push([key, m[2]]);
  else if (key === 'yes') env.yes = m[2] === 'false' ? false : m[2] === 'null' ? null : true;
}

const newEnv = () => ({ package: [], registries: [], yes: undefined });
const cloneEnv = (e) => ({ package: [...e.package], registries: [...e.registries], yes: e.yes });
// A child shell: its own cwd and environment, the same work budget.
const fork = (ctx) => ({
  cwd: ctx.cwd,
  prev: ctx.prev,
  stack: [...ctx.stack],
  env: cloneEnv(ctx.env),
  work: ctx.work,
});

function scanText(text, ctx, depth) {
  return scanList(lexScript(text, depth + 1), fork(ctx), depth + 1);
}

function scanList(cmds, ctx, depth) {
  for (let n = 0; n < cmds.length; n++) {
    for (const sub of cmds[n].subs) {
      const hit = scanList(sub, fork(ctx), depth + 1);
      if (hit) return hit;
    }
    const hit = scanCommand(cmds[n], cmds[n + 1], ctx, depth);
    if (hit) return hit;
  }
  return null;
}

function scanCommand(cmd, next, ctx, depth) {
  const { words } = cmd;
  const head = commandHead(words);
  const env = cloneEnv(ctx.env);
  for (const a of head.assigns) npmEnv(env, a);
  // A bare assignment or an export also applies to the commands after it.
  const persists = head.at >= words.length || EXPORTS.has(head.name);
  if (persists) for (const w of words) npmEnv(ctx.env, w.text);
  // A variable whose value git, gh, a pager or an editor runs as a shell command.
  for (const a of persists ? words.map((w) => w.text) : head.assigns) {
    const m = COMMAND_VAR.exec(a);
    const hit = m && scanText(m[1].replace(/^!/, ''), ctx, depth);
    if (hit) return hit;
  }
  for (let j = 0; j < words.length && !(head.textOnly && j > head.at); j++) {
    const hit = scanWord(words, j, env, ctx, depth);
    if (hit) return hit;
  }
  // A heredoc / here-string is a script only when a shell reads it, and so is what a command
  // prints into `| sh`. Anything else reading it gets text.
  const feeds = [];
  const stdin = [...cmd.heredocs.map((d) => d.body), ...cmd.herestrings.map((w) => w.text)];
  if (readsScriptFromStdin(words)) feeds.push(...stdin);
  if (cmd.pipeOut && next && readsScriptFromStdin(next.words)) {
    feeds.push(...stdin);
    if (head.name === 'echo' || head.name === 'printf')
      feeds.push(joinText(words.slice(head.at + 1)));
  }
  for (const script of feeds) {
    const hit = scanText(script, ctx, depth);
    if (hit) return hit;
  }
  // cd / pushd / popd move the shell itself — not from inside a pipeline or a background job.
  if (!cmd.pipeIn && !cmd.pipeOut && !cmd.bg) followCd(head.name, words.slice(head.at + 1), ctx);
  return null;
}

// Charge the words about to be walked against the command's budget.
function charge(ctx, n) {
  ctx.work.left -= n;
  if (ctx.work.left < 0) throw new Error('the command is too long for the guard to read');
}

function scanWord(words, j, env, ctx, depth) {
  const name = base(words[j].text);
  if (
    Object.hasOwn(RUNNERS, name) ||
    /^(?:eval|watch|su|runuser|env)$/.test(name) ||
    SHELLS.has(name) ||
    Object.hasOwn(EMBEDDED, name)
  ) {
    charge(ctx, words.length);
  }
  if (Object.hasOwn(RUNNERS, name)) {
    const viaXargs = words.slice(0, j).some((w) => base(w.text) === 'xargs');
    return judgeRunner(RUNNERS[name], words.slice(j + 1), env, ctx, viaXargs, depth);
  }
  if (Object.hasOwn(EMBEDDED, name)) return scanPayloads(EMBEDDED[name](words, j, ctx), ctx, depth);
  if (SHELLS.has(name)) {
    const s = shellArgs(words, j);
    return s.c && s.operand > -1 ? scanText(words[s.operand].text, ctx, depth) : null;
  }
  if (name === 'eval') return scanText(joinText(words.slice(j + 1)), ctx, depth);
  if (name === 'watch') {
    return scanText(joinText(words.slice(skipOptions(words, j + 1, WRAPPERS.watch))), ctx, depth);
  }
  for (let k = j + 1; k < words.length; k++) {
    const a = words[k].text;
    let payload;
    if (name === 'su' || name === 'runuser') {
      if (a === '--command' || /^-[A-Za-z]*c$/.test(a)) payload = words[k + 1]?.text;
      else if (a.startsWith('--command=')) payload = a.slice(10);
    } else if (name === 'env') {
      if (!a.startsWith('-') && !ASSIGNMENT.test(a)) break;
      if (a === '-S' || a === '--split-string') payload = words[k + 1]?.text;
      else if (a.startsWith('--split-string=')) payload = a.slice(15);
      else if (a.startsWith('-S')) payload = a.slice(2);
    } else break;
    if (payload !== undefined) return scanText(payload, ctx, depth);
  }
  return null;
}

function followCd(name, args, ctx) {
  if (name !== 'cd' && name !== 'pushd' && name !== 'popd') return;
  const from = ctx.cwd;
  if (name === 'popd') {
    ctx.cwd = ctx.stack.length ? ctx.stack.pop() : null;
  } else {
    let k = 0;
    while (k < args.length && /^-[LPe@]+$/.test(args[k].text)) k++;
    if (args[k]?.text === '--') k++;
    const target = args[k]?.text;
    let to;
    if (target === undefined) to = name === 'cd' ? HOME : null;
    else if (target === '-' && name === 'cd') to = ctx.prev ?? null;
    else if (/[$`]/.test(target) || /^[+-]\d+$/.test(target)) to = null;
    else if (isAbsolute(target)) to = resolve(target);
    else to = from === null ? null : resolve(from, target);
    if (name === 'pushd') ctx.stack.push(from);
    ctx.cwd = to;
  }
  ctx.prev = from;
}

// ---- Commands that run a shell command of their own ------------------------------------------
// git, gh, awk and sed are TEXT_COMMANDS: their arguments are messages, patterns and programs.
// Each extractor returns the commands one of them would run itself, as { script } (text a shell
// parses) or { argv } (words run as a command line), with `cwd` where that command runs
// somewhere else (null: a directory the guard cannot know).
const EMBEDDED = {
  git: gitPayloads,
  gh: ghPayloads,
  alias: aliasPayloads,
  awk: awkPayloads,
  gawk: awkPayloads,
  mawk: awkPayloads,
  nawk: awkPayloads,
  sed: sedPayloads,
  gsed: sedPayloads,
};

function scanPayloads(payloads, ctx, depth) {
  for (const { script, argv, cwd } of payloads) {
    const at = cwd === undefined ? ctx : { ...ctx, cwd };
    const hit = argv ? scanArgv(argv, at, depth) : scanText(script, at, depth);
    if (hit) return hit;
  }
  return null;
}

// Words a command runs as a command line of their own (`git bisect run npx …`).
function scanArgv(words, ctx, depth) {
  if (depth + 1 > MAX_DEPTH) throw new Error('the command nests too deeply for the guard to read');
  return scanCommand({ ...newCommand(false), words }, undefined, fork(ctx), depth + 1);
}

// git options before the subcommand that take the next word as their value (git.c).
const GIT_GLOBAL_VALUES = new Set([
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--config-env',
  '--super-prefix',
  '--shallow-file',
  '--attr-source',
]);
// Long options whose value git runs as a shell command: rebase / push / archive --exec, difftool
// --extcmd, the transport's --upload-pack / --receive-pack, filter-branch's filters, send-email's
// --*-cmd. Read for any subcommand, and by unique prefix as parse-options reads them: a value that
// is not a command (`format-patch --to <address>`) reads as nothing.
const GIT_EXEC_LONG = wordList(
  'exec extcmd upload-pack receive-pack env-filter tree-filter index-filter parent-filter ' +
    'msg-filter commit-filter tag-name-filter setup to-cmd cc-cmd header-cmd sendmail-cmd',
);
// Per subcommand: the short option that takes a command, then the short options that take a
// value (the rest of a bundle is that value, so `-Xx` holds no -x).
const GIT_EXEC_SHORT = { rebase: ['x', 'sXCS'], difftool: ['x', 't'], clone: ['u', 'objc'] };

// A git config value: `!…` is a shell command, and an alias without `!` a git command line.
// Every other key is read as a command too (core.pager, core.sshCommand, core.editor,
// credential.helper, diff.<x>.command …); a value that is not one reads as nothing.
function gitConfigValue(key, value) {
  if (value.startsWith('!')) return { script: value.slice(1) };
  return { script: /^alias\./i.test(key) ? `git ${value}` : value };
}

function gitPayloads(words, j, ctx) {
  const out = [];
  const config = (pair) => {
    const eq = pair?.indexOf('=') ?? -1;
    if (eq > -1) out.push(gitConfigValue(pair.slice(0, eq), pair.slice(eq + 1)));
  };
  let cwd = ctx.cwd;
  let k = j + 1;
  for (; k < words.length; k++) {
    const a = words[k].text;
    if (a === '-C') cwd = prefixDir(words[++k]?.text ?? '', cwd);
    else if (a === '-c') config(words[++k]?.text);
    else if (GIT_GLOBAL_VALUES.has(a)) k++;
    else if (!a.startsWith('-')) break;
  }
  const sub = words[k]?.text;
  const args = words.slice(k + 1);
  if (sub === 'bisect') {
    if (args[0]?.text === 'run') out.push({ argv: args.slice(1) });
  } else if (sub === 'submodule') {
    let f = args.findIndex((w) => w.text === 'foreach') + 1;
    while (f > 0 && f < args.length && /^(?:--recursive|-q|--quiet|--)$/.test(args[f].text)) f++;
    // One word is a script for the shell, several a command line; each runs in a submodule.
    const cmd = f > 0 ? args.slice(f) : [];
    if (cmd.length === 1) out.push({ script: cmd[0].text, cwd: null });
    else if (cmd.length) out.push({ argv: cmd, cwd: null });
  } else if (sub === 'config') {
    // `git config [set] <key> <value>`: a value stored now runs whenever git reads it.
    let name = '';
    for (const w of args) {
      if (w.text.startsWith('-')) continue;
      out.push(gitConfigValue(name, w.text));
      name = w.text;
    }
  } else {
    const short = Object.hasOwn(GIT_EXEC_SHORT, sub) ? GIT_EXEC_SHORT[sub] : null;
    for (let i = 0; i < args.length; i++) {
      const a = args[i].text;
      if (a === '--') break;
      const long = /^--([^=]+)(=[\s\S]*)?$/.exec(a);
      if (long) {
        const [, name, eq] = long;
        const value = eq === undefined ? args[i + 1]?.text : eq.slice(1);
        if (value === undefined || name.length < 2) continue;
        if (sub === 'clone' && 'config'.startsWith(name)) config(value);
        else if (GIT_EXEC_LONG.some((o) => o.startsWith(name))) out.push({ script: value });
      } else if (short && /^-[^-]/.test(a)) {
        for (let c = 1; c < a.length; c++) {
          const value = a.length > c + 1 ? a.slice(c + 1) : args[i + 1]?.text;
          if (a[c] === short[0]) {
            if (value !== undefined) out.push({ script: value });
            break;
          }
          if (sub === 'clone' && a[c] === 'c') {
            config(value);
            break;
          }
          if (short[1].includes(a[c])) break;
        }
      }
    }
  }
  return out.map((p) => (p.cwd === undefined ? { ...p, cwd } : p));
}

// `gh alias set <name> <expansion>`: a shell alias (`--shell`, or an expansion that starts with
// `!`) runs through sh whenever it is called. Any other expansion is a gh command line.
function ghPayloads(words, j) {
  const pos = [];
  let shell = false;
  for (let k = j + 1; k < words.length; k++) {
    const a = words[k].text;
    if (a === '--') {
      pos.push(...words.slice(k + 1).map((w) => w.text));
      break;
    }
    if (/^--shell(?:=|$)/.test(a)) shell = a !== '--shell=false';
    else if (/^-[A-Za-z]+$/.test(a)) shell ||= a.includes('s');
    else if (!a.startsWith('-') || a === '-') pos.push(a);
  }
  const expansion = pos[3];
  if (pos[0] !== 'alias' || pos[1] !== 'set' || expansion === undefined) return [];
  if (expansion.startsWith('!')) return [{ script: expansion.slice(1) }];
  return shell ? [{ script: expansion }] : [];
}

// A shell alias runs its value wherever its name is used later.
function aliasPayloads(words, j) {
  return words
    .slice(j + 1)
    .map((w) => /^[^-=][^=]*=([\s\S]*)$/.exec(w.text))
    .filter(Boolean)
    .map((m) => ({ script: m[1] }));
}

// awk runs a string as a shell command in system(), in a pipe to or from one (`print | "cmd"`,
// `"cmd" | getline`) and in gawk's coprocesses (`|&`). When a program can do that, each of its
// string literals and each `-v` / operand assignment's value is read as a command; a string that
// is only printed reads as nothing unless it names an unpinned runner.
function awkPayloads(words, j) {
  const args = words.slice(j + 1).map((w) => w.text);
  if (!args.some((a) => /\bsystem\s*\(|(?<!\|)\|(?!\|)/.test(a))) return [];
  const out = [];
  for (const a of args) {
    const assign = /^(?:-v)?[A-Za-z_]\w*=([\s\S]*)$/.exec(a);
    if (assign) out.push({ script: assign[1] });
    for (const s of awkStrings(a)) out.push({ script: s });
  }
  return out;
}

const AWK_ESCAPES = { n: '\n', t: '\t', r: '\r' };
function awkStrings(text) {
  const out = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '"') continue;
    let s = '';
    for (i++; i < text.length && text[i] !== '"'; i++) {
      if (text[i] === '\\' && i + 1 < text.length) {
        i++;
        s += AWK_ESCAPES[text[i]] ?? text[i];
      } else s += text[i];
    }
    out.push(s);
  }
  return out;
}

// GNU sed runs a command with `e <command>`, and with the `e` flag of `s`, which runs the pattern
// space after the substitution (so its replacement is read as the command). The script is every
// -e / --expression, or else the first operand; a -f script file is not seen.
function sedPayloads(words, j) {
  const args = words.slice(j + 1).map((w) => w.text);
  const scripts = [];
  let fromOptions = false;
  let operand;
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    const long = /^--([^=]+)(?:=([\s\S]*))?$/.exec(a);
    if (a === '--') {
      operand ??= args[k + 1];
      break;
    } else if (long) {
      // getopt_long takes a unique prefix: --e is --expression, --fi --file, --l --line-length.
      const [, name, value] = long;
      const expression = 'expression'.startsWith(name);
      const file = name.length > 1 && 'file'.startsWith(name);
      if (expression || file || 'line-length'.startsWith(name)) {
        const v = value ?? args[++k];
        if (expression) scripts.push(v ?? '');
        fromOptions ||= expression || file;
      }
    } else if (/^-./.test(a)) {
      for (let c = 1; c < a.length; c++) {
        if ('efl'.includes(a[c])) {
          const value = a.length > c + 1 ? a.slice(c + 1) : args[++k];
          if (a[c] === 'e') scripts.push(value ?? '');
          fromOptions ||= a[c] !== 'l';
          break;
        }
        if (a[c] === 'i') break; // -i[SUFFIX]: the rest of the word is the suffix
      }
    } else operand ??= a;
  }
  if (!fromOptions && operand !== undefined) scripts.push(operand);
  return sedExecs(scripts.join('\n')).map((script) => ({ script }));
}

// The commands a sed script runs: a small reading of GNU sed's grammar (addresses, `!`, blocks,
// text and file-name arguments that run to the end of the line, `s` / `y` with any delimiter).
function sedExecs(src) {
  const out = [];
  const n = src.length;
  let i = 0;
  const at = (re) => i < n && re.test(src[i]);
  // To the end of the line; a backslash-newline continues it.
  const toEol = () => {
    let s = '';
    for (; i < n && src[i] !== '\n'; i++) {
      if (src[i] === '\\' && i + 1 < n) i++;
      s += src[i];
    }
    return s;
  };
  // One delimited part of an address or an s / y command.
  const part = (d) => {
    let s = '';
    for (; i < n && src[i] !== d && src[i] !== '\n'; i++) {
      if (src[i] === '\\' && i + 1 < n) {
        i++;
        s += src[i] === 'n' && d !== 'n' ? '\n' : src[i];
      } else s += src[i];
    }
    i++;
    return s;
  };
  const address = () => {
    if (src[i] === '/') {
      i++;
      part('/');
    } else if (src[i] === '\\' && i + 1 < n) {
      i += 2;
      part(src[i - 1]);
    } else if (at(/[0-9$]/)) {
      while (at(/[0-9$~]/)) i++;
    } else return false;
    while (at(/[IM]/)) i++;
    return true;
  };
  while (i < n) {
    while (at(/[\s;{}!]/)) i++;
    if (src[i] === '#') {
      toEol();
      continue;
    }
    if (address()) {
      while (at(/[ \t]/)) i++;
      if (src[i] === ',') {
        i++;
        while (at(/[ \t]/)) i++;
        if (at(/[+~]/)) {
          i++;
          while (at(/[0-9]/)) i++;
        } else address();
      }
    }
    while (at(/[ \t!]/)) i++;
    const cmd = src[i++];
    if (cmd === undefined) break;
    if (cmd === 'e') {
      const command = toEol().trim();
      if (command) out.push(command);
    } else if ('aicrRwW'.includes(cmd)) toEol();
    else if (':btTv'.includes(cmd)) {
      while (i < n && !';\n'.includes(src[i])) i++;
    } else if (cmd === 's' || cmd === 'y') {
      const d = src[i++];
      if (d === undefined || d === '\n' || d === '\\') continue;
      part(d);
      const replacement = part(d);
      let flags = '';
      while (cmd === 's' && at(/[0-9gpeiImMw]/)) {
        if (src[i] === 'w') {
          toEol(); // `w <file>` ends the command
          break;
        }
        flags += src[i++];
      }
      if (flags.includes('e')) out.push(replacement);
    }
  }
  return out;
}

// An npx / npm invocation, read the way npm reads it.
function judgeRunner(runner, argWords, env, ctx, viaXargs, depth) {
  const argv = argWords.map((w) => w.text);
  for (const { opts, remain } of noptReadings(runner === 'npx' ? npxPrepass(argv) : argv)) {
    let positionals = remain;
    let init = false;
    if (runner === 'npm') {
      if (positionals[0] === undefined) {
        if (viaXargs)
          return { spec: null, why: 'xargs supplies the npm command, which the guard cannot see' };
        continue;
      }
      init = NPM_INIT_CMDS.has(positionals[0]);
      if (!init && !NPM_EXEC_CMDS.has(positionals[0])) continue;
      positionals = positionals.slice(1);
    }
    const hit = judgeExec(opts, positionals, init, env, ctx, viaXargs, depth);
    if (hit) return hit;
  }
  return null;
}

function judgeExec(opts, positionals, init, env, ctx, viaXargs, depth) {
  // `--call` runs its payload in a shell, packages or not.
  if (!init && typeof opts.call === 'string' && opts.call) {
    const hit = scanText(opts.call, ctx, depth);
    if (hit) return hit;
  }
  // With `yes` false npm refuses to install anything (CLI beats npm_config_yes).
  if ((opts.yes !== undefined ? opts.yes : env.yes) === false) return null;
  const packages = [...opts.package, ...env.package];
  const specs = packages.map((spec) => [spec, null]);
  const unseen = { spec: null, why: 'xargs appends the package spec, which the guard cannot see' };
  if (init) {
    if (positionals.length) specs.push([initializerSpec(positionals[0]), null]);
    else if (viaXargs) return unseen;
  } else if (!packages.length && !opts.call) {
    // With no --package, the first positional IS the package (tried as a local bin first).
    if (positionals.length) specs.push([positionals[0], positionals[0]]);
    else if (viaXargs) return unseen;
  }
  const dir = prefixDir(opts.prefix, ctx.cwd);
  const custom = customRegistry([...env.registries, ...opts.registries]);
  for (const [spec, bin] of specs) {
    const why = unpinnedReason(spec, dir, bin, custom);
    if (why) return spec === '' ? { spec: null, why } : { spec, why };
  }
  return null;
}

function prefixDir(prefix, cwd) {
  if (typeof prefix !== 'string' || prefix === '') return cwd;
  if (/[$`]/.test(prefix)) return null;
  const p = prefix.replace(/^~(?=\/|$)/, HOME);
  if (isAbsolute(p)) return resolve(p);
  return cwd === null ? null : resolve(cwd, p);
}

// A registry other than the public one can serve anything under any version.
function customRegistry(entries) {
  return (name) =>
    entries.some(([key, url]) => {
      const scope = key === 'registry' ? null : key.slice(0, key.indexOf(':'));
      if (scope && !name.startsWith(`${scope}/`)) return false;
      return typeof url !== 'string' || !/^https:\/\/registry\.npmjs\.org\/?$/i.test(url);
    });
}

// npm maps `init <initializer>` to `exec create-<initializer>` (lib/commands/init.js).
function initializerSpec(init) {
  if (/^@[^/]+$/.test(init)) {
    const [, scope, version] = init.split('@');
    return `@${scope}/create${version ? `@${version}` : ''}`;
  }
  const m = init.match(/^((?:@[^/@\s]+\/)?)([^/@\s]+)(@.*)?$/);
  return m ? `${m[1]}create-${m[2]}${m[3] ?? ''}` : init;
}

// semver's loose `valid()` (what npm-package-arg calls a "version"), in its unambiguous subset:
// each number at most 15 digits (a larger one is not a safe integer, so npm reads it as a
// mutable dist-tag) and non-empty dotted identifiers (`1.2.3-a..b` is a tag too).
const IDENT = '[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*';
const EXACT_VERSION = new RegExp(
  `^[=v]?\\d{1,15}\\.\\d{1,15}\\.\\d{1,15}(?:-${IDENT})?(?:\\+${IDENT})?$`,
);
const isExactVersion = (v) => v.length <= 256 && EXACT_VERSION.test(v.trim());
const REGISTRY_SPEC = /^((?:@[^/@\s]+\/)?[^/@\s]+)(?:@([\s\S]*))?$/;

const statOf = (p) => {
  try {
    return statSync(p);
  } catch {
    return null;
  }
};
// A package.json is a few KB; anything larger is not one worth parsing to answer "installed?".
const MAX_MANIFEST_BYTES = 1024 * 1024;
function readJson(p) {
  const st = statOf(p);
  if (!st?.isFile() || st.size > MAX_MANIFEST_BYTES) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

// Names come from the command text, so they are checked before they touch the filesystem: npm's
// own package-name rules (validate-npm-package-name: no leading `.`/`_`, URL-safe, ≤ 214) make a
// name npm would refuse never "installed", and no bin carries a path separator. `inside` is the
// backstop — a looked-up path must stay under the directory it was joined onto.
const PACKAGE_NAME = /^(?:@[a-z0-9~-][a-z0-9._~-]*\/)?[a-z0-9~-][a-z0-9._~-]*$/i;
const isPackageName = (name) => name.length <= 214 && PACKAGE_NAME.test(name);
const BIN_NAME = /^[a-z0-9@~_-][a-z0-9@._~-]*$/i;
const isBinName = (bin) => bin.length <= 214 && BIN_NAME.test(bin);
function inside(base, p) {
  const rel = relative(base, p);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

// Is `name` installed where npm would look? `bin` is the positional word, which libnpmexec
// also tries as the project's own bin and as node_modules/.bin/<bin>, walking up. A --package
// spec gets only the tree check (`npx -p tsc` fetches the unrelated `tsc` package).
function isInstalledLocally(name, dir, bin) {
  if (dir === null) return false;
  let prefix = dir;
  for (let d = dir; ; d = dirname(d)) {
    if (statOf(join(d, 'package.json')) || statOf(join(d, 'node_modules'))?.isDirectory()) {
      prefix = d;
      break;
    }
    if (dirname(d) === d) break;
  }
  // Validate before any path is built from the name: nothing from the command is joined unchecked.
  if (isPackageName(name)) {
    const modules = join(prefix, 'node_modules');
    const manifest = join(modules, name, 'package.json');
    if (inside(modules, manifest) && readJson(manifest)?.name === name) return true;
  }
  if (!bin || !isBinName(bin)) return false;
  const own = readJson(join(prefix, 'package.json'));
  const ownBins =
    typeof own?.bin === 'string'
      ? [String(own.name ?? '').replace(/^@[^/]+\//, '')]
      : Object.keys(own?.bin ?? {});
  if (ownBins.includes(bin)) return true;
  for (let d = prefix; ; d = dirname(d)) {
    const bins = join(d, 'node_modules', '.bin');
    const exe = join(bins, bin);
    if (inside(bins, exe) && statOf(exe)?.isFile()) return true;
    if (dirname(d) === d) return false;
  }
}

// Why `spec` is unpinned, or null when it is pinned or local. Ordered like npm-package-arg.
function unpinnedReason(spec, dir, bin, custom) {
  if (spec === '')
    return 'an empty package spec: npm would fetch a registry package named "undefined"';
  if (/[$`]/.test(spec))
    return 'it comes from a shell variable or substitution, so its version cannot be checked';
  if (/^(?:\.|~\/|\/|file:)/i.test(spec)) return null; // a local path
  if (/^npm:/i.test(spec)) return aliasReason(spec.slice(4), custom);
  if (/^(?:git\+)?[a-z]+:/i.test(spec) || /^[^@]+@[^:.]+\.[^:]+:.+$/.test(spec)) {
    return 'a git/URL source is mutable and off-registry';
  }
  const at = spec.indexOf('@', 1);
  const namePart = at > 0 ? spec.slice(0, at) : spec;
  if (!namePart.startsWith('@') && namePart.includes('/')) {
    return 'a `user/repo` source is git-hosted, mutable and off-registry (write ./path for a local one)';
  }
  // A tarball file name is local, but `@scope/x.tgz` with no version is a registry package name.
  const tarball = /\.(?:tgz|tar\.gz|tar)$/i;
  if (namePart.startsWith('@') ? at > 0 && tarball.test(spec.slice(at + 1)) : tarball.test(spec)) {
    return null;
  }
  const m = spec.match(REGISTRY_SPEC);
  if (!m) return 'not a package spec this guard can verify';
  const [, name, version] = m;
  if (version !== undefined && /^npm:/i.test(version)) return aliasReason(version.slice(4), custom);
  if (custom(name)) return 'a non-default registry can serve anything under any version';
  if (version === undefined) {
    return isInstalledLocally(name, dir, bin)
      ? null
      : 'no version, and not installed in this project, so npm would fetch the latest';
  }
  if (isExactVersion(version)) return null;
  if (version === 'latest') return '@latest resolves to whatever was published last';
  return `@${version || '*'} is a dist-tag or range, not an exact version`;
}

// npm never serves an alias from the local tree, so only an exact version pins one.
function aliasReason(target, custom) {
  if (/^npm:/i.test(target)) return 'a nested npm: alias, which npm rejects';
  const m = target.match(REGISTRY_SPEC);
  if (!m) return 'an npm: alias whose target this guard cannot verify';
  if (custom(m[1])) return 'a non-default registry can serve anything under any version';
  return m[2] !== undefined && isExactVersion(m[2])
    ? null
    : 'an npm: alias is always fetched from the registry, so it needs an exact version';
}

// The first unpinned remote exec `cmd` would run from `cwd`, as { spec, why } (spec null when
// the guard cannot see it), or null. Throws when the command nests too deeply or is too long to
// read; guard-bash denies it then.
export function findUnpinnedRemoteExec(cmd, cwd) {
  const ctx = { cwd, prev: undefined, stack: [], env: newEnv(), work: { left: WORK_LIMIT } };
  return scanList(lexScript(cmd, 0), ctx, 0);
}

// "Is this module the process entry point?" — the guard every CLI script in scripts/ uses to
// separate `node scripts/foo.mjs` from `import`ing it in a test.
//
// The obvious form FAILS OPEN:
//
//   import.meta.url === pathToFileURL(process.argv[1]).href   // ← do not use
//
// Node resolves symlinks when it sets `import.meta.url` for the entry point; `pathToFileURL`
// does not. So invoking a script by an absolute path with a symlinked ancestor makes the two
// disagree, the CLI body never runs, and the process exits 0 having done nothing. For a
// verification gate that is the worst possible failure: it reports success without checking.
// Confirmed against the real repo before this fix — `node "$PWD/scripts/check-agent-guidance-
// sync.mjs"` printed its verdict, while the same file reached through a symlink to the repo
// produced zero bytes and exit 0.
//
// It is not exotic input: macOS `/tmp` is a symlink to `/private/tmp`, `os.tmpdir()` on this
// machine resolves to a different path than it reports, and symlinked CI workspaces are common.
// `package.json` and ci.yml happen to invoke these scripts by RELATIVE path, which is immune
// (`path.resolve` builds on an already-realpathed `cwd`), so no gate was silently passing in
// CI — but nothing enforced that, and any tooling that spawns a gate by absolute path got a
// green light for free.
//
// Comparing realpaths on both sides is symmetric and does not care which side Node normalized.
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * True when `metaUrl` (a module's `import.meta.url`) is the script node was started with.
 *
 * Answers false only for the two cases that legitimately mean "not the entry point": there is
 * no `argv[1]` at all (`--eval`, REPL, stdin), or a path does not exist. Everything else is
 * LOUD.
 *
 * - A bad argument throws. `isMainModule()` — the easy typo, since the parameter is a URL and
 *   not the `__filename`-shaped string the name suggests — must not quietly answer false: that
 *   would disable a gate exactly the way the bug this helper exists to fix did.
 * - A realpath failure that is not ENOENT (EACCES after a permissions change, ELOOP from a
 *   symlink cycle, ENAMETOOLONG on a deep workspace) propagates. "Fails closed" has to mean
 *   loud, not silent: a gate that exits 0 because it could not tell whether to run is the same
 *   symptom as the symlink bug, with a different trigger.
 */
export function isMainModule(metaUrl) {
  if (typeof metaUrl !== 'string' || !metaUrl.startsWith('file:')) {
    throw new TypeError(`isMainModule(import.meta.url) expects a file: URL, got ${metaUrl}`);
  }
  const entry = process.argv[1];
  if (!entry) return false;
  const resolve = (p) => {
    try {
      return realpathSync(p);
    } catch (err) {
      if (err?.code === 'ENOENT') return null;
      throw err;
    }
  };
  const self = resolve(fileURLToPath(metaUrl));
  const main = resolve(entry);
  return self !== null && self === main;
}

// Test-only helper: a throwaway git repo on `branch` with one commit so HEAD resolves
// (`git rev-parse/symbolic-ref` error on an unborn branch). Shared by guard-bash.test.mjs and
// git-native.test.mjs so the git-init recipe lives in ONE place — a future change (e.g. a new
// `-c` flag a sandboxed CI needs) can't rot one copy while the other passes. Identity + no-gpg
// are passed inline so it works with no global git config. Caller removes the dir.
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// git in `dir` with the same inline flags, for a test that stages or commits in the repo.
export function repoGit(dir) {
  return (...args) =>
    execFileSync(
      'git',
      [
        '-C',
        dir,
        '-c',
        'user.email=t@t',
        '-c',
        'user.name=t',
        '-c',
        'commit.gpgsign=false',
        ...args,
      ],
      { stdio: 'ignore' },
    );
}

export function initRepo(branch, prefix = 'paved-hook-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const git = repoGit(dir);
  git('init', '-b', branch);
  git('commit', '--allow-empty', '-m', 'init');
  return dir;
}

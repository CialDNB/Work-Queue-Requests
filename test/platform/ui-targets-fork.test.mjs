// Pins CHANGELOG "UI intents — Forks" step 2: a fork that lists no UI-intent targets yet still
// typechecks, the carried tests included.
//
// src/ai/uiTargets.ts is app-owned, so how a fork DECLARES its registries is the fork's choice.
// The carried tests (test/isolation/ui-intent-targets.test.ts, test/ai/ui-intents.test.ts) are
// not: a fork takes them whole — except that ui-intents.test.ts also drives the kit's AI client
// (assertCustomTools, callAnthropic), so a fork that runs its own client skips that one file
// (CHANGELOG, UI intents step 3; the /kit-upgrade skill's "Yours" list). TypeScript types the element of `[] as const` (and of a bare `[]`)
// as `never`, so a carried test that reads `form.id` off an entry without first widening the
// registry to `readonly AgentForm[]` does not compile against an empty one. Fork CI then fails a
// hard gate, and the only way out is to edit a tripwire.
//
// This MUST run tsc on a copy. The kit's own registries are not empty, and the failure is a
// compile error, not a test failure. Run by `node --test` (test:scripts), like its siblings.
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TSC = join(REPO, 'node_modules', 'typescript', 'bin', 'tsc');

// The ways a fork may write "none yet", as each registry's declaration. The first is the shape
// the kit's entries once had, with the entries deleted; the last is CHANGELOG step 2's wording.
const EMPTY = {
  'as const satisfies': (name, type) =>
    `export const ${name} = [] as const satisfies readonly ${type}[];`,
  'typed binding': (name, type) => `export const ${name}: readonly ${type}[] = [];`,
  'bare []': (name) => `export const ${name} = [];`,
};

const registries = (form) =>
  [
    "import type { AgentForm, AgentView } from './uiTargetsTypes';",
    "export type { AgentForm, AgentView } from './uiTargetsTypes';",
    EMPTY[form]('AGENT_VIEWS', 'AgentView'),
    EMPTY[form]('AGENT_FORMS', 'AgentForm'),
    '',
  ].join('\n');

describe('a fork with no UI-intent targets yet still typechecks (CHANGELOG step 2)', () => {
  let dir;
  const targets = () => join(dir, 'src', 'ai', 'uiTargets.ts');
  const tsc = () =>
    spawnSync(process.execPath, [TSC, '-p', join(dir, 'test', 'tsconfig.json'), '--noEmit'], {
      encoding: 'utf8',
    });

  before(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'ui-targets-fork-')));
    // test/tsconfig.json covers test/ and src/; the tests also import web/src.
    cpSync(join(REPO, 'tsconfig.json'), join(dir, 'tsconfig.json'));
    for (const sub of ['src', 'test', join('web', 'src')]) {
      cpSync(join(REPO, sub), join(dir, sub), { recursive: true });
    }
    symlinkSync(join(REPO, 'node_modules'), join(dir, 'node_modules'), 'dir');
    // Keep the app's interfaces (whatever else the file holds) and swap only the registries.
    renameSync(targets(), join(dir, 'src', 'ai', 'uiTargetsTypes.ts'));
  });

  after(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  for (const form of Object.keys(EMPTY)) {
    it(`registries emptied as \`${form}\``, () => {
      writeFileSync(targets(), registries(form));
      const res = tsc();
      assert.equal(res.status, 0, `tsc failed:\n${res.stdout}${res.stderr}`);
    });
  }

  it('control: the copy is really typechecked (a type error in a carried test fails)', () => {
    writeFileSync(targets(), registries('typed binding'));
    const probe = join(dir, 'test', 'isolation', 'zz-probe.ts');
    writeFileSync(probe, "export const probe: number = 'not a number';\n");
    try {
      const res = tsc();
      assert.notEqual(res.status, 0);
      assert.match(`${res.stdout}${res.stderr}`, /zz-probe\.ts/);
    } finally {
      rmSync(probe, { force: true });
    }
  });
});

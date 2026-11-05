// Pins the DEPLOY_ENABLED gate: the staging deploy (ci.yml) and the production deploy
// (deploy-prod.yml) must read the repo variable with ONE evaluator. They used to differ — ci.yml
// used the expression `vars.DEPLOY_ENABLED == 'true'` (GitHub ignores case in `==`), while
// deploy-prod.yml passed the raw value to bash and compared it with `!=` (case-sensitive). A var
// set to "TRUE" passed staging and blocked production, with an error that said it was not set.
// Run by `node --test` (test:scripts), like its siblings.
import { strict as assert } from 'node:assert';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const WORKFLOWS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '.github', 'workflows');
const read = (file) => readFileSync(join(WORKFLOWS, file), 'utf8');

describe('DEPLOY_ENABLED is read with one evaluator', () => {
  it("every workflow reference is the expression comparison `== 'true'`", () => {
    // A raw `${{ vars.DEPLOY_ENABLED }}` handed to a shell is how the two gates diverged.
    const offenders = [];
    for (const file of readdirSync(WORKFLOWS).filter((f) => /\.ya?ml$/.test(f))) {
      for (const line of read(file).split('\n')) {
        if (/vars\.DEPLOY_ENABLED\b(?!\s*==\s*'true')/.test(line))
          offenders.push(`${file}: ${line.trim()}`);
      }
    }
    assert.deepEqual(offenders, []);
  });

  it('production guards on the evaluated result, not the raw value', () => {
    const prod = read('deploy-prod.yml');
    assert.match(prod, /DEPLOY_ENABLED_IS_TRUE: \$\{\{ vars\.DEPLOY_ENABLED == 'true' \}\}/);
    assert.match(prod, /\[ "\$DEPLOY_ENABLED_IS_TRUE" != "true" \]/);
  });

  it('staging gates on the same comparison', () => {
    assert.match(read('ci.yml'), /&& vars\.DEPLOY_ENABLED == 'true'/);
  });
});

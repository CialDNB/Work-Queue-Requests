// The template ships no DB Israel marker, caller or other sign of a DB Israel app.
//
// A new app starts as a copy of this tree, through "Use this template" or the plugin's rsync, and
// the bootstrap keeps a deployment marker that is already there. So a marker committed to the kit
// would make every new app a DB Israel app with no one choosing it, and a caller committed to the
// kit would run red on every kit push and reach every CIAL fork through /kit-upgrade. Any other
// sign (a dbisrael.ai value in a wrangler config, docs/CENTRAL-DELIVERY.md) would make the reader
// fail closed in every new app. A DB Israel app gets its marker and caller from the bootstrap.
//
// Kit only: a renamed app may be a DB Israel app, so it skips itself there. Nothing here names the
// template as a literal; a renamed app keeps this file, and its residual scan would flag one. Run
// by `node --test` (test:scripts).
import { strict as assert } from 'node:assert';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  CALLER_PATH,
  israelSignals,
  readMarker,
  resolveDeploymentTarget,
} from '../../scripts/deployment-target.mjs';
import { isTemplateRepo, TEMPLATE_KEBAB } from '../../scripts/new-app.mjs';

const ROOT = join(import.meta.dirname, '..', '..');

describe('the template is a CIAL tree with no DB Israel marker or caller', {
  skip: !isTemplateRepo(ROOT) && 'kit only: this repo is already renamed',
}, () => {
  it('has no deployment marker', () => {
    assert.deepEqual(readMarker(ROOT), { state: 'missing' });
  });

  it('shows no sign of a DB Israel app', () => {
    assert.deepEqual(israelSignals(ROOT), []);
  });

  it('has no central release workflow under .github/workflows', () => {
    const caller = CALLER_PATH.split('/').at(-1);
    assert.ok(caller.startsWith(`il-${TEMPLATE_KEBAB}`), 'the prefix this case looks for');
    const found = readdirSync(join(ROOT, '.github', 'workflows')).filter((name) =>
      name.startsWith(`il-${TEMPLATE_KEBAB}`),
    );
    assert.deepEqual(found, []);
  });

  it('resolves to CIAL', () => {
    assert.deepEqual(resolveDeploymentTarget({ root: ROOT, env: {} }), { target: 'cial' });
  });
});

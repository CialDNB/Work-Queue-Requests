// Pins src/platform/runtimeConfig.mjs, the vocabulary of every variable and secret the Worker's
// Env reads: what kind each is, the feature it belongs to, which variables turn that feature on,
// how a CIAL app sets it, and what a DB Israel app's registration proposal does with it
// (scripts/central-proposal.mjs reads it).
//
// In the kit the vocabulary must match src/env.ts in both directions: a field Env declares is in
// the vocabulary, a name the vocabulary lists is in Env, and a secret is exactly a field that may
// be a Secrets Store binding. A drift tripwire, not a proof: it reads the interface as text, one
// member per line, the way src/env.ts writes it. An app may add fields of its own to its Env, so
// the pin is kit only; the vocabulary's own consistency is checked everywhere. Run by `node --test`
// (test:scripts).
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { isTemplateRepo, parseJsonc } from '../../scripts/new-app.mjs';
import {
  ISRAEL_DEFAULTS,
  RUNTIME_SETTINGS,
  SETTING_KINDS,
} from '../../src/platform/runtimeConfig.mjs';

const ROOT = join(import.meta.dirname, '..', '..');
// Env members whose type is a binding, not a variable or a secret.
const BINDING_TYPE = /\b(?:D1Database|KVNamespace|R2Bucket|EmailSender|Fetcher|Workflow)\b/;

/** The members of `export interface Env { … }` in `source`: name → type text. */
function envMembers(source) {
  const start = source.indexOf('export interface Env {');
  assert.notEqual(start, -1, 'src/env.ts declares Env');
  const end = source.indexOf('\n}\n', start);
  assert.notEqual(end, -1, 'Env closes');
  const members = new Map();
  for (const line of source.slice(start, end).split('\n')) {
    const m = /^ {2}([A-Z][A-Z0-9_]*)\??:\s*(.+);\s*$/.exec(line);
    if (m) members.set(m[1], m[2]);
  }
  return members;
}

describe('the runtime vocabulary is consistent', () => {
  const names = RUNTIME_SETTINGS.map((s) => s.name);

  it('names each setting once, with a kind, a feature, a CIAL mechanism and a DB Israel default', () => {
    assert.ok(RUNTIME_SETTINGS.length > 20);
    assert.equal(new Set(names).size, names.length, 'no name twice');
    for (const s of RUNTIME_SETTINGS) {
      assert.match(s.name, /^[A-Z][A-Z0-9_]*$/, s.name);
      assert.ok(SETTING_KINDS.includes(s.kind), `${s.name}: kind ${s.kind}`);
      assert.equal(typeof s.feature, 'string', s.name);
      assert.ok(s.feature.length > 0, s.name);
      assert.equal(typeof s.cial, 'string', s.name);
      assert.ok(s.cial.length > 0, s.name);
      assert.ok(ISRAEL_DEFAULTS.includes(s.israel), `${s.name}: israel ${s.israel}`);
      assert.ok(Array.isArray(s.enabledBy), s.name);
    }
  });

  it('turns a feature on only with variables it lists', () => {
    const vars = new Set(RUNTIME_SETTINGS.filter((s) => s.kind === 'var').map((s) => s.name));
    for (const s of RUNTIME_SETTINGS) {
      for (const by of s.enabledBy) {
        assert.ok(vars.has(by), `${s.name} is enabled by ${by}, which is not a listed variable`);
        assert.notEqual(by, s.name, `${s.name} enables itself`);
      }
    }
  });

  it('gives a secret no value: the proposal declares it or leaves it to a decision', () => {
    const valueDefaults = ['app-name', 'stage', 'staging-host', 'placeholder-sender', 'config'];
    for (const s of RUNTIME_SETTINGS.filter((x) => x.kind === 'secret')) {
      assert.equal(valueDefaults.includes(s.israel), false, `${s.name}: ${s.israel}`);
    }
  });

  it('holds the four values the proposal computes, each on its variable', () => {
    const computed = Object.fromEntries(
      RUNTIME_SETTINGS.filter((s) =>
        ['app-name', 'stage', 'staging-host', 'placeholder-sender'].includes(s.israel),
      ).map((s) => [s.name, s.israel]),
    );
    assert.deepEqual(computed, {
      APP_NAME: 'app-name',
      APP_ENV: 'stage',
      DASHBOARD_HOST: 'staging-host',
      MAIL_FROM: 'placeholder-sender',
    });
  });
});

describe('the runtime vocabulary matches src/env.ts', {
  skip: !isTemplateRepo(ROOT) && 'kit only: an app may add fields of its own to Env',
}, () => {
  const members = envMembers(readFileSync(join(ROOT, 'src', 'env.ts'), 'utf8'));
  const settings = new Map(RUNTIME_SETTINGS.map((s) => [s.name, s]));

  it('reads the interface (a check on the reader itself)', () => {
    for (const name of ['DB', 'APP_NAME', 'ANTHROPIC_API_KEY', 'AUDIT_MATCH']) {
      assert.ok(members.has(name), name);
    }
    assert.ok(members.size > 40, `${members.size} members`);
  });

  it('every variable and secret Env declares is in the vocabulary, and nothing else is', () => {
    const declared = [...members]
      .filter(([, type]) => !BINDING_TYPE.test(type))
      .map(([name]) => name)
      .sort();
    assert.deepEqual([...settings.keys()].sort(), declared);
  });

  it('a secret is exactly a field that may be a Secrets Store binding', () => {
    for (const [name, s] of settings) {
      const secret = /\bSecretsStoreSecret\b/.test(members.get(name) ?? '');
      assert.equal(s.kind, secret ? 'secret' : 'var', name);
    }
  });

  it("every variable the kit's own wrangler configs set is in the vocabulary as a variable", () => {
    for (const file of ['wrangler.jsonc', 'wrangler.staging.jsonc']) {
      const vars = parseJsonc(readFileSync(join(ROOT, file), 'utf8')).vars;
      for (const name of Object.keys(vars)) {
        assert.equal(settings.get(name)?.kind, 'var', `${file}: ${name}`);
      }
    }
  });
});

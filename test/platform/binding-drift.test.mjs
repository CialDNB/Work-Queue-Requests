// Pins scripts/check-binding-drift.mjs — the ONE detective control in the cross-app work.
// Everything else (DECISIONS 2026-08-18) is preventive because Cloudflare logs nothing for D1
// queries; Worker *settings* are readable, so "is this Worker still bound to what the repo
// declares?" is the one question answerable after the fact. It matters because
// `Workers Scripts: Edit` is account-wide and a deploy PRESERVES secrets and bindings, so any
// app's token can replace any Worker in the shared account and inherit what it could reach.
//
// Run by `node --test` (node:fs + no Workers runtime), so it's a *.test.mjs.
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import {
  COMPARED,
  declaredBindings,
  evaluate,
  liveBindings,
  run,
} from '../../scripts/check-binding-drift.mjs';
import { parseJsonc } from '../../scripts/new-app.mjs';

const root = new URL('../../', import.meta.url);
const read = (p) => readFileSync(new URL(p, root), 'utf8');
// The repo's own Worker names: run() reads this repo's configs, and a renamed app has its own.
const workerName = (file) => parseJsonc(read(file)).name;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const cfg = {
  name: 'arena-go',
  account_id: 'acct',
  d1_databases: [{ binding: 'DB', database_name: 'arena-go-db', database_id: 'uuid-a' }],
  kv_namespaces: [{ binding: 'SESSIONS', id: 'kv-a' }],
  r2_buckets: [{ binding: 'BACKUPS', bucket_name: 'arena-go-backups' }],
};
const liveOk = {
  bindings: [
    { name: 'DB', type: 'd1', id: 'uuid-a' },
    { name: 'SESSIONS', type: 'kv_namespace', namespace_id: 'kv-a' },
    { name: 'BACKUPS', type: 'r2_bucket', bucket_name: 'arena-go-backups' },
  ],
};

describe('binding extraction', () => {
  it('reads declared resource bindings out of a wrangler config', () => {
    assert.deepEqual(
      [...declaredBindings(cfg).entries()],
      [
        ['DB', { type: 'd1', target: 'uuid-a' }],
        ['SESSIONS', { type: 'kv_namespace', target: 'kv-a' }],
        ['BACKUPS', { type: 'r2_bucket', target: 'arena-go-backups' }],
      ],
    );
  });

  it('reads live bindings, tolerating the API naming the d1 target `id` or `database_id`', () => {
    assert.equal(
      liveBindings({ bindings: [{ name: 'DB', type: 'd1', id: 'x' }] }).get('DB').target,
      'x',
    );
    assert.equal(
      liveBindings({ bindings: [{ name: 'DB', type: 'd1', database_id: 'y' }] }).get('DB').target,
      'y',
    );
  });

  // The cardinal sin for a fleet-wide daily check is a false red. vars, secrets, assets,
  // send_email and AI bindings all appear in the live array but come from elsewhere.
  it('IGNORES non-resource binding types, which would otherwise false-red every single run', () => {
    const live = liveBindings({
      bindings: [
        { name: 'DB', type: 'd1', id: 'uuid-a' },
        { name: 'APP_NAME', type: 'plain_text' },
        { name: 'SEAL_KEY', type: 'secret_text' },
        { name: 'ASSETS', type: 'assets' },
        { name: 'EMAIL', type: 'send_email' },
        { name: 'AI', type: 'ai' },
      ],
    });
    assert.deepEqual([...live.keys()], ['DB']);
  });
});

describe('evaluate', () => {
  it('finds nothing when the deployed Worker matches the repo', () => {
    assert.deepEqual(evaluate(declaredBindings(cfg), liveBindings(liveOk)), []);
  });

  it('RETARGETED is the headline finding — a binding kept its name and changed its target', () => {
    const live = liveBindings({
      bindings: [
        { name: 'DB', type: 'd1', id: 'uuid-SOMEONE-ELSE' },
        { name: 'SESSIONS', type: 'kv_namespace', namespace_id: 'kv-a' },
        { name: 'BACKUPS', type: 'r2_bucket', bucket_name: 'arena-go-backups' },
      ],
    });
    const findings = evaluate(declaredBindings(cfg), live);
    assert.equal(findings.length, 1);
    assert.match(findings[0], /^RETARGETED/);
    assert.match(findings[0], /uuid-SOMEONE-ELSE/);
  });

  it('flags an EXTRA binding the repo never declared', () => {
    const live = liveBindings({
      bindings: [...liveOk.bindings, { name: 'OTHER_DB', type: 'd1', id: 'uuid-b' }],
    });
    const findings = evaluate(declaredBindings(cfg), live);
    assert.equal(findings.length, 1);
    assert.match(findings[0], /^EXTRA/);
    assert.match(findings[0], /OTHER_DB/);
  });

  it('flags a MISSING binding', () => {
    const live = liveBindings({ bindings: liveOk.bindings.slice(1) });
    const findings = evaluate(declaredBindings(cfg), live);
    assert.equal(findings.length, 1);
    assert.match(findings[0], /^MISSING/);
  });

  it('flags a RETYPED binding rather than reporting a bogus retarget', () => {
    const live = liveBindings({
      bindings: [
        { name: 'DB', type: 'kv_namespace', namespace_id: 'kv-z' },
        ...liveOk.bindings.slice(1),
      ],
    });
    const findings = evaluate(declaredBindings(cfg), live);
    assert.ok(findings.some((f) => f.startsWith('RETYPED')));
    assert.ok(!findings.some((f) => f.startsWith('RETARGETED')));
  });

  it('ranks RETARGETED and EXTRA above MISSING — those two mean somebody else touched it', () => {
    const live = liveBindings({
      bindings: [
        { name: 'DB', type: 'd1', id: 'uuid-other' },
        { name: 'SNEAKY', type: 'r2_bucket', bucket_name: 'other-app-backups' },
      ],
    });
    const findings = evaluate(declaredBindings(cfg), live);
    assert.match(findings[0], /^RETARGETED/);
    assert.match(findings[1], /^EXTRA/);
    assert.ok(findings.slice(2).every((f) => f.startsWith('MISSING')));
  });

  it('does not invent a retarget when the API reported no target field', () => {
    const live = liveBindings({
      bindings: [{ name: 'DB', type: 'd1' }, ...liveOk.bindings.slice(1)],
    });
    assert.deepEqual(evaluate(declaredBindings(cfg), live), []);
  });
});

describe('run', () => {
  it('fails closed when the settings call fails — an unreadable Worker is not a verified one', async () => {
    const get = async () => ({ success: false, errors: [{ message: 'Authentication error' }] });
    const out = await run('production', { token: 't', get });
    assert.equal(out.failed, true);
    assert.match(out.findings[0], /could not read deployed settings/);
  });

  it("asks for this env's script settings on this account", async () => {
    const seen = [];
    const get = async (_token, path) => {
      seen.push(path);
      return { success: true, result: { bindings: [] } };
    };
    await run('production', { token: 't', get });
    const production = escapeRe(workerName('wrangler.jsonc'));
    assert.match(seen[0], new RegExp(`^/accounts/[^/]+/workers/scripts/${production}/settings$`));
    seen.length = 0;
    await run('staging', { token: 't', get });
    const staging = escapeRe(workerName('wrangler.staging.jsonc'));
    assert.match(seen[0], new RegExp(`/workers/scripts/${staging}/settings$`));
  });
});

describe('wiring', () => {
  it('runs daily alongside the edge-drift check, which shares its schedule and token', () => {
    const wf = read('.github/workflows/edge-live.yml');
    assert.match(wf, /check-binding-drift\.mjs --env staging/);
    assert.match(wf, /check-binding-drift\.mjs --env production/);
    // The `env:` block follows the `run:` line, so look forward from the invocation.
    const stepAt = wf.indexOf('check-binding-drift.mjs');
    assert.match(wf.slice(stepAt, stepAt + 300), /CLOUDFLARE_API_TOKEN/);
  });

  it('compares every resource binding type the kit can declare', () => {
    assert.deepEqual(COMPARED.map((c) => c.type).sort(), [
      'd1',
      'hyperdrive',
      'kv_namespace',
      'queue',
      'r2_bucket',
    ]);
  });
});

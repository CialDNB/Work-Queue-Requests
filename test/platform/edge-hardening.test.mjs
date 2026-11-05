// Pins scripts/check-edge-hardening.mjs — the guard that keeps workers.dev + preview URLs
// OFF on every deploying wrangler config (the custom domain is the only ingress, so the zone
// WAF / rate limiting cover all traffic). Run by `node --test` (NOT vitest's Workers pool:
// the guard imports node:fs), so it's a *.test.mjs, outside the `test/**/*.test.ts` glob.
//
// Why this file exists: the guard is what forces forks to adopt the flags (wrangler.jsonc is
// not in the /kit-upgrade diff set). If the guard silently passed everything, that enforcement
// would be hollow — so we pin both that the real configs pass and that a bad config fails.
//
// A FORK RUNS ITS OWN COPY. /kit-upgrade does not carry this file (several cases are kit-shaped
// and forks localize them), but it does carry the gate, and `test:scripts` runs the fork's copy
// against it. So a release that changes what the gate refuses must tell forks how to update
// their copy, in its CHANGELOG manual steps — this file is not "the kit's alone".
import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import * as GATE from '../../scripts/check-edge-hardening.mjs';
import {
  AGENT_ARMABLE_ENVS,
  AGENT_ARMING_RECORD_VAR,
  AGENT_ENABLED_VAR,
  AGENT_REAPER_CRON,
  AGENT_RETENTION_VAR,
  AGENT_RUN_BINDING,
  AGENT_RUN_CLASS,
  ALLOWLIST_FILE,
  ARMING_VARS,
  agentArmingFailures,
  aiConfigFailures,
  bindingAllowlistFailures,
  CONFIG_SUFFIX,
  checkAgentArming,
  checkAiConfig,
  checkBindingAllowlist,
  checkEdgeHardening,
  checkResourceNaming,
  cliVarOverrideFailures,
  commandLines,
  configFailures,
  configReadFailure,
  DEPLOYING_CONFIGS,
  discoveredNamingFailures,
  foreignWorkflowFailures,
  GATED_BINDINGS,
  grantFailure,
  IDENTITY_CONFIG,
  isUnforkedTemplate,
  namingFailures,
  nestedGatedBindingFailures,
  observabilityFailures,
  parseAuroraSources,
  positiveDays,
  READ_AUDIT_ARMED,
  READ_AUDIT_VAR,
  REQUIRED,
  readAuditArmed,
  SOURCE_CLASSES,
  SOURCES_FILE,
  sourceNameForBinding,
  sourceRegistryFailures,
  sourceTableFailures,
  unsafeBindingFailures,
  VAULT_RETENTION_VAR,
  workflowDurationDays,
  workflowNameClashFailures,
  workflowRetentionSupport,
  wranglerConfigsOnDisk,
} from '../../scripts/check-edge-hardening.mjs';
import { parseJsonc, TEMPLATE_KEBAB } from '../../scripts/new-app.mjs';
// The agent's arming vocabulary as its own module defines it, so the identity pins below compare
// the gate's re-exports against the source rather than against values retyped here.
import * as AGENT_VOCABULARY from '../../src/ai/agentVocabulary.mjs';
import {
  ALLOWED_MODELS as AI_ALLOWED_MODELS,
  MODEL_VARS as AI_MODEL_VARS,
} from '../../src/ai/policyVocabulary.mjs';
// The DEFINITION, imported straight from the shared module — so the last case below compares what
// the gate acts on against its source rather than against a literal retyped here.
import {
  READ_AUDIT_ARMED as VOCABULARY_ARMED,
  isReadAuditArmed as VOCABULARY_IS_ARMED,
  READ_AUDIT_VAR as VOCABULARY_VAR,
} from '../../src/framework/readAuditVocabulary.mjs';

describe('edge-hardening guard', () => {
  it('passes on the repo wrangler.jsonc + wrangler.staging.jsonc', () => {
    assert.deepEqual(checkEdgeHardening(), []);
  });

  it('covers both deploying configs (not the test config)', () => {
    assert.deepEqual(DEPLOYING_CONFIGS, ['wrangler.jsonc', 'wrangler.staging.jsonc']);
    assert.deepEqual(REQUIRED, { workers_dev: false, preview_urls: false });
  });

  it('accepts a config that disables workers.dev + preview URLs', () => {
    assert.deepEqual(configFailures('ok.jsonc', { workers_dev: false, preview_urls: false }), []);
  });

  it('flags a config that omits the flags', () => {
    const failures = configFailures('bad.jsonc', { name: 'x' });
    assert.equal(failures.length, 2);
    assert.ok(failures.some((f) => f.includes('workers_dev')));
    assert.ok(failures.some((f) => f.includes('preview_urls')));
  });

  it('flags a config that re-enables workers.dev', () => {
    const failures = configFailures('bad.jsonc', { workers_dev: true, preview_urls: false });
    assert.equal(failures.length, 1);
    assert.ok(failures[0].includes('workers_dev'));
  });

  it('flags an unparseable config', () => {
    assert.deepEqual(configFailures('broken.jsonc', null), ['broken.jsonc: not valid JSONC']);
  });

  // Wrangler environments inherit workers_dev / preview_urls unless they override them — so an
  // env block is a place the ingress the top level closed can quietly re-open, per environment.
  it('flags an env block that re-enables workers.dev', () => {
    const failures = configFailures('bad.jsonc', {
      workers_dev: false,
      preview_urls: false,
      env: { staging: { workers_dev: true } },
    });
    assert.equal(failures.length, 1);
    assert.ok(failures[0].includes('env.staging'));
    assert.ok(failures[0].includes('workers_dev'));
  });

  it('accepts an env block that repeats the required values or sets neither key', () => {
    for (const env of [{ staging: {} }, { staging: { workers_dev: false, preview_urls: false } }]) {
      assert.deepEqual(
        configFailures('ok.jsonc', { workers_dev: false, preview_urls: false, env }),
        [],
      );
    }
  });
});

// Workers Logs' per-invocation record carries the request URL — a live magic-link token on
// GET /auth/verify?token=…, an address on /api/users/:email — into a log that keeps every line 7
// days and cannot delete one (PIA C5). logEvent() covers the Worker's own lines; this pins that
// every config that turns Workers Logs on also turns that record off, and that the gate is not
// hollow: each way a config can leave it on is refused.
describe('invocation logs off wherever Workers Logs are on (PIA C5)', () => {
  const base = { workers_dev: false, preview_urls: false };
  const on = { enabled: true, head_sampling_rate: 1 };

  it('the repo deploying configs turn Workers Logs on AND invocation logs off', () => {
    for (const file of DEPLOYING_CONFIGS) {
      const cfg = parseJsonc(readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8'));
      assert.equal(cfg.observability.enabled, true, file);
      assert.equal(cfg.observability.logs.invocation_logs, false, file);
    }
  });

  it('refuses Workers Logs on with invocation logs left at the default, or turned on', () => {
    for (const logs of [undefined, {}, { invocation_logs: true }, { invocation_logs: 'false' }]) {
      const failures = configFailures('bad.jsonc', { ...base, observability: { ...on, logs } });
      assert.equal(failures.length, 1, JSON.stringify(logs));
      assert.ok(failures[0].includes('invocation_logs'));
      assert.ok(failures[0].includes('PIA C5'));
    }
  });

  it('refuses logs switched on by `logs.enabled` even when the top level says disabled', () => {
    const failures = observabilityFailures('bad.jsonc', {
      enabled: false,
      logs: { enabled: true },
    });
    assert.equal(failures.length, 1);
  });

  it('treats an ambiguous block as ON (fail closed), and a non-object as unreadable', () => {
    assert.equal(observabilityFailures('x', { head_sampling_rate: 1 }).length, 1);
    assert.equal(observabilityFailures('x', null).length, 1);
    assert.equal(observabilityFailures('x', true).length, 1);
  });

  it('accepts invocation logs off, logs explicitly off, or no observability block at all', () => {
    for (const observability of [
      { ...on, logs: { invocation_logs: false } },
      { enabled: false },
      { ...on, logs: { enabled: false } },
      undefined,
    ]) {
      assert.deepEqual(configFailures('ok.jsonc', { ...base, observability }), []);
    }
  });

  it('checks an env block’s own observability (it replaces the top level’s)', () => {
    const failures = configFailures('bad.jsonc', {
      ...base,
      observability: { ...on, logs: { invocation_logs: false } },
      env: { staging: { observability: on } },
    });
    assert.equal(failures.length, 1);
    assert.ok(failures[0].includes('env.staging'));
  });
});

// The private-database binding gate. A Hyperdrive / Workers VPC binding is a live database
// credential with no per-Worker scope anywhere in Cloudflare, so binding-allowlist.jsonc is the
// only reviewed grant — and these cases pin that it fails CLOSED. Every one of them is a way the
// gate could be hollow rather than absent, which is the failure mode that matters: a guard that
// passes everything reads exactly like a guard that works.
const ok = { binding: 'HYPERDRIVE_RET1_RO', id: 'abc123' };
// Grants carry a class. `internal` is the fixture default because it is the one that needs no
// arming — the client-class cases below are written out in full, where the extra requirement is
// the point being made.
const INTERNAL_GRANT = { id: 'abc123', class: 'internal' };

describe('private-database binding guard', () => {
  it('passes on the repo configs (the kit binds no private database)', () => {
    assert.deepEqual(checkBindingAllowlist(), []);
  });

  it('gates both binding kinds, each with its id key and name prefix', () => {
    assert.deepEqual(GATED_BINDINGS, {
      hyperdrive: { idKey: 'id', prefix: 'HYPERDRIVE_' },
      vpc_services: { idKey: 'service_id', prefix: 'VPC_' },
      vpc_networks: { idKey: 'network_id', prefix: 'VPC_' },
    });
  });

  // The broadest binding of the three, and the one most worth catching: `cf1:network` reaches
  // every private service in the account. Gating the narrow kinds and missing this one would
  // have left the guard covering the careful path and waving through the reckless one.
  it('flags an ungranted vpc_networks binding', () => {
    const f = bindingAllowlistFailures(
      'w.jsonc',
      { vpc_networks: [{ binding: 'VPC_MESH', network_id: 'cf1:network' }] },
      { vpc_networks: [] },
    );
    assert.equal(f.length, 1);
    assert.ok(f[0].includes('network_id'));
    assert.ok(f[0].includes('cf1:network'));
  });

  it('accepts a binding whose id is granted', () => {
    assert.deepEqual(
      bindingAllowlistFailures('w.jsonc', { hyperdrive: [ok] }, { hyperdrive: [INTERNAL_GRANT] }),
      [],
    );
  });

  it('accepts a config that binds nothing against empty grants', () => {
    assert.deepEqual(bindingAllowlistFailures('w.jsonc', { name: 'x' }, { hyperdrive: [] }), []);
  });

  it('flags a binding whose id is NOT granted', () => {
    const f = bindingAllowlistFailures('w.jsonc', { hyperdrive: [ok] }, { hyperdrive: [] });
    assert.equal(f.length, 1);
    assert.ok(f[0].includes(`not in ${ALLOWLIST_FILE}`));
  });

  it('flags a config with no allowlist entry at all (absent is not empty)', () => {
    const f = bindingAllowlistFailures('w.jsonc', { hyperdrive: [ok] }, undefined);
    assert.equal(f.length, 1);
    assert.ok(f[0].includes('no entry in'));
  });

  it('flags a binding not named with the fenced prefix', () => {
    const f = bindingAllowlistFailures(
      'w.jsonc',
      { hyperdrive: [{ binding: 'HD', id: 'abc123' }] },
      { hyperdrive: [INTERNAL_GRANT] },
    );
    assert.equal(f.length, 1);
    assert.ok(f[0].includes('must be named HYPERDRIVE_*'));
  });

  it('flags an unfilled placeholder id', () => {
    const f = bindingAllowlistFailures(
      'w.jsonc',
      { hyperdrive: [{ binding: 'HYPERDRIVE_RET1_RO', id: '<fill me in>' }] },
      { hyperdrive: [] },
    );
    assert.equal(f.length, 1);
    assert.ok(f[0].includes('unfilled placeholder'));
  });

  it('flags a binding with no id', () => {
    const f = bindingAllowlistFailures(
      'w.jsonc',
      { hyperdrive: [{ binding: 'HYPERDRIVE_RET1_RO' }] },
      { hyperdrive: [] },
    );
    assert.equal(f.length, 1);
    assert.ok(f[0].includes('has no "id"'));
  });

  it('flags a stale grant nobody binds', () => {
    const f = bindingAllowlistFailures(
      'w.jsonc',
      {},
      { hyperdrive: [{ id: 'orphan', class: 'internal' }] },
    );
    assert.equal(f.length, 1);
    assert.ok(f[0].includes('does not bind'));
  });

  it('flags a vpc_services binding by its own id key and prefix', () => {
    const f = bindingAllowlistFailures(
      'w.jsonc',
      { vpc_services: [{ binding: 'VPC_IPA', service_id: 'svc-1' }] },
      { vpc_services: [] },
    );
    assert.equal(f.length, 1);
    assert.ok(f[0].includes('service_id'));
  });

  it('flags a non-array binding block', () => {
    const f = bindingAllowlistFailures('w.jsonc', { hyperdrive: {} }, { hyperdrive: [] });
    assert.equal(f.length, 1);
    assert.ok(f[0].includes('must be an array'));
  });

  it('flags an unparseable config', () => {
    assert.deepEqual(bindingAllowlistFailures('broken.jsonc', null, {}), [
      'broken.jsonc: not valid JSONC',
    ]);
  });
});

// The read-attribution half (Fleet Ledger K2a). A grant now says WHOSE data is behind it, and the
// class it names selects the failure posture the running seam takes. These cases pin that the
// class cannot be omitted, cannot be guessed, cannot disagree with the code, and — for client data
// — cannot arrive without the ledger armed. Every one of them is a way to hold the permission
// while quietly dropping the control it is conditional on.
describe('grant class + read-audit arming', () => {
  const armed = { vars: { [READ_AUDIT_VAR]: READ_AUDIT_ARMED } };
  const clientBinding = { binding: 'HYPERDRIVE_C360_RO', id: 'cli-1' };
  const clientGrant = { id: 'cli-1', class: 'client' };

  it('names both classes', () => {
    assert.deepEqual(SOURCE_CLASSES, ['client', 'internal']);
  });

  // No default, on purpose: 'internal' would silently downgrade a client database to the
  // fire-and-forget path, and 'client' would arm-gate a grant whose author never considered it.
  it('rejects a bare id with no class', () => {
    const f = grantFailure('w.jsonc', 'hyperdrive', 'abc123');
    assert.ok(f.includes('bare id'));
    assert.ok(f.includes('no safe default'));
  });

  it('rejects an unknown or missing class', () => {
    for (const grant of [{ id: 'a' }, { id: 'a', class: 'confidential' }, { id: 'a', class: '' }]) {
      assert.ok(grantFailure('w.jsonc', 'hyperdrive', grant).includes('class'));
    }
  });

  it('rejects a grant with no id at all', () => {
    assert.ok(grantFailure('w.jsonc', 'hyperdrive', { class: 'client' }).includes('no "id"'));
    assert.ok(grantFailure('w.jsonc', 'hyperdrive', null).includes('no "id"'));
  });

  it('accepts a well-formed grant of either class', () => {
    assert.equal(grantFailure('w.jsonc', 'hyperdrive', clientGrant), null);
    assert.equal(grantFailure('w.jsonc', 'hyperdrive', INTERNAL_GRANT), null);
  });

  // THE new gate. Read attribution is the compensating control for client data on a shared
  // Cloudflare account; a config that takes the binding and skips the declaration has taken the
  // permission without the control, so it does not deploy.
  it('flags a client-class binding in a config that has not armed read-audit', () => {
    const f = bindingAllowlistFailures(
      'w.jsonc',
      { hyperdrive: [clientBinding] },
      { hyperdrive: [clientGrant] },
    );
    assert.equal(f.length, 1);
    assert.ok(f[0].includes(READ_AUDIT_VAR));
    assert.ok(f[0].includes('cli-1'));
  });

  it('accepts the same binding once the config arms read-audit', () => {
    assert.deepEqual(
      bindingAllowlistFailures(
        'w.jsonc',
        { ...armed, hyperdrive: [clientBinding] },
        { hyperdrive: [clientGrant] },
      ),
      [],
    );
  });

  it('does not require arming for an internal-class binding', () => {
    assert.deepEqual(
      bindingAllowlistFailures('w.jsonc', { hyperdrive: [ok] }, { hyperdrive: [INTERNAL_GRANT] }),
      [],
    );
  });

  // A truthy-looking value is not the flag. The check compares against one exact string so that
  // "false", "off", or "0" cannot arm the ledger by being non-empty.
  it('treats any value other than the exact flag as unarmed', () => {
    for (const value of ['false', 'off', '0', 'true', '']) {
      const f = bindingAllowlistFailures(
        'w.jsonc',
        { vars: { [READ_AUDIT_VAR]: value }, hyperdrive: [clientBinding] },
        { hyperdrive: [clientGrant] },
      );
      assert.equal(f.length, 1, `"${value}" must not arm the ledger`);
    }
  });

  // A binding the config does not actually declare must not arm-gate anything — otherwise the
  // gate fires on grants that reach no worker, and a noisy gate gets silenced.
  it('does not demand arming for a client grant nobody binds', () => {
    const f = bindingAllowlistFailures('w.jsonc', {}, { hyperdrive: [clientGrant] });
    assert.equal(f.length, 1);
    assert.ok(f[0].includes('does not bind'));
  });
});

// The allowlist says a database is client-class; AURORA_SOURCES is what the RUNNING CODE consults
// to pick the posture. If they disagree, the grant documents a protection the seam would not
// apply — a control that is present on paper and absent in fact, which is worse than none.
describe('source-registry cross-check', () => {
  const cfg = { hyperdrive: [{ binding: 'HYPERDRIVE_C360_RO', id: 'cli-1' }] };
  const granted = { hyperdrive: [{ id: 'cli-1', class: 'client' }] };

  it('mirrors the seam’s binding→source derivation', () => {
    assert.equal(sourceNameForBinding('HYPERDRIVE_RET1_RO'), 'ret1_ro');
    assert.equal(sourceNameForBinding('VPC_IPA'), 'ipa');
  });

  it('passes when the class agrees', () => {
    assert.deepEqual(sourceRegistryFailures('w.jsonc', cfg, granted, { c360_ro: 'client' }), []);
  });

  it('flags a class that disagrees with the code', () => {
    const f = sourceRegistryFailures('w.jsonc', cfg, granted, { c360_ro: 'internal' });
    assert.equal(f.length, 1);
    assert.ok(f[0].includes('claims a protection'));
  });

  it('flags a granted binding with no source registered at all', () => {
    const f = sourceRegistryFailures('w.jsonc', cfg, granted, {});
    assert.equal(f.length, 1);
    assert.ok(f[0].includes('absent from AURORA_SOURCES'));
  });

  // Fail CLOSED on an unreadable table. A regex over source is a weak reader, so "I could not
  // tell" must mean failure — the alternative is a check that silently stops checking the day
  // someone reformats the file.
  it('fails every grant when the source table cannot be read', () => {
    const f = sourceRegistryFailures('w.jsonc', cfg, granted, null);
    assert.equal(f.length, 1);
    assert.ok(f[0].includes('statically'));
  });

  it('is silent for a config that binds nothing, even with no readable table', () => {
    assert.deepEqual(sourceRegistryFailures('w.jsonc', {}, {}, null), []);
  });

  it('reads a plain object literal and refuses anything it cannot see', () => {
    // Whole declarations: the table is read with a parser, so a fragment is not a table.
    assert.deepEqual(parseAuroraSources('export const AURORA_SOURCES = Object.freeze({});'), {});
    assert.deepEqual(
      parseAuroraSources(
        "export const AURORA_SOURCES = Object.freeze({ a_ro: 'client', b_ro: 'internal' }) satisfies X;",
      ),
      { a_ro: 'client', b_ro: 'internal' },
    );
    // A spread hides entries from a static reader; so does an absent table.
    assert.equal(
      parseAuroraSources("export const AURORA_SOURCES = Object.freeze({ ...more, a: 'client' });"),
      null,
    );
    assert.equal(parseAuroraSources('no table here'), null);
    // A class outside the reviewed two is residue, so the whole table reads as unreadable —
    // which is a failure, not a skipped entry.
    assert.equal(
      parseAuroraSources("export const AURORA_SOURCES = Object.freeze({ a_ro: 'public' });"),
      null,
    );
  });

  // FORK-DURABLE. Not "the table is empty" — that stops being true on the first source a fork
  // registers, and this file used to assert it, which is what made adopting the seam an edit to
  // a kit-owned test. What must hold everywhere: the table can be read statically, and every
  // entry in it is well formed.
  it('reads the real seam file statically, and everything in it is well formed', () => {
    const sources = parseAuroraSources(readSeam());
    assert.notEqual(sources, null, `${SOURCES_FILE}: AURORA_SOURCES must stay statically readable`);
    assert.deepEqual(sourceTableFailures(sources, false), []);
  });
});

/** The seam file, as text. */
function readSeam() {
  return readFileSync(new URL(`../../${SOURCES_FILE}`, import.meta.url), 'utf8');
}

// "The kit ships closed" is a real guarantee and worth proving — but it is a property OF THE KIT,
// and the three assertions that used to prove it (two here in test/data/aurora.test.ts, one here)
// fired on the first fork that bound a database, so adopting the seam meant editing kit-owned test
// files in a feature PR. arena-go hit all three. The fix is not to drop the proof: it is to
// condition it on the one thing that distinguishes the kit from an app built on it, so it stays
// loud here and goes quiet there. See DECISIONS 2026-08-21.
describe('source table — the kit’s proof, and the fork’s invariants', () => {
  // The identity config must be one the gate actually parses, or `parsed.get()` returns
  // undefined forever and the emptiness clause silently stops firing on the kit itself.
  it('reads the app’s identity from a config the gate already parses', () => {
    assert.ok(DEPLOYING_CONFIGS.includes(IDENTITY_CONFIG));
  });

  it('tells the unforked kit from an app by the production config’s name', () => {
    assert.equal(isUnforkedTemplate({ name: TEMPLATE_KEBAB }), true);
    assert.equal(isUnforkedTemplate({ name: 'arena-go' }), false);
    assert.equal(isUnforkedTemplate({}), false);
    assert.equal(isUnforkedTemplate(null), false);
    assert.equal(isUnforkedTemplate(undefined), false);
  });

  it('holds the kit to an empty table, and says so in a way that names the bootstrap', () => {
    assert.deepEqual(sourceTableFailures({}, true), []);
    const f = sourceTableFailures({ ret1_ro: 'internal' }, true);
    assert.equal(f.length, 1);
    assert.ok(f[0].includes('ships empty'));
    assert.ok(f[0].includes('new-app'));
  });

  // THE point of the change: the same table in a fork is not a failure at all.
  it('goes quiet on a fork that has registered sources', () => {
    assert.deepEqual(sourceTableFailures({ ret1_ro: 'internal', c360_ro: 'client' }, false), []);
  });

  it('fails closed on a table it cannot read, forked or not', () => {
    for (const unforked of [true, false]) {
      const f = sourceTableFailures(null, unforked);
      assert.equal(f.length, 1, `unforked=${unforked}`);
      assert.ok(f[0].includes('statically'));
    }
  });

  // The parser already refuses both of these upstream (they read as residue, so the table comes
  // back null). Checked again here because this function's contract is "the table is well formed"
  // whatever produced the object — a future, laxer reader must not silently widen what is legal.
  it('refuses an entry that is not a lowercase source name, or not a reviewed class', () => {
    const name = sourceTableFailures({ RET1_RO: 'internal' }, false);
    assert.equal(name.length, 1);
    assert.ok(name[0].includes('LOWERCASED'));

    const cls = sourceTableFailures({ ret1_ro: 'public' }, false);
    assert.equal(cls.length, 1);
    assert.ok(cls[0].includes(`must be one of ${SOURCE_CLASSES.join(' | ')}`));
  });

  // Applied to THIS repo, which is the whole point: on the kit the predicate is true and the
  // emptiness is enforced; in a fork the predicate is false and only the durable half is. Either
  // way the gate is green, and neither state requires editing this file.
  it('is satisfied by this repo, in whichever state it is in', () => {
    const cfg = parseJsonc(
      readFileSync(new URL(`../../${IDENTITY_CONFIG}`, import.meta.url), 'utf8'),
    );
    const sources = parseAuroraSources(readSeam());
    const unforked = isUnforkedTemplate(cfg);
    assert.deepEqual(sourceTableFailures(sources, unforked), []);
    if (unforked) assert.deepEqual(sources, {}, 'the unforked kit binds no private database');
  });
});

// "READ_AUDIT is armed" is asserted by two things that never meet at runtime: the framework, which
// branches on it and reports it to the fleet registry, and this gate, which refuses a client-class
// private database in a config that has not armed the ledger. They used to spell the vocabulary out
// separately — two `'on'` literals agreeing by coincidence, with nothing checking the coincidence.
// The drift is not academic: change the word on the runtime side alone and this gate goes on
// enforcing a value nothing honours, while the app REPORTS arming to the registry that CI never
// checked. Green gate, `read_audit: true` on the wire, no read recorded anywhere.
//
// The fix is one definition, not two that match: src/framework/readAuditVocabulary.mjs, plain
// JavaScript so that plain-node and the esbuild-bundled worker can both literally import it. That
// makes disagreement unrepresentable — but only for as long as the single source HOLDS, and
// re-declaring a local constant is a two-line edit. So what this block pins is the property
// itself, structurally: exactly one declaration, and every consumer importing it.
//
// Source text, not behaviour, because there is no behaviour left to compare — that is the point.
// A comment containing something shaped like `const READ_AUDIT_ARMED =` would trip it; that
// direction (fails on a lookalike) is the one a gate is allowed to fail in.
describe('read-audit arming vocabulary — one definition, not two', () => {
  const VOCABULARY = 'src/framework/readAuditVocabulary.mjs';
  // The gate (this script) and the runtime (the framework predicate `executeRoute` and the daily
  // registry report both branch on). Historically the two independent definitions — these two must
  // IMPORT the vocabulary. The no-re-declaration half below is checked over the whole tree instead,
  // because "only in the shared module" is a claim about every file, and a THIRD file restating
  // `READ_AUDIT_ARMED = 'on'` is the original bug verbatim.
  const CONSUMERS = ['scripts/check-edge-hardening.mjs', 'src/framework/readAudit.ts'];
  const SEARCH_ROOTS = ['src', 'scripts'];
  const SEARCH_EXTENSIONS = ['.ts', '.tsx', '.mjs', '.js'];

  /** Every source file under SEARCH_ROOTS, repo-relative. */
  const treeFiles = () => {
    const found = [];
    const walk = (rel) => {
      const abs = new URL(`../../${rel}`, import.meta.url);
      for (const entry of readdirSync(abs, { withFileTypes: true })) {
        const child = `${rel}/${entry.name}`;
        if (entry.isDirectory()) walk(child);
        else if (SEARCH_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) found.push(child);
      }
    };
    for (const root of SEARCH_ROOTS) walk(root);
    return found;
  };
  // Both constants AND the comparison over them: sharing `'on'` while each side wrote its own
  // `===` would have left a live drift axis (one side made tolerant of `'ON'` or `' on '`).
  const NAMES = ['READ_AUDIT_ARMED', 'READ_AUDIT_VAR', 'isReadAuditArmed'];
  const declaration = (name) => new RegExp(`\\b(?:const|let|var|function)\\s+${name}\\b`, 'g');
  const read = (rel) => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');

  it('declares each name exactly once, and only in the shared module', () => {
    const vocabulary = read(VOCABULARY);
    for (const name of NAMES) {
      const declared = [...vocabulary.matchAll(declaration(name))];
      assert.equal(declared.length, 1, `${VOCABULARY} must declare ${name} exactly once`);
      assert.match(vocabulary, new RegExp(`^export (?:const|function) ${name}\\b`, 'm'));
    }
  });

  it('is imported by both historical consumers', () => {
    for (const rel of CONSUMERS) {
      assert.match(
        read(rel),
        /import\s*\{[^}]*\}\s*from\s*'[^']*readAuditVocabulary\.mjs'/,
        `${rel} must IMPORT the arming vocabulary, not restate it`,
      );
    }
  });

  // Over the whole worker + script tree, not the two files we happen to remember. A new
  // `src/mcp/readAuditStatus.ts` or a second check script restating the vocabulary is exactly the
  // bug this PR closed, and a hardcoded consumer list would not see it.
  it('is re-declared nowhere else in src/ or scripts/', () => {
    for (const rel of treeFiles()) {
      if (rel === VOCABULARY) continue;
      const text = read(rel);
      for (const name of NAMES) {
        assert.doesNotMatch(
          text,
          declaration(name),
          `${rel} re-declares ${name} — that is the second definition ${VOCABULARY} exists to remove`,
        );
      }
    }
  });

  // Nothing may be imported INTO the vocabulary. It is loaded by plain node (this gate) and by
  // esbuild (the worker); one repo-relative import of framework code would break the first, and
  // one node builtin would break the second — and either failure would arrive as a confusing
  // crash in `verify:edge` rather than as a review comment.
  it('the shared module depends on nothing', () => {
    const vocabulary = read(VOCABULARY);
    // Four shapes, because three of them do not start a line with `import`: a static import, a
    // re-export (`export { readFileSync } from 'node:fs'` is a real runtime dependency with no
    // `import` keyword at all), a dynamic `import(...)`, and CommonJS `require`. Any `from '…'`
    // clause is enough to catch the first two at once.
    assert.doesNotMatch(vocabulary, /^\s*import\s/m);
    assert.doesNotMatch(vocabulary, /\bfrom\s*['"`]/);
    assert.doesNotMatch(vocabulary, /\bimport\s*\(/);
    assert.doesNotMatch(vocabulary, /\brequire\s*\(/);
  });

  // The case the structural check CANNOT cover, and it is the likelier drift of the two: a
  // consumer that keeps the import and still writes its own comparison — lowercased, trimmed,
  // `'true'` accepted as a kindness — so the gate calls a config armed that the runtime would
  // not. Behavioural, over a table of near-misses, against the shared comparison itself rather
  // than against expectations retyped here. (The runtime half of this pair is pinned the same
  // way in test/framework/read-audit.test.ts, whose table is hardcoded on purpose.)
  //
  // Deliberately NOT covered: a consumer that inlines an EXACT `===` against the shared constant.
  // That is behaviour-identical, so this table stays green and nothing is wrong yet — and the
  // moment such an inlined comparison acquires a kindness, this table is what fires. Chasing it
  // with a source regex over the function body would buy a stylistic pin at the price of a
  // reformat reddening 17 forks' CI, which is the wrong trade for a fleet-wide gate.
  it('the gate’s own predicate agrees with the shared comparison, value for value', () => {
    const NEAR_MISSES = [
      VOCABULARY_ARMED,
      undefined,
      '',
      ' on ',
      'on ',
      'ON',
      'On',
      'true',
      '1',
      'yes',
      'off',
      0,
      1,
      true,
      null,
      {},
    ];
    for (const value of NEAR_MISSES) {
      assert.equal(
        readAuditArmed({ vars: { [VOCABULARY_VAR]: value } }),
        VOCABULARY_IS_ARMED(value),
        `the gate disagrees with the shared comparison on ${JSON.stringify(value)}`,
      );
    }
    // No `vars` at all, and no config at all: unarmed, never a crash.
    assert.equal(readAuditArmed({}), false);
    assert.equal(readAuditArmed(null), false);
    assert.equal(readAuditArmed(undefined), false);
  });

  // Belt to the structural braces: the value this gate enforces is the one the module defines,
  // and a config armed with it passes the arming check.
  it('enforces the value the shared module defines', () => {
    assert.equal(READ_AUDIT_ARMED, VOCABULARY_ARMED);
    assert.equal(READ_AUDIT_VAR, VOCABULARY_VAR);
    assert.equal(VOCABULARY_IS_ARMED(VOCABULARY_ARMED), true);
    // Exact, not armed-ish — the app is armed because it said the word.
    for (const near of [undefined, '', ' on ', 'ON', 'On', 'true', '1', 'yes', 'off']) {
      assert.equal(VOCABULARY_IS_ARMED(near), false, `${JSON.stringify(near)} must not arm`);
    }
    assert.deepEqual(
      bindingAllowlistFailures(
        'w.jsonc',
        {
          vars: { [VOCABULARY_VAR]: VOCABULARY_ARMED },
          hyperdrive: [{ binding: 'HYPERDRIVE_C360_RO', id: 'cli-1' }],
        },
        { hyperdrive: [{ id: 'cli-1', class: 'client' }] },
      ),
      [],
    );
  });
});

// The blind spot with a name. The binding gate used to read exactly two filenames, top-level keys
// only. CialDNB/Arena-2 binds its real Hyperdrive config under an env block in wrangler.jsonc AND
// in a second file, wrangler.mcp.jsonc — and the gate reported ZERO failures on that shape: grant
// never reviewed, prefix never enforced, READ_AUDIT never demanded, on an app holding client
// data. These cases pin the two closures: gated bindings under `env.*` are refused outright, and
// every root wrangler config is discovered and inspected rather than assumed away.
describe('nested env blocks are refused (pure)', () => {
  const nested = (kind, entry) => ({ env: { staging: { [kind]: [entry] } } });

  it('flags each gated kind under an env block', () => {
    for (const kind of Object.keys(GATED_BINDINGS)) {
      const f = nestedGatedBindingFailures('w.jsonc', nested(kind, { binding: 'X', id: 'a' }));
      assert.equal(f.length, 1, `${kind} under env.staging must fail`);
      assert.ok(f[0].includes(`env.staging`));
      assert.ok(f[0].includes(kind));
    }
  });

  it('flags even an empty nested list — presence is the finding', () => {
    const f = nestedGatedBindingFailures('w.jsonc', { env: { production: { hyperdrive: [] } } });
    assert.equal(f.length, 1);
    assert.ok(f[0].includes('env.production'));
  });

  it('is silent when env is absent, not an object, or carries no gated keys', () => {
    for (const cfg of [
      {},
      null,
      { env: 'staging' },
      { env: { staging: { vars: { A: '1' }, d1_databases: [] } } },
    ]) {
      assert.deepEqual(nestedGatedBindingFailures('w.jsonc', cfg), []);
    }
  });

  it('reports one failure per env block per kind', () => {
    const cfg = {
      env: {
        staging: { hyperdrive: [], vpc_networks: [] },
        production: { hyperdrive: [] },
      },
    };
    assert.equal(nestedGatedBindingFailures('w.jsonc', cfg).length, 3);
  });
});

describe('config discovery — no invisible configs', () => {
  const KIT_FLAGS = '{ "workers_dev": false, "preview_urls": false }';
  const EMPTY_ALLOWLIST = '{ "wrangler.jsonc": {}, "wrangler.staging.jsonc": {} }';
  /** A throwaway root holding exactly the named files (nested paths allowed). */
  const rootWith = (files) => {
    const dir = mkdtempSync(join(tmpdir(), 'edge-gate-'));
    for (const [name, text] of Object.entries(files)) {
      mkdirSync(join(dir, dirname(name)), { recursive: true });
      writeFileSync(join(dir, name), text);
    }
    return dir;
  };
  // The seam file ships too: the source-table check fails closed on an unreadable table (that is
  // its job), so a fixture without one would fail every case for the wrong reason. These fixture
  // configs carry no `name`, so they read as a FORK — the empty-table demand stays kit-only.
  const kitShape = (extra = {}) =>
    rootWith({
      'wrangler.jsonc': KIT_FLAGS,
      'wrangler.staging.jsonc': KIT_FLAGS,
      'binding-allowlist.jsonc': EMPTY_ALLOWLIST,
      'src/data/aurora.ts': 'export const AURORA_SOURCES = Object.freeze({});\n',
      ...extra,
    });

  it('lists the real repo: the deploying pair plus the test config, nothing more', () => {
    assert.deepEqual(wranglerConfigsOnDisk(), [
      'wrangler.jsonc',
      'wrangler.staging.jsonc',
      'wrangler.test.jsonc',
    ]);
  });

  it('kit shape passes, extra configs binding nothing gated stay exempt', () => {
    const root = kitShape({ 'wrangler.test.jsonc': '{ "name": "tests" }' });
    assert.deepEqual(checkBindingAllowlist(root), []);
  });

  it('discovers a gated binding in a config outside the canonical pair', () => {
    const root = kitShape({
      'wrangler.mcp.jsonc':
        '{ "hyperdrive": [{ "binding": "ARENA_DB", "id": "405e3f25d52a42c2b675aced4458024e" }] }',
    });
    const f = checkBindingAllowlist(root);
    assert.equal(f.length, 1);
    assert.ok(f[0].startsWith('wrangler.mcp.jsonc:'));
    assert.ok(f[0].includes('no entry in'));
  });

  it('a discovered config with an allowlist entry is held to the full regime', () => {
    const granted =
      '{ "wrangler.jsonc": {}, "wrangler.staging.jsonc": {}, ' +
      '"wrangler.mcp.jsonc": { "hyperdrive": [{ "id": "abc123", "class": "internal" }] } }';
    const bound = '{ "hyperdrive": [{ "binding": "HYPERDRIVE_RET1_RO", "id": "abc123" }] }';
    const okRoot = kitShape({ 'binding-allowlist.jsonc': granted, 'wrangler.mcp.jsonc': bound });
    const f = checkBindingAllowlist(okRoot);
    // The grant matches but the source is unregistered — the cross-check reaches the third
    // config too, which is the point: an entry buys the whole regime, not just the allowlist.
    assert.equal(f.length, 1);
    assert.ok(f[0].includes('AURORA_SOURCES'));
  });

  it('refuses the env-nested binding through the whole entry point', () => {
    const root = kitShape({
      'wrangler.jsonc':
        '{ "workers_dev": false, "preview_urls": false, "env": { "staging": ' +
        '{ "hyperdrive": [{ "binding": "ARENA_DB", "id": "405e3f25" }] } } }',
    });
    const f = checkBindingAllowlist(root);
    assert.equal(f.length, 1);
    assert.ok(f[0].includes('under env.staging'));
  });

  it('the Arena-2 shape — env-nested binding plus a second config — fails on both', () => {
    const root = kitShape({
      'wrangler.jsonc':
        '{ "workers_dev": false, "preview_urls": false, "env": { "staging": ' +
        '{ "hyperdrive": [{ "binding": "ARENA_DB", "id": "405e3f25" }] } } }',
      'wrangler.mcp.jsonc': '{ "hyperdrive": [{ "binding": "ARENA_DB", "id": "405e3f25" }] }',
    });
    const f = checkBindingAllowlist(root);
    assert.equal(f.length, 2);
    assert.ok(f.some((x) => x.includes('under env.staging')));
    assert.ok(f.some((x) => x.startsWith('wrangler.mcp.jsonc:') && x.includes('no entry in')));
  });

  it('refuses a TOML config it cannot inspect', () => {
    const root = kitShape({ 'wrangler.toml': 'name = "app"' });
    const f = checkBindingAllowlist(root);
    assert.equal(f.length, 1);
    assert.ok(f[0].includes('TOML'));
  });

  it('refuses a discovered config that is not a JSONC object', () => {
    // 'null' is indistinguishable from a parse failure (parseJsonc returns null for both), so it
    // gets the established 'not valid JSONC'; an array parses fine and gets the object message.
    for (const [text, message] of [
      ['null', 'not valid JSONC'],
      ['[1, 2]', 'not a JSONC object'],
    ]) {
      const f = checkBindingAllowlist(kitShape({ 'wrangler.mcp.jsonc': text }));
      assert.equal(f.length, 1);
      assert.ok(f[0].includes(message), f[0]);
    }
  });

  // wrangler uploads unsafe.bindings[].type verbatim as first-class binding metadata — a
  // { "type": "hyperdrive" } entry mints a live private-database binding no allowlist reviewed.
  // The KEY's presence is the finding, everywhere.
  it('refuses `unsafe` at the top level, in env blocks, and in discovered configs', () => {
    const unsafeCfg =
      '{ "workers_dev": false, "preview_urls": false, "unsafe": { "bindings": ' +
      '[{ "name": "HYPERDRIVE_C360_RO", "type": "hyperdrive", "id": "405e3f25" }] } }';
    const top = checkBindingAllowlist(kitShape({ 'wrangler.jsonc': unsafeCfg }));
    assert.equal(top.length, 1);
    assert.ok(top[0].includes('"unsafe" is declared'), top[0]);

    const nested = nestedGatedBindingFailures; // silent — unsafe is its own check
    assert.deepEqual(nested('w.jsonc', { env: { staging: { unsafe: {} } } }), []);
    const env = unsafeBindingFailures('w.jsonc', { env: { staging: { unsafe: {} } } });
    assert.equal(env.length, 1);
    assert.ok(env[0].includes('env.staging.unsafe'), env[0]);

    const third = checkBindingAllowlist(kitShape({ 'wrangler.mcp.jsonc': '{ "unsafe": {} }' }));
    assert.equal(third.length, 1);
    assert.ok(third[0].startsWith('wrangler.mcp.jsonc:'), third[0]);
  });

  it('discovery is case-insensitive — Wrangler.mcp.jsonc cannot slip past the glob', () => {
    const root = kitShape({
      'Wrangler.mcp.jsonc': '{ "hyperdrive": [{ "binding": "ARENA_DB", "id": "405e3f25" }] }',
    });
    assert.ok(wranglerConfigsOnDisk(root).includes('Wrangler.mcp.jsonc'));
    const f = checkBindingAllowlist(root);
    assert.equal(f.length, 1);
    assert.ok(f[0].startsWith('Wrangler.mcp.jsonc:') && f[0].includes('no entry in'), f[0]);
  });

  it('tolerates a BOM the way wrangler does', () => {
    const root = kitShape({ 'wrangler.dev.jsonc': `\uFEFF${KIT_FLAGS}` });
    assert.deepEqual(checkBindingAllowlist(root), []);
    assert.deepEqual(checkEdgeHardening(root), []);
  });

  // The local-simulator shape (vitest-pool-workers): a fork tests its data layer by declaring
  // the binding in wrangler.test.jsonc with a localConnectionString and a fake id. Exempt in
  // that ONE file, by name — laundering fake ids into the reviewed allowlist teaches people the
  // allowlist holds fakes. The same entry anywhere else stays fully gated, because a deployed
  // config ignores localConnectionString and honours the id.
  it('exempts local-simulator hyperdrive entries in wrangler.test.jsonc only', () => {
    const sim =
      '{ "hyperdrive": [{ "binding": "HYPERDRIVE_RET1_RO", "id": "fake-local-id", ' +
      '"localConnectionString": "postgres://user:pass@127.0.0.1:5432/db" }] }';
    assert.deepEqual(checkBindingAllowlist(kitShape({ 'wrangler.test.jsonc': sim })), []);
    const elsewhere = checkBindingAllowlist(kitShape({ 'wrangler.mcp.jsonc': sim }));
    assert.equal(elsewhere.length, 1);
    assert.ok(elsewhere[0].includes('no entry in'), elsewhere[0]);
  });

  it('a real (non-simulator) binding in wrangler.test.jsonc is still gated', () => {
    const real = '{ "hyperdrive": [{ "binding": "HYPERDRIVE_RET1_RO", "id": "abc123" }] }';
    const f = checkBindingAllowlist(kitShape({ 'wrangler.test.jsonc': real }));
    assert.equal(f.length, 1);
    assert.ok(f[0].startsWith('wrangler.test.jsonc:') && f[0].includes('no entry in'), f[0]);
  });

  // Finding 5's closure: the edge-hardening flags reach discovered configs too — a second
  // worker deployed from a third config with workers.dev enabled is a second unprotected
  // ingress. wrangler.test.jsonc is exempt by name; TOML is the binding gate's refusal to make.
  it('checkEdgeHardening covers discovered configs, exempting only the test config', () => {
    const bare = '{ "name": "second-worker" }';
    const f = checkEdgeHardening(kitShape({ 'wrangler.mcp.jsonc': bare }));
    assert.equal(f.length, 2);
    assert.ok(f.every((x) => x.startsWith('wrangler.mcp.jsonc:')));
    assert.deepEqual(checkEdgeHardening(kitShape({ 'wrangler.test.jsonc': bare })), []);
    assert.deepEqual(checkEdgeHardening(kitShape({ 'wrangler.toml': 'name = "x"' })), []);
  });

  it('flags an allowlist entry naming a config that is not on disk', () => {
    const root = kitShape({
      'binding-allowlist.jsonc':
        '{ "wrangler.jsonc": {}, "wrangler.staging.jsonc": {}, "wrangler-mcp.jsonc": {} }',
    });
    const f = checkBindingAllowlist(root);
    assert.equal(f.length, 1);
    assert.ok(f[0].includes('does not exist'));
  });

  it('reports a missing wrangler.staging.jsonc as an adoption finding, not breakage', () => {
    const root = rootWith({
      'wrangler.jsonc': KIT_FLAGS,
      'binding-allowlist.jsonc': EMPTY_ALLOWLIST,
    });
    const all = [...checkEdgeHardening(root), ...checkBindingAllowlist(root)];
    const staging = all.filter((x) => x.startsWith('wrangler.staging.jsonc:'));
    assert.ok(staging.length >= 1);
    for (const f of staging) {
      assert.ok(f.includes('a finding, not a broken gate'), f);
      assert.ok(f.includes('Adopting the kit'), f);
      assert.ok(!f.includes('ENOENT'), f);
    }
    // But the allowlist check still refuses the entry for the file that is not there? No — the
    // entry names a config the canonical pair pins as required, so the missing-file failure is
    // the one that speaks; the entry itself stays legal.
    assert.ok(!all.some((x) => x.includes('names a config that does not exist')));
  });

  it('any other read error keeps the plain message', () => {
    assert.equal(
      configReadFailure('wrangler.jsonc', { code: 'EACCES', message: 'EACCES: denied' }),
      'wrangler.jsonc: could not read (EACCES: denied)',
    );
    assert.ok(
      configReadFailure('wrangler.staging.jsonc', { code: 'ENOENT', message: 'gone' }).includes(
        'a finding, not a broken gate',
      ),
    );
  });
});

// Invariant 3 — resource attributability. The bootstrap tripwire catches TEMPLATE
// contamination (a residual template name, the template's own ids); this catches SIBLING
// contamination, where an app is forked from another app, renamed almost everywhere, and left
// naming the sibling's resources. The expensive case is r2: a stale bucket_name silently sends
// this app's nightly D1 dumps into another app's bucket. See DECISIONS 2026-08-18.
describe('resource attributability guard', () => {
  const ok = (over = {}) => ({
    name: 'arena-go',
    vars: { APP_NAME: 'arena-go' },
    d1_databases: [{ binding: 'DB', database_name: 'arena-go-db' }],
    r2_buckets: [{ binding: 'BACKUPS', bucket_name: 'arena-go-backups' }],
    ...over,
  });

  it('passes on the repo wrangler.jsonc + wrangler.staging.jsonc', () => {
    assert.deepEqual(checkResourceNaming(), []);
  });

  it('knows the env suffix each deploying config must carry', () => {
    assert.deepEqual(CONFIG_SUFFIX, { 'wrangler.jsonc': '', 'wrangler.staging.jsonc': '-staging' });
  });

  it('accepts a coherent production config', () => {
    assert.deepEqual(namingFailures('ok.jsonc', ok(), ''), []);
  });

  it('accepts a coherent staging config', () => {
    const cfg = ok({
      name: 'arena-go-staging',
      d1_databases: [{ binding: 'DB', database_name: 'arena-go-db-staging' }],
      r2_buckets: [{ binding: 'BACKUPS', bucket_name: 'arena-go-backups-staging' }],
    });
    assert.deepEqual(namingFailures('ok.jsonc', cfg, '-staging'), []);
  });

  it('FLAGS a bucket belonging to another app — the cross-app backup leak', () => {
    const cfg = ok({
      r2_buckets: [{ binding: 'BACKUPS', bucket_name: 'app-pay-management-backups' }],
    });
    const failures = namingFailures('bad.jsonc', cfg, '');
    assert.equal(failures.length, 1);
    assert.match(failures[0], /app-pay-management-backups/);
    assert.match(failures[0], /not this app's/);
  });

  it('FLAGS a database belonging to another app', () => {
    const cfg = ok({ d1_databases: [{ binding: 'DB', database_name: 'app-pay-management-db' }] });
    const failures = namingFailures('bad.jsonc', cfg, '');
    assert.equal(failures.length, 1);
    assert.match(failures[0], /not this app's/);
  });

  it('flags a half-rename: right app prefix, wrong canonical suffix', () => {
    const cfg = ok({ d1_databases: [{ binding: 'DB', database_name: 'arena-go-db-staging' }] });
    const failures = namingFailures('bad.jsonc', cfg, '');
    assert.equal(failures.length, 1);
    assert.match(failures[0], /expected "arena-go-db"/);
  });

  it('flags a worker name that does not match APP_NAME + suffix', () => {
    const failures = namingFailures('bad.jsonc', ok({ name: 'arena-go-staging' }), '');
    assert.equal(failures.length, 1);
    assert.match(failures[0], /worker "name"/);
  });

  it('flags a config with no APP_NAME, since nothing can be attributed', () => {
    const failures = namingFailures('bad.jsonc', ok({ vars: {} }), '');
    assert.equal(failures.length, 1);
    assert.match(failures[0], /APP_NAME/);
  });

  it('tolerates extra app-owned resources a fork adds (prefix rule, not an exact allowlist)', () => {
    const cfg = ok({
      r2_buckets: [
        { binding: 'BACKUPS', bucket_name: 'arena-go-backups' },
        { binding: 'MEDIA', bucket_name: 'arena-go-media' },
        { binding: 'EXPORTS', bucket_name: 'arena-go-quarterly-exports' },
      ],
    });
    assert.deepEqual(namingFailures('ok.jsonc', cfg, ''), []);
  });

  it('ignores bindings whose name field is absent (wrangler validates shape, not this guard)', () => {
    const cfg = ok({ d1_databases: [{ binding: 'DB', database_id: 'abc' }] });
    assert.deepEqual(namingFailures('ok.jsonc', cfg, ''), []);
  });

  it('flags an unparseable config', () => {
    assert.deepEqual(namingFailures('broken.jsonc', null, ''), ['broken.jsonc: not valid JSONC']);
  });

  // KNOWN LIMIT, pinned so it is visible rather than assumed covered. A prefix rule cannot tell
  // this app's resource from a SIBLING whose name extends it (`arena` vs `arena-go`), except on
  // the two bindings with canonical names. D1 is covered anyway by the app_identity backstop;
  // a non-canonical R2 bucket is the residual exposure. Closing it needs a fleet-wide registry
  // of app names, which the kit does not have locally at CI time.
  it('KNOWN LIMIT: cannot tell a sibling whose name extends this app on a non-canonical binding', () => {
    const cfg = ok({
      r2_buckets: [
        { binding: 'BACKUPS', bucket_name: 'arena-backups' },
        { binding: 'MEDIA', bucket_name: 'arena-go-media' },
      ],
      name: 'arena',
      vars: { APP_NAME: 'arena' },
      d1_databases: [{ binding: 'DB', database_name: 'arena-db' }],
    });
    assert.deepEqual(namingFailures('x.jsonc', cfg, ''), []);
  });

  it('still catches a sibling on a CANONICAL binding, where the exact name applies', () => {
    const cfg = ok({
      name: 'arena',
      vars: { APP_NAME: 'arena' },
      d1_databases: [{ binding: 'DB', database_name: 'arena-go-db' }],
      r2_buckets: [{ binding: 'BACKUPS', bucket_name: 'arena-go-backups' }],
    });
    const failures = namingFailures('x.jsonc', cfg, '');
    assert.equal(failures.length, 2);
    assert.ok(failures.every((f) => /expected "arena-/.test(f)));
  });

  // Discovery — the closure the edge-flag and binding gates already have, found missing here in
  // review. A third root config (`wrangler deploy -c wrangler.mcp.jsonc`) deploys a worker exactly
  // as live as the canonical pair, so a sibling's bucket or database named there leaks just the
  // same; the gate used to read the fixed pair only. Prefix rule alone on discovered configs —
  // their worker name and env suffix are the fork's to choose, so those checks would be false reds.
  describe('covers every root wrangler config, not just the canonical pair', () => {
    const rootWith = (files) => {
      const dir = mkdtempSync(join(tmpdir(), 'naming-gate-'));
      for (const [name, text] of Object.entries(files)) {
        mkdirSync(join(dir, dirname(name)), { recursive: true });
        writeFileSync(join(dir, name), text);
      }
      return dir;
    };
    const appCfg = (name, suffix = '', over = {}) =>
      JSON.stringify({
        name,
        vars: { APP_NAME: 'arena-go' },
        d1_databases: [{ binding: 'DB', database_name: `arena-go-db${suffix}` }],
        r2_buckets: [{ binding: 'BACKUPS', bucket_name: `arena-go-backups${suffix}` }],
        ...over,
      });
    const appShape = (extra = {}) =>
      rootWith({
        'wrangler.jsonc': appCfg('arena-go'),
        'wrangler.staging.jsonc': appCfg('arena-go-staging', '-staging'),
        ...extra,
      });

    it('a coherent pair with no extra configs passes', () => {
      assert.deepEqual(checkResourceNaming(appShape()), []);
    });

    it("FLAGS a sibling's bucket and database in a discovered config — the second-worker leak", () => {
      const f = checkResourceNaming(
        appShape({
          'wrangler.mcp.jsonc': JSON.stringify({
            name: 'arena-go-mcp',
            d1_databases: [{ binding: 'DB', database_name: 'app-pay-management-db' }],
            r2_buckets: [{ binding: 'BACKUPS', bucket_name: 'app-pay-management-backups' }],
          }),
        }),
      );
      assert.equal(f.length, 2);
      assert.ok(
        f.every((x) => x.startsWith('wrangler.mcp.jsonc:') && /not this app's/.test(x)),
        f,
      );
    });

    it('applies ONLY the prefix rule to a discovered config — its worker name and suffixes are its own', () => {
      const f = checkResourceNaming(
        appShape({
          'wrangler.mcp.jsonc': JSON.stringify({
            name: 'arena-go-mcp', // not APP_NAME + a known suffix: fine here
            d1_databases: [{ binding: 'DB', database_name: 'arena-go-db-staging' }], // no canonical
            r2_buckets: [{ binding: 'BACKUPS', bucket_name: 'arena-go-mcp-cache' }],
          }),
        }),
      );
      assert.deepEqual(f, []);
    });

    it("attributes a discovered config against the IDENTITY config's APP_NAME, never its own vars", () => {
      // Forked from a sibling: the third config carries the sibling's APP_NAME AND its bucket.
      // Checked against its own vars this would pass — which is the case the rule exists for.
      const f = checkResourceNaming(
        appShape({
          'wrangler.mcp.jsonc': JSON.stringify({
            vars: { APP_NAME: 'app-pay-management' },
            r2_buckets: [{ binding: 'BACKUPS', bucket_name: 'app-pay-management-backups' }],
          }),
        }),
      );
      assert.equal(f.length, 1);
      assert.match(f[0], /^wrangler\.mcp\.jsonc: .*not this app's \("arena-go"\)/);
    });

    it('exempts wrangler.test.jsonc by name and skips .toml (the binding gate refuses that)', () => {
      const f = checkResourceNaming(
        appShape({
          'wrangler.test.jsonc': JSON.stringify({
            r2_buckets: [{ binding: 'BACKUPS', bucket_name: 'app-pay-management-backups' }],
          }),
          'wrangler.toml': 'name = "x"\n',
        }),
      );
      assert.deepEqual(f, []);
    });

    it('reports a discovered config it cannot attribute when the identity config has no APP_NAME', () => {
      const f = checkResourceNaming(
        rootWith({
          'wrangler.jsonc': '{ "name": "x" }',
          'wrangler.staging.jsonc': '{ "name": "x-staging" }',
          'wrangler.mcp.jsonc': '{ "r2_buckets": [{ "binding": "B", "bucket_name": "whatever" }] }',
        }),
      );
      const mcp = f.filter((x) => x.startsWith('wrangler.mcp.jsonc:'));
      assert.equal(mcp.length, 1);
      assert.match(mcp[0], /cannot attribute/);
      assert.match(mcp[0], /wrangler\.jsonc has no "vars\.APP_NAME"/);
    });

    it('flags an unparseable discovered config rather than skipping it', () => {
      const f = checkResourceNaming(appShape({ 'wrangler.mcp.jsonc': '{ nope' }));
      assert.deepEqual(f, ['wrangler.mcp.jsonc: not valid JSONC']);
    });

    it('discoveredNamingFailures is pure and has no worker-name or canonical check', () => {
      assert.deepEqual(discoveredNamingFailures('m.jsonc', null, 'arena-go'), [
        'm.jsonc: not valid JSONC',
      ]);
      assert.equal(discoveredNamingFailures('m.jsonc', {}, null).length, 1);
      assert.deepEqual(
        discoveredNamingFailures(
          'm.jsonc',
          {
            name: 'anything-at-all',
            d1_databases: [{ binding: 'DB', database_name: 'arena-go-db-staging' }],
          },
          'arena-go',
        ),
        [],
      );
      assert.equal(
        discoveredNamingFailures(
          'm.jsonc',
          { r2_buckets: [{ binding: 'X', bucket_name: 'arena-backups' }] },
          'arena-go',
        ).length,
        1,
      );
    });
  });
});

// The AI configuration gate. The AI client refuses, on EVERY call, a model that cannot take the
// inference_geo pin and a region production does not allow (src/ai/policy.ts). Without the gate a
// fork whose deploying config names claude-haiku-4-5 — a common cheap default tier — or sets
// "global" in production keeps a green CI and then fails every AI call in that environment with a
// 503. These cases pin that the gate reads what the runtime reads, and fails closed.
describe('AI configuration guard', () => {
  const ALLOWED = Object.keys(AI_ALLOWED_MODELS);
  const vars = (v) => ({ workers_dev: false, preview_urls: false, vars: v });

  it('passes on the repo configs', () => {
    assert.deepEqual(checkAiConfig(), []);
  });

  it('accepts every allowed model in both model vars, and a config naming neither', () => {
    for (const model of ALLOWED) {
      for (const key of AI_MODEL_VARS) {
        assert.deepEqual(
          aiConfigFailures('w.jsonc', vars({ [key]: model })),
          [],
          `${key}=${model}`,
        );
      }
    }
    assert.deepEqual(aiConfigFailures('w.jsonc', vars({ APP_ENV: 'production' })), []);
    assert.deepEqual(aiConfigFailures('w.jsonc', { name: 'no-vars' }), []);
  });

  it('refuses a model the client would refuse — Haiku 4.5, a Covered Model, junk — in either var', () => {
    for (const bad of [
      'claude-haiku-4-5',
      'claude-fable-5-1',
      'claude-sonnet-4-5',
      'constructor',
      '',
      7,
      null,
    ]) {
      for (const key of AI_MODEL_VARS) {
        const f = aiConfigFailures('wrangler.jsonc', vars({ [key]: bad }));
        assert.equal(f.length, 1, `${key}=${JSON.stringify(bad)}`);
        assert.ok(f[0].startsWith(`wrangler.jsonc: vars.${key} is `), f[0]);
        assert.ok(f[0].includes('ai_model_not_allowed'), f[0]);
      }
    }
  });

  it('refuses "global" in production and junk anywhere; allows unset, "us", and "global" elsewhere', () => {
    const geo = (value, appEnv) =>
      aiConfigFailures('w.jsonc', vars({ APP_ENV: appEnv, AI_INFERENCE_GEO: value }));
    for (const ok of ['', 'us']) assert.deepEqual(geo(ok, 'production'), [], JSON.stringify(ok));
    assert.deepEqual(geo('global', 'staging'), []);
    const prod = geo('global', 'production');
    assert.equal(prod.length, 1);
    assert.ok(prod[0].includes('"global" with APP_ENV "production"'), prod[0]);
    for (const bad of ['US', ' us', 'eu', 'any', 1]) {
      const f = geo(bad, 'staging');
      assert.equal(f.length, 1, JSON.stringify(bad));
      assert.ok(f[0].includes('ai_unconfigured'), f[0]);
    }
  });

  it('checks every env block on its own — wrangler does not inherit vars', () => {
    const f = aiConfigFailures('wrangler.jsonc', {
      vars: {
        APP_ENV: 'staging',
        AI_DEFAULT_MODEL: 'claude-sonnet-4-6',
        AI_INFERENCE_GEO: 'global',
      },
      env: {
        production: { vars: { APP_ENV: 'production', AI_INFERENCE_GEO: 'global' } },
        cheap: { vars: { AI_LARGE_MODEL: 'claude-haiku-4-5' } },
        bare: {},
      },
    });
    assert.equal(f.length, 2, f.join('\n'));
    assert.ok(f.some((x) => x.includes('env.production.vars.AI_INFERENCE_GEO')));
    assert.ok(f.some((x) => x.includes('env.cheap.vars.AI_LARGE_MODEL')));
  });

  it('reads every deploying config on disk, exempting only the test config', () => {
    const rootWith = (files) => {
      const dir = mkdtempSync(join(tmpdir(), 'ai-gate-'));
      for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
      return dir;
    };
    const good = JSON.stringify(
      vars({ APP_ENV: 'production', AI_DEFAULT_MODEL: 'claude-sonnet-4-6' }),
    );
    const haiku = JSON.stringify(vars({ AI_DEFAULT_MODEL: 'claude-haiku-4-5' }));
    const pair = { 'wrangler.jsonc': good, 'wrangler.staging.jsonc': good };
    assert.deepEqual(checkAiConfig(rootWith(pair)), []);
    const second = checkAiConfig(rootWith({ ...pair, 'wrangler.mcp.jsonc': haiku }));
    assert.equal(second.length, 1);
    assert.ok(second[0].startsWith('wrangler.mcp.jsonc:'), second[0]);
    assert.deepEqual(checkAiConfig(rootWith({ ...pair, 'wrangler.test.jsonc': haiku })), []);
    const missing = checkAiConfig(rootWith({ 'wrangler.jsonc': good }));
    assert.equal(missing.length, 1);
    assert.ok(missing[0].startsWith('wrangler.staging.jsonc: missing'), missing[0]);
  });

  // One definition: the gate imports the allowlist and the region rule, and restates neither. A
  // model id typed into the gate is a second list that agrees with the runtime only until one of
  // them changes.
  it('imports the vocabulary the runtime reads, and names no model itself', () => {
    const read = (rel) => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');
    const gate = read('scripts/check-edge-hardening.mjs');
    assert.match(gate, /import\s*\{[^}]*\}\s*from\s*'[^']*src\/ai\/policyVocabulary\.mjs'/);
    assert.doesNotMatch(gate, /['"`]claude-/);
    assert.match(read('src/ai/policy.ts'), /from\s*'\.\/policyVocabulary\.mjs'/);
    // …and the vocabulary loads on its own under plain node: it imports nothing.
    const vocabulary = read('src/ai/policyVocabulary.mjs');
    assert.doesNotMatch(vocabulary, /^\s*import\s/m);
    assert.doesNotMatch(vocabulary, /\bfrom\s*['"`]/);
    assert.doesNotMatch(vocabulary, /\bimport\s*\(/);
    assert.doesNotMatch(vocabulary, /\brequire\s*\(/);
  });
});

// Dormant today — no kit config sets AGENT_ENABLED — so every case is synthetic. The point is that
// the FIRST config to arm the agent cannot do so without the controls the PIA makes conditions of
// arming, and that the message names the exact block and key.
describe('agent arming — the controls travel with the flag (PIA C1, C2, C6, C9)', () => {
  // A synthetic arming record: identifier-shaped, citing nothing real.
  const RECORD = 'SEC-1';
  const armed = (extra = {}) => ({
    APP_ENV: 'production',
    [AGENT_ENABLED_VAR]: 'on',
    [READ_AUDIT_VAR]: READ_AUDIT_ARMED,
    [AGENT_RETENTION_VAR]: '30',
    [AGENT_ARMING_RECORD_VAR]: RECORD,
    ...extra,
  });
  const wf = (default_retention, over = {}) => ({
    binding: AGENT_RUN_BINDING,
    name: 'acme-agent-run',
    class_name: AGENT_RUN_CLASS,
    ...(default_retention === undefined ? {} : { default_retention }),
    ...over,
  });
  const within = { success_retention: '7 days', error_retention: '30 days' };
  const reaper = { crons: ['0 3 * * *', AGENT_REAPER_CRON] };
  /** A block carrying every control — the shape the first config to arm an agent must have. */
  const block = (extra = {}) => ({
    vars: armed(),
    triggers: reaper,
    workflows: [wf(within)],
    ...extra,
  });
  // The rungs P2-9 (staging) and P2-11 (production) will open. Most cases below are about the
  // controls, so they run with the ladder open and as if wrangler deploys `default_retention`; the
  // cases about the ladder and the toolchain pass their own answer, and the defaults (none given)
  // are the real ladder and the fail-closed toolchain answer.
  const OPEN_LADDER = ['production', 'staging'];
  const DEPLOYS = { retention: { ok: true }, armableEnvs: OPEN_LADDER };
  const arming = (label, cfg, context = DEPLOYS) => agentArmingFailures(label, cfg, context);

  it('is dormant on the repo configs: both ship AGENT_ENABLED "off", and nothing arms', () => {
    // …and the kit's own deploy commands pass only APP_BUILD_VERSION with --var.
    assert.deepEqual(checkAgentArming(), []);
    for (const file of DEPLOYING_CONFIGS) {
      const cfg = parseJsonc(readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8'));
      assert.equal(cfg.vars?.[AGENT_ENABLED_VAR], 'off', `${file} ships the agent off`);
    }
  });

  it('passes a fully armed block, and ignores a block that is off or silent', () => {
    assert.deepEqual(arming('w.jsonc', block()), []);
    assert.deepEqual(arming('wrangler.jsonc', block()), []);
    const staging = block({ vars: armed({ APP_ENV: 'staging' }) });
    assert.deepEqual(arming('wrangler.staging.jsonc', staging), []);
    assert.deepEqual(arming('w.jsonc', { vars: { [AGENT_ENABLED_VAR]: 'off' } }), []);
    assert.deepEqual(arming('w.jsonc', { vars: {} }), []);
    assert.deepEqual(arming('w.jsonc', {}), []);
    assert.deepEqual(arming('w.jsonc', null), []);
  });

  it('refuses a value that is neither exactly "on" nor "off"', () => {
    for (const value of ['ON', ' on', 'true', '1', true, 1, '', null]) {
      const f = arming('w.jsonc', { vars: armed({ [AGENT_ENABLED_VAR]: value }) });
      assert.equal(f.length, 1, JSON.stringify(value));
      assert.match(f[0], /must be exactly "on" or "off"/);
    }
  });

  it('requires the read ledger armed, with exactly the shared vocabulary', () => {
    for (const value of [undefined, 'off', 'ON', 'true']) {
      const f = arming('w.jsonc', block({ vars: armed({ [READ_AUDIT_VAR]: value }) }));
      assert.equal(f.length, 1, JSON.stringify(value));
      assert.match(f[0], /^w\.jsonc: vars sets AGENT_ENABLED "on" without "READ_AUDIT": "on"/);
      assert.match(f[0], /PIA C2/);
    }
  });

  it('requires an explicit transcript retention, a positive whole number of days', () => {
    for (const value of [undefined, '', '0', '-1', '30.5', ' 30', '030', 30, 'thirty']) {
      const f = arming('w.jsonc', block({ vars: armed({ [AGENT_RETENTION_VAR]: value }) }));
      assert.equal(f.length, 1, JSON.stringify(value));
      assert.match(f[0], new RegExp(`without a valid ${AGENT_RETENTION_VAR}`));
      assert.match(f[0], /PIA C1/);
    }
    assert.equal(positiveDays('1'), 1);
    assert.equal(positiveDays('365'), 365);
  });

  describe('the environment ladder and the APP_ENV pin (privacy must-fixes 13, 14)', () => {
    it('with the REAL ladder, a fully armed block fails on the ladder alone, in every config', () => {
      // The static half of dormancy: test + development only, so no deploying config can arm
      // until P2-9 (staging) and P2-11 (production) add their rungs to AGENT_ARMABLE_ENVS.
      assert.deepEqual([...AGENT_ARMABLE_ENVS], ['test', 'development']);
      const real = { retention: { ok: true } };
      const cases = [
        ['wrangler.jsonc', block(), 'production'],
        ['wrangler.staging.jsonc', block({ vars: armed({ APP_ENV: 'staging' }) }), 'staging'],
        ['wrangler.mcp.jsonc', block({ vars: armed({ APP_ENV: 'staging' }) }), 'production'],
      ];
      for (const [label, cfg, judged] of cases) {
        const f = agentArmingFailures(label, cfg, real);
        assert.equal(f.length, 1, `${label}\n${f.join('\n')}`);
        assert.match(
          f[0],
          new RegExp(
            `^${label.replaceAll('.', '\\.')}: vars sets AGENT_ENABLED "on", but it deploys ${judged}`,
          ),
        );
        assert.match(f[0], /not on the agent's environment ladder \[test, development\]/);
        assert.match(f[0], /P2-9/);
        assert.match(f[0], /P2-11/);
      }
    });

    it('refuses an armed deploying block whose APP_ENV is test, development, or anything else', () => {
      for (const value of ['development', 'test', undefined, '', 'prod', 'Production']) {
        const f = arming('w.jsonc', block({ vars: armed({ APP_ENV: value }) }));
        assert.equal(f.length, 1, `${JSON.stringify(value)}\n${f.join('\n')}`);
        assert.match(f[0], /must say exactly "staging" or "production"/);
      }
      // …even with a ladder that admits them: the pin is not the ladder.
      const permissive = { ...DEPLOYS, armableEnvs: ['test', 'development', ...OPEN_LADDER] };
      const dev = arming('w.jsonc', block({ vars: armed({ APP_ENV: 'development' }) }), permissive);
      assert.equal(dev.length, 1, dev.join('\n'));
    });

    it('holds the canonical pair to the environment each deploys', () => {
      const prodAsStaging = arming(
        'wrangler.jsonc',
        block({ vars: armed({ APP_ENV: 'staging' }) }),
      );
      assert.equal(prodAsStaging.length, 1, prodAsStaging.join('\n'));
      assert.match(
        prodAsStaging[0],
        /^wrangler\.jsonc: vars sets AGENT_ENABLED "on" with APP_ENV "staging", but wrangler\.jsonc deploys production: its top level must say "production"/,
      );
      const stagingAsProd = arming('wrangler.staging.jsonc', block());
      assert.equal(stagingAsProd.length, 1, stagingAsProd.join('\n'));
      assert.match(stagingAsProd[0], /wrangler\.staging\.jsonc deploys staging: .* say "staging"/);
    });

    it('judges a discovered config, and every env block, as production', () => {
      // Only staging open (P2-9's ladder, before P2-11): the staging config's top level arms…
      const stagingOnly = { ...DEPLOYS, armableEnvs: ['staging'] };
      const staging = block({ vars: armed({ APP_ENV: 'staging' }) });
      assert.deepEqual(arming('wrangler.staging.jsonc', staging, stagingOnly), []);
      // …but the same block in a third config deploys a Worker the gate cannot place.
      const mcp = arming('wrangler.mcp.jsonc', staging, stagingOnly);
      assert.equal(mcp.length, 1, mcp.join('\n'));
      assert.match(mcp[0], /deploys production \(every block but the top level of wrangler\.jsonc/);
      // So does an env block, even inside the staging config.
      const nested = arming(
        'wrangler.staging.jsonc',
        { name: 'acme-staging', vars: { APP_ENV: 'staging' }, env: { preview: staging } },
        stagingOnly,
      );
      assert.equal(nested.length, 1, nested.join('\n'));
      assert.match(
        nested[0],
        /^wrangler\.staging\.jsonc: env\.preview\.vars sets .* deploys production/,
      );
    });
  });

  it('requires an identifier-shaped arming record', () => {
    for (const value of [
      undefined,
      '',
      'abc-1',
      'ABC-0',
      'ABC-1 ',
      'ABCDEFGHIJK-1',
      'ABC-12345678',
      'ABC_1',
    ]) {
      const f = arming('w.jsonc', block({ vars: armed({ [AGENT_ARMING_RECORD_VAR]: value }) }));
      assert.equal(f.length, 1, `${JSON.stringify(value)}\n${f.join('\n')}`);
      assert.match(f[0], new RegExp(`without a valid ${AGENT_ARMING_RECORD_VAR}`));
    }
    for (const value of ['A-1', 'AICOE-668', 'ABCDEFGHIJ-1234567']) {
      const cfg = block({ vars: armed({ [AGENT_ARMING_RECORD_VAR]: value }) });
      assert.deepEqual(arming('w.jsonc', cfg), [], value);
    }
  });

  it('pins inference to "us": absent or "us" only, even in staging (PIA C6)', () => {
    for (const value of ['global', 'GLOBAL', 'eu', ' us']) {
      for (const appEnv of ['production', 'staging']) {
        const vars = armed({ APP_ENV: appEnv, AI_INFERENCE_GEO: value });
        const f = arming('w.jsonc', block({ vars }));
        assert.equal(f.length, 1, `${value}/${appEnv}\n${f.join('\n')}`);
        assert.match(f[0], /pins inference to "us"/);
        assert.match(f[0], /PIA C6/);
      }
    }
    // The one region rule the AI client and the runtime predicate share: unset and "" read as "us".
    for (const value of [undefined, '', 'us']) {
      const cfg = block({ vars: armed({ AI_INFERENCE_GEO: value }) });
      assert.deepEqual(arming('w.jsonc', cfg), [], JSON.stringify(value));
    }
  });

  it('requires the reaper cron in the block’s effective triggers', () => {
    for (const triggers of [
      undefined,
      {},
      { crons: [] },
      { crons: ['0 3 * * *'] },
      { crons: '*/5 * * * *' },
    ]) {
      const cfg = block({ triggers });
      if (triggers === undefined) delete cfg.triggers;
      const f = arming('w.jsonc', cfg);
      assert.equal(f.length, 1, `${JSON.stringify(triggers)}\n${f.join('\n')}`);
      assert.match(f[0], /without the reaper's cron "\*\/5 \* \* \* \*" in its triggers\.crons/);
    }
    // `triggers` IS inherited by an env block: the top level's reaper cron covers it…
    const inherits = {
      name: 'acme',
      triggers: reaper,
      env: { blue: { ...block(), triggers: undefined } },
    };
    delete inherits.env.blue.triggers;
    assert.deepEqual(arming('w.jsonc', inherits), []);
    // …unless the env block declares triggers of its own without it.
    const overrides = {
      name: 'acme',
      triggers: reaper,
      env: { blue: block({ triggers: { crons: [] } }) },
    };
    const f = arming('w.jsonc', overrides);
    assert.equal(f.length, 1, f.join('\n'));
    assert.match(f[0], /^w\.jsonc: env\.blue\.vars sets .* reaper's cron/);
  });

  it('requires the AGENT_RUN turn engine, defined in this Worker with its own class', () => {
    const none = arming('w.jsonc', block({ workflows: [] }));
    assert.equal(none.length, 1, none.join('\n'));
    assert.match(
      none[0],
      /without its turn engine: a "workflows" entry \{ "binding": "AGENT_RUN", "class_name": "AgentRunWorkflow" \}/,
    );
    const other = arming(
      'w.jsonc',
      block({ workflows: [wf(within, { binding: 'INGEST', name: 'acme-ingest' })] }),
    );
    assert.equal(other.length, 1, other.join('\n'));
    assert.match(other[0], /without its turn engine/);
    // `script_name` — even naming this Worker — cannot carry default_retention, so it is refused.
    for (const script_name of ['acme-mcp', 'acme']) {
      const cfg = { name: 'acme', ...block({ workflows: [wf(within, { script_name })] }) };
      const f = arming('w.jsonc', cfg).filter((x) => /script_name/.test(x));
      assert.equal(f.length, 1, script_name);
      assert.match(f[0], /binds AGENT_RUN with "script_name" .* must be defined in this Worker/);
    }
    const wrongClass = arming(
      'w.jsonc',
      block({ workflows: [wf(within, { class_name: 'AgentRun' })] }),
    );
    assert.equal(wrongClass.length, 1, wrongClass.join('\n'));
    assert.match(
      wrongClass[0],
      /AGENT_RUN has "class_name" "AgentRun", expected "AgentRunWorkflow"/,
    );
  });

  it('requires default_retention on every Workflow binding, no longer than the transcripts', () => {
    const none = arming('w.jsonc', block({ workflows: [wf(undefined)] }));
    assert.equal(none.length, 1);
    assert.match(none[0], /workflows "AGENT_RUN" has no "default_retention"/);
    assert.match(none[0], /\(30 days\)/);

    const half = arming('w.jsonc', block({ workflows: [wf({ success_retention: '1 day' })] }));
    assert.equal(half.length, 1);
    assert.match(half[0], /default_retention\.error_retention is undefined/);

    const long = arming(
      'w.jsonc',
      block({ workflows: [wf({ success_retention: '31 days', error_retention: '5 weeks' })] }),
    );
    assert.equal(long.length, 2, long.join('\n'));
    assert.match(long[0], /success_retention "31 days" outlives AGENT_TRANSCRIPT_RETENTION_DAYS/);
    assert.match(long[1], /error_retention "5 weeks" outlives/);

    // Every Workflow binding in the block, not only the agent's own.
    const two = arming(
      'w.jsonc',
      block({ workflows: [wf(within), wf(undefined, { binding: 'INGEST', name: 'acme-ingest' })] }),
    );
    assert.equal(two.length, 1);
    assert.match(two[0], /workflows "INGEST"/);
  });

  it('reads Workflows durations the way Workflows does, rounding months and years up', () => {
    assert.equal(workflowDurationDays('3 days'), 3);
    assert.equal(workflowDurationDays('1 day'), 1);
    assert.equal(workflowDurationDays('2 weeks'), 14);
    assert.equal(workflowDurationDays('12 hours'), 0.5);
    assert.equal(workflowDurationDays('1 month'), 31);
    assert.equal(workflowDurationDays('1 year'), 366);
    assert.equal(workflowDurationDays(86_400_000), 1);
    for (const bad of ['3', 'days', '3days', '0 days', '-1 day', '1 fortnight', 1.5, 0, null]) {
      assert.equal(workflowDurationDays(bad), null, JSON.stringify(bad));
    }
    // A month is never read as shorter than 31 days, so "1 month" against 30 fails.
    const f = arming(
      'w.jsonc',
      block({ workflows: [wf({ success_retention: '1 month', error_retention: '1 day' })] }),
    );
    assert.equal(f.length, 1);
    assert.match(f[0], /"1 month" outlives/);
  });

  it('requires a declared vault retention when VAULT is bound', () => {
    const vault = { r2_buckets: [{ binding: 'BACKUPS' }, { binding: 'VAULT' }] };
    const f = arming('w.jsonc', block(vault));
    assert.equal(f.length, 1);
    assert.match(f[0], new RegExp(`binds VAULT without a valid ${VAULT_RETENTION_VAR}`));
    assert.deepEqual(
      arming('w.jsonc', block({ vars: armed({ [VAULT_RETENTION_VAR]: '37' }), ...vault })),
      [],
    );
    // Without VAULT, no vault retention is asked for.
    assert.deepEqual(arming('w.jsonc', block({ r2_buckets: [{ binding: 'BACKUPS' }] })), []);
  });

  it('judges each env block on its own vars, workflows and buckets (none are inherited)', () => {
    const f = arming('wrangler.jsonc', {
      // The top level is fully armed — and an env block does not inherit its vars or workflows
      // (its triggers it does, so the reaper cron is not among the misses).
      ...block(),
      env: {
        staging: { vars: { [AGENT_ENABLED_VAR]: 'on' } },
        quiet: { vars: { [READ_AUDIT_VAR]: READ_AUDIT_ARMED } },
        bare: {},
      },
    });
    // APP_ENV, the record, READ_AUDIT, the retention and the turn engine — five, all env.staging.
    assert.equal(f.length, 5, f.join('\n'));
    assert.ok(f.every((x) => x.startsWith('wrangler.jsonc: env.staging.vars sets')));
  });

  it('refuses the flag declared as a secret, which no reviewer and no gate can see', () => {
    const f = arming('w.jsonc', {
      secrets: { required: ['ANTHROPIC_API_KEY', AGENT_ENABLED_VAR] },
      env: { staging: { secrets: { required: [AGENT_ENABLED_VAR] } } },
    });
    assert.equal(f.length, 2);
    assert.match(f[0], /^w\.jsonc: secrets\.required lists AGENT_ENABLED/);
    assert.match(f[1], /^w\.jsonc: env\.staging\.secrets\.required lists AGENT_ENABLED/);
  });

  it('reports every missing control at once, in one pass', () => {
    const bare = {
      vars: { [AGENT_ENABLED_VAR]: 'on' },
      workflows: [wf(undefined)],
      r2_buckets: [{ binding: 'VAULT' }],
    };
    const f = arming('w.jsonc', bare);
    // APP_ENV, record, READ_AUDIT, retention, reaper cron, default_retention, vault.
    assert.equal(f.length, 7, f.join('\n'));
    // With the real ladder the eighth: production is not on it.
    assert.equal(agentArmingFailures('w.jsonc', bare, { retention: { ok: true } }).length, 8);
  });

  it('fails closed while the installed wrangler cannot deploy default_retention', () => {
    // wrangler 4.124 validates `default_retention` with a warning only and leaves it out of the
    // Workflow it uploads, so a config carrying it would pass here and keep instances for the
    // account default. The gate certifies C9 only when the toolchain can apply the field.
    const cfg = block();
    const drops = { ok: false, why: 'WHY-IT-CANNOT' };
    const f = agentArmingFailures('w.jsonc', cfg, { retention: drops, armableEnvs: OPEN_LADDER });
    assert.equal(f.length, 1, f.join('\n'));
    assert.match(
      f[0],
      /^w\.jsonc: vars sets AGENT_ENABLED "on" and binds Workflows, but WHY-IT-CANNOT/,
    );
    assert.match(f[0], /upgrade wrangler/);
    assert.match(f[0], /PIA C9/);
    // No answer at all is the same refusal, not a pass.
    const unchecked = agentArmingFailures('w.jsonc', cfg, { armableEnvs: OPEN_LADDER });
    assert.equal(unchecked.length, 1, unchecked.join('\n'));
    assert.match(unchecked[0], /binds Workflows, but/);
    // An armed block always binds AGENT_RUN now; without it, it fails for that, not the toolchain.
    const engineless = agentArmingFailures('w.jsonc', block({ workflows: [] }), {
      retention: drops,
      armableEnvs: OPEN_LADDER,
    });
    assert.equal(engineless.length, 1, engineless.join('\n'));
    assert.match(engineless[0], /without its turn engine/);
  });

  it('reads the toolchain’s answer from wrangler’s own config schema', () => {
    const schema = (props) =>
      JSON.stringify({ definitions: { WorkflowBinding: { properties: props } } });
    assert.deepEqual(workflowRetentionSupport(schema({ name: {}, default_retention: {} })), {
      ok: true,
    });
    const without = workflowRetentionSupport(schema({ name: {}, limits: {} }));
    assert.equal(without.ok, false);
    assert.match(without.why, /WorkflowBinding has no "default_retention"/);
    assert.equal(workflowRetentionSupport(JSON.stringify({ definitions: {} })).ok, false);
    assert.equal(workflowRetentionSupport('{ not json').ok, false);
    // A root with no installed wrangler cannot answer, so an armed block with Workflows fails.
    const dir = mkdtempSync(join(tmpdir(), 'agent-gate-'));
    writeFileSync(join(dir, 'wrangler.jsonc'), JSON.stringify(block()));
    writeFileSync(join(dir, 'wrangler.staging.jsonc'), JSON.stringify({ vars: {} }));
    const f = checkAgentArming(dir, { armableEnvs: OPEN_LADDER });
    assert.equal(f.length, 1, f.join('\n'));
    assert.match(f[0], /could not read node_modules\/wrangler\/config-schema\.json/);
    // …and with a schema that declares the field, the same config passes.
    mkdirSync(join(dir, 'node_modules', 'wrangler'), { recursive: true });
    writeFileSync(
      join(dir, 'node_modules', 'wrangler', 'config-schema.json'),
      schema({ default_retention: {} }),
    );
    assert.deepEqual(checkAgentArming(dir, { armableEnvs: OPEN_LADDER }), []);
    // The CLI's own call passes no ladder: the same root fails on the real one.
    const real = checkAgentArming(dir);
    assert.equal(real.length, 1, real.join('\n'));
    assert.match(
      real[0],
      /^wrangler\.jsonc: vars sets AGENT_ENABLED "on", but it deploys production/,
    );
  });

  it('holds an external Workflow to the retention of the Worker that defines it', () => {
    // A binding with `script_name` points at a Workflow another Worker defines. wrangler uploads
    // nothing for it from this config (limits and schedules there are errors: "Configure … on the
    // worker that defines the workflow"), so a `default_retention` here is inert — the one that
    // counts is on the definition, in the other Worker's config. (AGENT_RUN itself may never be
    // external — the case above — so the external binding here is another of the app's.)
    const ingest = { binding: 'INGEST', name: 'acme-ingest', class_name: 'Ingest' };
    const external = { ...ingest, script_name: 'acme-mcp' };
    const definer = (default_retention) => ({
      name: 'acme-mcp',
      vars: {},
      workflows: [{ ...ingest, ...(default_retention ? { default_retention } : {}) }],
    });
    const root = (definition) => {
      const dir = mkdtempSync(join(tmpdir(), 'agent-gate-'));
      const armedCfg = { name: 'acme', ...block({ workflows: [wf(within), external] }) };
      writeFileSync(join(dir, 'wrangler.jsonc'), JSON.stringify(armedCfg));
      writeFileSync(join(dir, 'wrangler.staging.jsonc'), JSON.stringify({ vars: {} }));
      if (definition) writeFileSync(join(dir, 'wrangler.mcp.jsonc'), JSON.stringify(definition));
      mkdirSync(join(dir, 'node_modules', 'wrangler'), { recursive: true });
      writeFileSync(
        join(dir, 'node_modules', 'wrangler', 'config-schema.json'),
        JSON.stringify({
          definitions: { WorkflowBinding: { properties: { default_retention: {} } } },
        }),
      );
      return dir;
    };
    const check = (dir) => checkAgentArming(dir, { armableEnvs: OPEN_LADDER });

    // The definition carries none: the armed side's own value does not stand in for it.
    const bare = check(root(definer(undefined)));
    assert.equal(bare.length, 1, bare.join('\n'));
    assert.match(
      bare[0],
      /^wrangler\.jsonc: vars sets AGENT_ENABLED "on" but workflows "INGEST" \(defined in wrangler\.mcp\.jsonc: workflows\) has no "default_retention"/,
    );
    // The definition carries one no longer than the ARMED block's transcript retention: passes.
    assert.deepEqual(check(root(definer(within))), []);
    const long = check(root(definer({ ...within, error_retention: '60 days' })));
    assert.equal(long.length, 1, long.join('\n'));
    assert.match(
      long[0],
      /error_retention "60 days" outlives AGENT_TRANSCRIPT_RETENTION_DAYS \(30/,
    );

    // No deploying config here defines it: the gate cannot see its retention, so it refuses.
    const unseen = check(root(null));
    assert.equal(unseen.length, 1, unseen.join('\n'));
    assert.match(unseen[0], /is defined in Worker "acme-mcp", and no deploying config/);

    // A script_name naming the block's OWN Worker is a local definition, checked in place.
    const own = {
      name: 'acme',
      ...block({
        workflows: [wf(within), { ...ingest, script_name: 'acme', default_retention: within }],
      }),
    };
    assert.deepEqual(arming('w.jsonc', own), []);
  });

  it('refuses a deploy command that sets an arming var with wrangler --var', () => {
    // `--var NAME:value` replaces the config's value at deploy time, so it arms (or disarms a
    // control, or moves an armed block past the ladder, record or region pin) where no config
    // review and no check above can see it.
    const cases = [
      ['wrangler deploy --var AGENT_ENABLED:on', 'AGENT_ENABLED'],
      ['wrangler deploy --var=READ_AUDIT:off', 'READ_AUDIT'],
      ['wrangler deploy --var APP_BUILD_VERSION:x AGENT_TRANSCRIPT_RETENTION_DAYS:3650', 'AGENT_'],
      ['npx wrangler versions upload --var VAULT_RETENTION_DAYS:9999', 'VAULT_RETENTION_DAYS'],
      ['wrangler deploy --var APP_ENV:development', 'APP_ENV'],
      ['wrangler deploy --var AGENT_ARMING_RECORD:SEC-1', 'AGENT_ARMING_RECORD'],
      ['wrangler deploy --var AI_INFERENCE_GEO:global', 'AI_INFERENCE_GEO'],
    ];
    for (const [cmd, name] of cases) {
      const f = cliVarOverrideFailures([['package.json scripts.deploy', cmd]]);
      assert.equal(f.length, 1, cmd);
      assert.match(f[0], new RegExp(`^package\\.json scripts\\.deploy passes ${name}`));
      assert.match(f[0], /wrangler --var/);
    }
    for (const cmd of [
      // The kit's own deploy scripts: a build stamp, nothing the gate reads.
      'npm run build:web && wrangler deploy --var APP_BUILD_VERSION:$(git rev-parse --short HEAD)',
      // A step env entry is not a Worker var (and carries no --var).
      'READ_AUDIT: on',
      'APP_ENV: staging',
      // A longer name that merely ends in one of them.
      'wrangler deploy --var MY_READ_AUDIT:off',
      'wrangler deploy --var MY_APP_ENV:x',
      'wrangler deploy',
    ]) {
      assert.deepEqual(cliVarOverrideFailures([['x', cmd]]), [], cmd);
    }
    for (const name of ['APP_ENV', AGENT_ARMING_RECORD_VAR, 'AI_INFERENCE_GEO']) {
      assert.ok(ARMING_VARS.includes(name), name);
    }
  });

  it('reads package.json scripts and every workflow command, continuations joined', () => {
    assert.deepEqual(
      commandLines('a: 1\n  run: wrangler deploy \\\n    --var AGENT_ENABLED:on\nb: 2\n'),
      [
        [1, 'a: 1'],
        [2, '  run: wrangler deploy     --var AGENT_ENABLED:on'],
        [4, 'b: 2'],
        [5, ''],
      ],
    );
    const dir = mkdtempSync(join(tmpdir(), 'agent-gate-'));
    writeFileSync(join(dir, 'wrangler.jsonc'), JSON.stringify({ vars: {} }));
    writeFileSync(join(dir, 'wrangler.staging.jsonc'), JSON.stringify({ vars: {} }));
    assert.deepEqual(
      checkAgentArming(dir),
      [],
      'no package.json and no workflows: nothing to scan',
    );
    const pkg = { scripts: { deploy: 'wrangler deploy --var AGENT_ENABLED:on' } };
    writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg));
    mkdirSync(join(dir, '.github', 'workflows'), { recursive: true });
    writeFileSync(
      join(dir, '.github', 'workflows', 'ship.yml'),
      'jobs:\n  x:\n    steps:\n      - run: npx wrangler deploy \\\n          --var READ_AUDIT:off\n',
    );
    const f = checkAgentArming(dir);
    assert.equal(f.length, 2, f.join('\n'));
    assert.match(f[0], /^package\.json scripts\.deploy passes AGENT_ENABLED/);
    assert.match(f[1], /^\.github\/workflows\/ship\.yml:4 passes READ_AUDIT/);
    writeFileSync(join(dir, 'package.json'), '{ not json');
    assert.match(checkAgentArming(dir)[0], /^package\.json: could not read/);
  });

  // Dormant means no config fails, so nothing would notice this check being unwired from the CLI:
  // every test above calls it directly. Every exported check* guard must be RUN by main(), and its
  // failures must be acted on — read off the source, as the vocabulary-import pin above is. The
  // call must also pass NO arguments: `checkAgentArming(root, { armableEnvs })` is a test seam, and
  // a CLI that passed it would open the ladder for every config.
  it('every exported check* guard runs in main(), and its failures are acted on', async () => {
    const gate = await import('../../scripts/check-edge-hardening.mjs');
    const source = readFileSync(
      new URL('../../scripts/check-edge-hardening.mjs', import.meta.url),
      'utf8',
    );
    const start = source.indexOf('\nfunction main() {\n');
    assert.ok(start > 0, 'main() is where the CLI runs the guards');
    const body = source.slice(start, source.indexOf('\n}\n', start));
    const guards = Object.keys(gate).filter(
      (k) => /^check[A-Z]/.test(k) && typeof gate[k] === 'function',
    );
    assert.ok(guards.includes('checkAgentArming'), guards.join(', '));
    for (const name of guards) {
      const wired = new RegExp(`const (\\w+) = ${name}\\(\\);\\s*if \\(\\1\\.length\\)`);
      assert.match(body, wired, `${name} is not run (and acted on) by main()`);
    }
  });

  it('reads every deploying config on disk, exempting only the test config', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-gate-'));
    const quiet = JSON.stringify({ vars: {} });
    const bare = JSON.stringify({ vars: { [AGENT_ENABLED_VAR]: 'on' } });
    writeFileSync(join(dir, 'wrangler.jsonc'), quiet);
    writeFileSync(join(dir, 'wrangler.staging.jsonc'), quiet);
    writeFileSync(join(dir, 'wrangler.test.jsonc'), bare);
    assert.deepEqual(checkAgentArming(dir), []);
    writeFileSync(join(dir, 'wrangler.mcp.jsonc'), bare);
    const f = checkAgentArming(dir);
    // APP_ENV, the ladder, the record, READ_AUDIT, the retention, the reaper cron, the engine.
    assert.equal(f.length, 7, f.join('\n'));
    assert.ok(f.every((x) => x.startsWith('wrangler.mcp.jsonc: vars sets')));
  });
});

describe('agent arming vocabulary — one definition, not two', () => {
  const VOCABULARY = 'src/ai/agentVocabulary.mjs';
  // The static gate and the runtime predicate. Both must IMPORT the vocabulary; nothing in src/ or
  // scripts/ may declare its names again.
  const CONSUMERS = ['scripts/check-edge-hardening.mjs', 'src/ai/agentArming.ts'];
  const read = (rel) => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');
  const treeFiles = () => {
    const found = [];
    const walk = (rel) => {
      for (const entry of readdirSync(new URL(`../../${rel}`, import.meta.url), {
        withFileTypes: true,
      })) {
        const child = `${rel}/${entry.name}`;
        if (entry.isDirectory()) walk(child);
        else if (/\.(?:ts|tsx|mjs|js)$/.test(entry.name)) found.push(child);
      }
    };
    for (const root of ['src', 'scripts']) walk(root);
    return found;
  };
  const NAMES = Object.keys(AGENT_VOCABULARY);
  const declaration = (name) => new RegExp(`\\b(?:const|let|var|function)\\s+${name}\\b`, 'g');

  it('the gate re-exports the vocabulary’s own objects (identity, not equal copies)', () => {
    const V = AGENT_VOCABULARY;
    const shared = [
      ['AGENT_ENABLED_VAR', GATE.AGENT_ENABLED_VAR, V.AGENT_ENABLED_VAR],
      ['AGENT_ENABLED_VALUES', GATE.AGENT_ENABLED_VALUES, V.AGENT_ENABLED_VALUES],
      ['AGENT_RETENTION_VAR', GATE.AGENT_RETENTION_VAR, V.AGENT_RETENTION_VAR],
      ['AGENT_ARMING_RECORD_VAR', GATE.AGENT_ARMING_RECORD_VAR, V.AGENT_ARMING_RECORD_VAR],
      ['AGENT_ARMABLE_ENVS', GATE.AGENT_ARMABLE_ENVS, V.AGENT_ARMABLE_ENVS],
      ['AGENT_REAPER_CRON', GATE.AGENT_REAPER_CRON, V.AGENT_REAPER_CRON],
      ['AGENT_RUN_BINDING', GATE.AGENT_RUN_BINDING, V.AGENT_RUN_BINDING],
      ['AGENT_RUN_CLASS', GATE.AGENT_RUN_CLASS, V.AGENT_RUN_CLASS],
      ['VAULT_BINDING', GATE.VAULT_BINDING, V.VAULT_BINDING],
      ['VAULT_RETENTION_VAR', GATE.VAULT_RETENTION_VAR, V.VAULT_RETENTION_VAR],
      ['positiveDays', GATE.positiveDays, V.positiveDays],
    ];
    for (const [name, gate, vocabulary] of shared) {
      assert.notEqual(vocabulary, undefined, `${name} is a vocabulary export`);
      assert.equal(gate, vocabulary, `the gate's ${name} is not the vocabulary's`);
    }
    assert.ok(Object.isFrozen(AGENT_VOCABULARY.AGENT_ENABLED_VALUES));
    assert.ok(Object.isFrozen(AGENT_VOCABULARY.AGENT_ARMABLE_ENVS));
    assert.ok(Object.isFrozen(AGENT_VOCABULARY.AGENT_DEPLOYED_ENVS));
  });

  it('declares each name exactly once, and only in the shared module', () => {
    const vocabulary = read(VOCABULARY);
    for (const name of NAMES) {
      assert.equal([...vocabulary.matchAll(declaration(name))].length, 1, name);
    }
    for (const rel of treeFiles()) {
      if (rel === VOCABULARY) continue;
      for (const name of NAMES) {
        assert.doesNotMatch(read(rel), declaration(name), `${rel} re-declares ${name}`);
      }
    }
  });

  it('is imported by the gate and the runtime predicate, and the gate restates no value', () => {
    for (const rel of CONSUMERS) {
      assert.match(
        read(rel),
        /import\s*\{[^}]*\}\s*from\s*'[^']*agentVocabulary\.mjs'/,
        `${rel} must IMPORT the agent vocabulary`,
      );
    }
    // A literal of a vocabulary VALUE in the gate is a second definition waiting to drift.
    const gate = read('scripts/check-edge-hardening.mjs');
    for (const value of [
      AGENT_VOCABULARY.AGENT_ENABLED_VAR,
      AGENT_VOCABULARY.AGENT_RETENTION_VAR,
      AGENT_VOCABULARY.AGENT_ARMING_RECORD_VAR,
      AGENT_VOCABULARY.AGENT_RUN_BINDING,
      AGENT_VOCABULARY.AGENT_RUN_CLASS,
      AGENT_VOCABULARY.AGENT_REAPER_CRON,
      AGENT_VOCABULARY.VAULT_RETENTION_VAR,
    ]) {
      for (const q of ["'", '"']) {
        assert.ok(!gate.includes(`${q}${value}${q}`), `the gate restates ${q}${value}${q}`);
      }
    }
  });

  it('the shared module depends on nothing', () => {
    const vocabulary = read(VOCABULARY);
    assert.doesNotMatch(vocabulary, /^\s*import\s/m);
    assert.doesNotMatch(vocabulary, /\bfrom\s*['"`]/);
    assert.doesNotMatch(vocabulary, /\bimport\s*\(/);
    assert.doesNotMatch(vocabulary, /\brequire\s*\(/);
  });

  // The ladder seam (`armableEnvs`, which lets a TEST open the rungs P2-9 and P2-11 will add) is
  // fenced in test/isolation/agent-arming-fences.test.ts, beside the DSR registrar fence:
  // test/isolation rides /kit-upgrade into a fork's CI; this file reaches a fork only as the
  // copy it bootstrapped with, updated by hand.

  it('the comparisons are exact', () => {
    const { isAgentEnabled, isArmingRecord, isAgentArmableEnv, isAgentDeployedEnv } =
      AGENT_VOCABULARY;
    assert.equal(isAgentEnabled('on'), true);
    for (const near of [undefined, '', ' on', 'ON', 'On', 'true', '1', 'off', true, 1]) {
      assert.equal(isAgentEnabled(near), false, JSON.stringify(near));
    }
    assert.equal(isArmingRecord('AICOE-668'), true);
    assert.equal(isArmingRecord(' AICOE-668'), false);
    assert.equal(isAgentArmableEnv('test'), true);
    assert.equal(isAgentArmableEnv('development'), true);
    for (const e of ['staging', 'production', 'Test', '', undefined]) {
      assert.equal(isAgentArmableEnv(e), false, String(e));
    }
    assert.equal(isAgentDeployedEnv('staging'), true);
    assert.equal(isAgentDeployedEnv('production'), true);
    assert.equal(isAgentDeployedEnv('test'), false);
  });
});

describe('Workflow names carry the app prefix (platform must-fix 5)', () => {
  const ok = (over = {}) => ({
    name: 'arena-go',
    vars: { APP_NAME: 'arena-go' },
    d1_databases: [{ binding: 'DB', database_name: 'arena-go-db' }],
    r2_buckets: [{ binding: 'BACKUPS', bucket_name: 'arena-go-backups' }],
    ...over,
  });
  const run = (name) => ({ binding: AGENT_RUN_BINDING, name, class_name: AGENT_RUN_CLASS });

  it('pins the canonical AGENT_RUN name on the canonical pair', () => {
    assert.deepEqual(
      namingFailures('w.jsonc', ok({ workflows: [run('arena-go-agent-run')] }), ''),
      [],
    );
    const staging = ok({
      name: 'arena-go-staging',
      d1_databases: [{ binding: 'DB', database_name: 'arena-go-db-staging' }],
      r2_buckets: [{ binding: 'BACKUPS', bucket_name: 'arena-go-backups-staging' }],
      workflows: [run('arena-go-agent-run-staging')],
    });
    assert.deepEqual(namingFailures('s.jsonc', staging, '-staging'), []);
    const off = namingFailures('w.jsonc', ok({ workflows: [run('arena-go-agentrun')] }), '');
    assert.deepEqual(off, [
      'w.jsonc: workflows "AGENT_RUN" names "arena-go-agentrun", expected "arena-go-agent-run"',
    ]);
    const unsuffixed = namingFailures(
      's.jsonc',
      { ...staging, workflows: [run('arena-go-agent-run')] },
      '-staging',
    );
    assert.equal(unsuffixed.length, 1, unsuffixed.join('\n'));
    assert.match(unsuffixed[0], /expected "arena-go-agent-run-staging"/);
  });

  it('refuses a Workflow named for another app — any binding, top level or env block', () => {
    const cases = [
      ok({ workflows: [run('insights-agent-run')] }),
      ok({ workflows: [{ binding: 'INGEST', name: 'insights-ingest', class_name: 'X' }] }),
      ok({ workflows: [{ binding: 'INGEST', name: 'insights-ingest', script_name: 'insights' }] }),
      ok({ env: { blue: { workflows: [{ binding: 'INGEST', name: 'insights-ingest' }] } } }),
    ];
    for (const cfg of cases) {
      const f = namingFailures('w.jsonc', cfg, '');
      assert.equal(f.length, 1, f.join('\n'));
      assert.match(f[0], /names "insights-[a-z-]+", which is not this app's \("arena-go"\)/);
      assert.match(f[0], /account-scoped/);
    }
    // The app's own other Workflows pass by prefix; an env block's by prefix alone.
    const own = ok({
      workflows: [run('arena-go-agent-run'), { binding: 'INGEST', name: 'arena-go-ingest' }],
      env: { blue: { workflows: [run('arena-go-agent-run-blue')] } },
    });
    assert.deepEqual(namingFailures('w.jsonc', own, ''), []);
  });

  it('reads the prefix at the dash: a longer app name or a glued one is not this app', () => {
    // "arena-go" owns "arena-go" and "arena-go-*" only. "arena-gox-…" starts with the app name
    // but not at a dash, so it is another app's ("arena-gox"), and "arenago-x" is not even that.
    for (const name of ['arena-gox-ingest', 'arenago-x', 'arena-g', 'arena-go_x']) {
      const f = namingFailures('w.jsonc', ok({ workflows: [{ binding: 'X', name }] }), '');
      assert.equal(f.length, 1, `${name}: ${f.join('\n')}`);
      assert.match(f[0], new RegExp(`names "${name}", which is not this app's \\("arena-go"\\)`));
    }
    for (const name of ['arena-go', 'arena-go-x']) {
      assert.deepEqual(
        namingFailures('w.jsonc', ok({ workflows: [{ binding: 'X', name }] }), ''),
        [],
      );
    }
  });

  it('looks canonical names up by own key: a binding named like an Object method is not one', () => {
    const cfg = ok({
      d1_databases: [
        { binding: 'DB', database_name: 'arena-go-db' },
        { binding: 'toString', database_name: 'arena-go-scratch' },
      ],
      r2_buckets: [{ binding: 'constructor', bucket_name: 'arena-go-files' }],
      workflows: [
        { binding: 'constructor', name: 'arena-go-ctor' },
        { binding: '__proto__', name: 'arena-go-proto' },
        { binding: 'hasOwnProperty', name: 'arena-go-own' },
      ],
    });
    assert.deepEqual(namingFailures('w.jsonc', cfg, ''), []);
  });

  it('holds a discovered config to the prefix, never the canonical name', () => {
    const cfg = { workflows: [run('arena-go-mcp-agent-run'), { binding: 'X', name: 'zeta-x' }] };
    const f = discoveredNamingFailures('wrangler.mcp.jsonc', cfg, 'arena-go');
    assert.equal(f.length, 1, f.join('\n'));
    assert.match(f[0], /workflows "X" names "zeta-x"/);
  });

  it('passes on the repo configs (they bind no Workflow yet)', () => {
    assert.deepEqual(checkResourceNaming(), []);
  });
});

describe('a script_name binds only a Workflow this repo defines (platform must-fix 5)', () => {
  const run = { binding: AGENT_RUN_BINDING, class_name: AGENT_RUN_CLASS };

  it("refuses binding a sibling app's Workflow, even when its name passes this app's prefix", () => {
    // "arena" is a dash-prefix of "arena-go": the sibling's canonical turn engine passes the prefix
    // rule for both apps. The definition is what tells them apart, and it is not in this repo.
    const arena = {
      name: 'arena',
      vars: { APP_NAME: 'arena' },
      workflows: [{ binding: 'PEEK', name: 'arena-go-agent-run', script_name: 'arena-go' }],
    };
    assert.deepEqual(namingFailures('wrangler.jsonc', arena, ''), []);
    const f = foreignWorkflowFailures([['wrangler.jsonc', arena]]);
    assert.equal(f.length, 1, f.join('\n'));
    assert.match(
      f[0],
      /^wrangler\.jsonc: workflows "PEEK" binds Workflow "arena-go-agent-run" of Worker "arena-go", which no config in this repo defines/,
    );
    // A discovered config naming AGENT_RUN for the sibling, in an env block: the same answer.
    const mcp = {
      name: 'arena-mcp',
      env: {
        blue: { workflows: [{ ...run, name: 'arena-go-agent-run', script_name: 'arena-go' }] },
      },
    };
    const g = foreignWorkflowFailures([['wrangler.mcp.jsonc', mcp]]);
    assert.equal(g.length, 1, g.join('\n'));
    assert.match(g[0], /^wrangler\.mcp\.jsonc: env\.blue\.workflows "AGENT_RUN" binds Workflow/);
  });

  it("allows a binding to a Workflow another of this repo's configs defines, or this Worker", () => {
    const main = {
      name: 'arena-go',
      workflows: [{ binding: 'INGEST', name: 'arena-go-ingest', class_name: 'IngestWorkflow' }],
      env: {
        blue: { workflows: [{ binding: 'INGEST', name: 'arena-go-ingest-blue', class_name: 'X' }] },
      },
    };
    const mcp = {
      name: 'arena-go-mcp',
      workflows: [
        { binding: 'INGEST', name: 'arena-go-ingest', script_name: 'arena-go' },
        { binding: 'BLUE', name: 'arena-go-ingest-blue', script_name: 'arena-go-blue' },
        { binding: 'SELF', name: 'arena-go-mcp-x', script_name: 'arena-go-mcp', class_name: 'X' },
      ],
    };
    assert.deepEqual(
      foreignWorkflowFailures([
        ['wrangler.jsonc', main],
        ['wrangler.mcp.jsonc', mcp],
      ]),
      [],
    );
    // The same Worker, the wrong Workflow name: not defined there, so refused.
    const typo = {
      name: 'arena-go-mcp',
      workflows: [{ binding: 'I', name: 'arena-go-ingst', script_name: 'arena-go' }],
    };
    assert.equal(
      foreignWorkflowFailures([
        ['wrangler.jsonc', main],
        ['w2.jsonc', typo],
      ]).length,
      1,
    );
  });

  it('runs inside checkResourceNaming over every root config', () => {
    const dir = mkdtempSync(join(tmpdir(), 'foreign-workflow-'));
    const cfg = (name, suffix, over = {}) =>
      JSON.stringify({
        name,
        vars: { APP_NAME: 'arena' },
        d1_databases: [{ binding: 'DB', database_name: `arena-db${suffix}` }],
        r2_buckets: [{ binding: 'BACKUPS', bucket_name: `arena-backups${suffix}` }],
        ...over,
      });
    writeFileSync(join(dir, 'wrangler.jsonc'), cfg('arena', ''));
    writeFileSync(
      join(dir, 'wrangler.staging.jsonc'),
      cfg('arena-staging', '-staging', {
        workflows: [{ binding: 'PEEK', name: 'arena-go-ingest', script_name: 'arena-go' }],
      }),
    );
    const f = checkResourceNaming(dir);
    assert.equal(f.length, 1, f.join('\n'));
    assert.match(
      f[0],
      /^wrangler\.staging\.jsonc: workflows "PEEK" binds Workflow "arena-go-ingest"/,
    );
  });

  it('judges DISCOVERED configs too, both as binders and as definers', () => {
    // checkResourceNaming hands every discovered root config to the rule along with the pair: a
    // third config's foreign binding is refused, and a Workflow it defines is one the pair may bind.
    const repo = (mcp, prodOver = {}) => {
      const dir = mkdtempSync(join(tmpdir(), 'foreign-workflow-discovered-'));
      const cfg = (name, suffix, over = {}) =>
        JSON.stringify({
          name,
          vars: { APP_NAME: 'arena' },
          d1_databases: [{ binding: 'DB', database_name: `arena-db${suffix}` }],
          r2_buckets: [{ binding: 'BACKUPS', bucket_name: `arena-backups${suffix}` }],
          ...over,
        });
      writeFileSync(join(dir, 'wrangler.jsonc'), cfg('arena', '', prodOver));
      writeFileSync(join(dir, 'wrangler.staging.jsonc'), cfg('arena-staging', '-staging'));
      writeFileSync(join(dir, 'wrangler.mcp.jsonc'), JSON.stringify(mcp));
      return dir;
    };
    const foreign = checkResourceNaming(
      repo({
        name: 'arena-mcp',
        workflows: [{ binding: 'PEEK', name: 'arena-go-agent-run', script_name: 'arena-go' }],
      }),
    );
    assert.equal(foreign.length, 1, foreign.join('\n'));
    assert.match(
      foreign[0],
      /^wrangler\.mcp\.jsonc: workflows "PEEK" binds Workflow "arena-go-agent-run" of Worker "arena-go", which no config in this repo defines/,
    );
    const ownSibling = checkResourceNaming(
      repo(
        {
          name: 'arena-mcp',
          workflows: [{ binding: 'JOBS', name: 'arena-mcp-jobs', class_name: 'JobsWorkflow' }],
        },
        { workflows: [{ binding: 'JOBS', name: 'arena-mcp-jobs', script_name: 'arena-mcp' }] },
      ),
    );
    assert.deepEqual(ownSibling, []);
  });
});

describe('one Workflow name, one Worker (platform must-fix 5)', () => {
  const run = (name, over = {}) => ({
    binding: AGENT_RUN_BINDING,
    name,
    class_name: AGENT_RUN_CLASS,
    ...over,
  });
  const jobs = (name, over = {}) => ({
    binding: 'JOBS',
    name,
    class_name: 'JobsWorkflow',
    ...over,
  });
  const prod = (over = {}) => [
    'wrangler.jsonc',
    { name: 'acme', vars: { APP_NAME: 'acme' }, ...over },
  ];
  const staging = (over = {}) => [
    'wrangler.staging.jsonc',
    { name: 'acme-staging', vars: { APP_NAME: 'acme' }, ...over },
  ];
  const clash = (configs) => workflowNameClashFailures(configs, 'acme');

  it('passes the canonical pair defining their own names, and bindings that only USE a name', () => {
    assert.deepEqual(
      clash([
        prod({ workflows: [run('acme-agent-run'), jobs('acme-jobs')] }),
        staging({ workflows: [run('acme-agent-run-staging'), jobs('acme-jobs-staging')] }),
        [
          'wrangler.mcp.jsonc',
          {
            name: 'acme-mcp',
            workflows: [
              jobs('acme-mcp-jobs'),
              // A binding to the canonical engine is a use: foreignWorkflowFailures judges it.
              run('acme-agent-run', { script_name: 'acme', class_name: undefined }),
            ],
          },
        ],
      ]),
      [],
    );
  });

  it('refuses a copied config that keeps the canonical engine — two Workers, one name', () => {
    const f = clash([
      prod({ workflows: [run('acme-agent-run')] }),
      staging(),
      ['wrangler.mcp.jsonc', { name: 'acme-mcp', workflows: [run('acme-agent-run')] }],
    ]);
    assert.equal(f.length, 2, f.join('\n'));
    assert.match(
      f[0],
      /^wrangler\.mcp\.jsonc: workflows "AGENT_RUN" defines Workflow "acme-agent-run", the name the kit reserves for the AGENT_RUN binding at the top level of wrangler\.jsonc/,
    );
    assert.match(
      f[1],
      /^wrangler\.mcp\.jsonc: workflows "AGENT_RUN" defines Workflow "acme-agent-run" in Worker "acme-mcp", which wrangler\.jsonc: workflows "AGENT_RUN" already defines in Worker "acme"\. Workflow names are account-scoped/,
    );
  });

  it('refuses an env block that repeats the top level’s Workflow — it deploys another Worker', () => {
    const f = clash([
      prod({
        workflows: [run('acme-agent-run'), jobs('acme-jobs')],
        env: { blue: { workflows: [run('acme-agent-run'), jobs('acme-jobs')] } },
      }),
      staging(),
    ]);
    assert.equal(f.length, 3, f.join('\n'));
    assert.match(
      f[0],
      /^wrangler\.jsonc: env\.blue\.workflows "AGENT_RUN" defines Workflow "acme-agent-run", the name the kit reserves/,
    );
    assert.match(
      f[1],
      /^wrangler\.jsonc: env\.blue\.workflows "AGENT_RUN" defines Workflow "acme-agent-run" in Worker "acme-blue", which wrangler\.jsonc: workflows "AGENT_RUN" already defines in Worker "acme"/,
    );
    assert.match(
      f[2],
      /^wrangler\.jsonc: env\.blue\.workflows "JOBS" defines Workflow "acme-jobs" in Worker "acme-blue"/,
    );
    // The env block's own names pass.
    assert.deepEqual(
      clash([
        prod({
          workflows: [run('acme-agent-run')],
          env: { blue: { workflows: [run('acme-agent-run-blue')] } },
        }),
        staging(),
      ]),
      [],
    );
  });

  it('reserves the canonical names even before the canonical config defines them', () => {
    for (const [label, cfg, name, owner] of [
      ['wrangler.mcp.jsonc', { name: 'acme-mcp' }, 'acme-agent-run', 'wrangler.jsonc'],
      [
        'wrangler.mcp.jsonc',
        { name: 'acme-mcp' },
        'acme-agent-run-staging',
        'wrangler.staging.jsonc',
      ],
      ['wrangler.staging.jsonc', { name: 'acme-staging' }, 'acme-agent-run', 'wrangler.jsonc'],
    ]) {
      const f = clash([prod(), [label, { ...cfg, workflows: [jobs(name)] }]]);
      assert.equal(f.length, 1, `${label} ${name}: ${f.join('\n')}`);
      assert.match(
        f[0],
        new RegExp(
          `reserves for the AGENT_RUN binding at the top level of ${owner.replaceAll('.', '\\.')}`,
        ),
      );
    }
    // At its own spot but under another binding, the name is still not the engine's to give away.
    const other = clash([prod({ workflows: [jobs('acme-agent-run')] }), staging()]);
    assert.equal(other.length, 1, other.join('\n'));
  });

  it('runs inside checkResourceNaming, against the identity config’s APP_NAME', () => {
    const dir = mkdtempSync(join(tmpdir(), 'workflow-clash-'));
    const cfg = (name, suffix, over = {}) =>
      JSON.stringify({
        name,
        vars: { APP_NAME: 'acme' },
        d1_databases: [{ binding: 'DB', database_name: `acme-db${suffix}` }],
        r2_buckets: [{ binding: 'BACKUPS', bucket_name: `acme-backups${suffix}` }],
        ...over,
      });
    writeFileSync(
      join(dir, 'wrangler.jsonc'),
      cfg('acme', '', { workflows: [run('acme-agent-run')] }),
    );
    writeFileSync(join(dir, 'wrangler.staging.jsonc'), cfg('acme-staging', '-staging'));
    writeFileSync(
      join(dir, 'wrangler.mcp.jsonc'),
      JSON.stringify({ name: 'acme-mcp', workflows: [run('acme-agent-run')] }),
    );
    const f = checkResourceNaming(dir);
    assert.equal(f.length, 2, f.join('\n'));
    assert.ok(
      f.every((x) => x.startsWith('wrangler.mcp.jsonc: workflows "AGENT_RUN" defines')),
      f,
    );
  });
});

// HTTP services behind a Workers VPC service (ILOPS-8993). A `vpc_services` grant may carry
// `"class": "http"`: the binding fronts an HTTP service, not a database, so it needs no database
// class, no AURORA_SOURCES entry and no read-audit arming — but it is still a reviewed grant by id,
// still `VPC_*`-named, still needs its host var, and its service must be registered in the
// transport's table (src/data/privateServices.ts), which attaches the credential. These cases pin
// both halves: the new kind is accepted, and nothing the database path refused is now let through.
describe('HTTP service grants (Workers VPC)', () => {
  const HOST = 'example-api.private.staging.example.test';
  const binding = { binding: 'VPC_EXAMPLE_API', service_id: 'svc-http-1' };
  const httpGrant = { id: 'svc-http-1', class: 'http' };
  const cfg = { vars: { VPC_EXAMPLE_API_HOST: HOST }, vpc_services: [binding] };
  const granted = { vpc_services: [httpGrant] };
  const services = { example_api: 'EXAMPLE_API_TOKEN' };

  it('takes the http class on vpc_services only', () => {
    assert.equal(GATE.HTTP_SERVICE_CLASS, 'http');
    assert.deepEqual(GATE.grantClassesFor('vpc_services'), ['client', 'internal', 'http']);
    assert.deepEqual(GATE.grantClassesFor('hyperdrive'), SOURCE_CLASSES);
    assert.deepEqual(GATE.grantClassesFor('vpc_networks'), SOURCE_CLASSES);
    assert.equal(grantFailure('w.jsonc', 'vpc_services', httpGrant), null);
  });

  // Hyperdrive is always a database and a network binding reaches a whole tunnel.
  it('refuses the http class on hyperdrive and vpc_networks', () => {
    for (const kind of ['hyperdrive', 'vpc_networks']) {
      const f = grantFailure('w.jsonc', kind, httpGrant);
      assert.ok(f?.includes('Only a vpc_services binding'), `${kind}: ${f}`);
    }
  });

  it('accepts a listed HTTP service binding with no database class or read-seam entry', () => {
    assert.deepEqual(bindingAllowlistFailures('w.jsonc', cfg, granted), []);
    // No AURORA_SOURCES entry is demanded, even from an empty table…
    assert.deepEqual(sourceRegistryFailures('w.jsonc', cfg, granted, {}), []);
    // …or an unreadable one: the database cross-check does not apply to an http grant.
    assert.deepEqual(sourceRegistryFailures('w.jsonc', cfg, granted, null), []);
    assert.deepEqual(
      GATE.privateServiceRegistryFailures('w.jsonc', cfg, granted, services, {}),
      [],
    );
  });

  it('needs no read-audit arming', () => {
    assert.deepEqual(bindingAllowlistFailures('w.jsonc', cfg, granted), []);
    assert.equal(cfg.vars[READ_AUDIT_VAR], undefined);
  });

  it('still refuses an unlisted service id', () => {
    const f = bindingAllowlistFailures('w.jsonc', cfg, { vpc_services: [] });
    assert.equal(f.length, 1);
    assert.ok(f[0].includes(`not in ${ALLOWLIST_FILE}`));
  });

  it('still refuses a binding without the VPC_ prefix', () => {
    const f = bindingAllowlistFailures(
      'w.jsonc',
      { vars: { GATEWAY_HOST: HOST }, vpc_services: [{ ...binding, binding: 'GATEWAY' }] },
      granted,
    );
    assert.equal(f.length, 1);
    assert.ok(f[0].includes('must be named VPC_*'));
  });

  it('still refuses an unlisted vpc_networks binding next to an http grant', () => {
    const f = bindingAllowlistFailures(
      'w.jsonc',
      { ...cfg, vpc_networks: [{ binding: 'VPC_MESH', network_id: 'cf1:network' }] },
      { ...granted, vpc_networks: [] },
    );
    assert.equal(f.length, 1);
    assert.ok(f[0].includes('cf1:network'));
  });

  it('flags a stale http grant nobody binds', () => {
    const f = bindingAllowlistFailures('w.jsonc', {}, granted);
    assert.equal(f.length, 1);
    assert.ok(f[0].includes('does not bind'));
  });

  it('requires the host var in the same config, as a bare lowercase host name', () => {
    for (const host of [
      undefined,
      '',
      `https://${HOST}`,
      `${HOST}:443`,
      `${HOST}/x`,
      HOST.toUpperCase(),
      'localhost',
      `${HOST}.`,
      42,
    ]) {
      const vars = host === undefined ? {} : { VPC_EXAMPLE_API_HOST: host };
      const f = bindingAllowlistFailures('w.jsonc', { ...cfg, vars }, granted);
      assert.equal(f.length, 1, `host ${JSON.stringify(host)}`);
      assert.ok(f[0].includes('VPC_EXAMPLE_API_HOST'));
    }
  });

  // Self-audit: the transport looks the binding up as VPC_ + the service name uppercased, so only
  // an upper-snake name round-trips; a `_HOST` suffix would collide with a sibling's host var.
  it('requires an http binding name the transport can find', () => {
    for (const name of ['VPC_example_api', 'VPC_Example', 'VPC_1API', 'VPC_EXAMPLE_HOST', 'VPC_']) {
      const f = bindingAllowlistFailures(
        'w.jsonc',
        { vars: { [`${name}_HOST`]: HOST }, vpc_services: [{ ...binding, binding: name }] },
        granted,
      );
      assert.equal(f.length, 1, `${name}: ${JSON.stringify(f)}`);
      assert.ok(f[0].includes('UPPER_SNAKE_CASE'), name);
    }
  });

  it('does not ask a database-class vpc_services grant for a host var', () => {
    assert.deepEqual(
      bindingAllowlistFailures(
        'w.jsonc',
        { vpc_services: [binding] },
        { vpc_services: [{ id: 'svc-http-1', class: 'internal' }] },
      ),
      [],
    );
  });

  // Codex audit F3: every reader takes the first grant for an id, so `http` listed before `client`
  // for the same id would skip AURORA_SOURCES and READ_AUDIT arming for a client database.
  it('refuses one id granted twice, in either order and with either classes', () => {
    const clientGrant = { id: 'svc-http-1', class: 'client' };
    for (const grants of [
      [httpGrant, clientGrant],
      [clientGrant, httpGrant],
    ]) {
      // Client-first also draws the arming failure; the duplicate is refused in both orders.
      const f = bindingAllowlistFailures('w.jsonc', cfg, { vpc_services: grants });
      const dupe = f.filter((m) => m.includes('2 times'));
      assert.equal(dupe.length, 1, JSON.stringify(f));
      assert.ok(dupe[0].includes('http') && dupe[0].includes('client'));
    }
    const same = bindingAllowlistFailures('w.jsonc', cfg, { vpc_services: [httpGrant, httpGrant] });
    assert.equal(same.length, 1);
    assert.ok(same[0].includes('2 times'));
    // The inherited weakness this closes was not http-specific: database grants too.
    const db = bindingAllowlistFailures(
      'w.jsonc',
      { hyperdrive: [ok] },
      { hyperdrive: [INTERNAL_GRANT, { id: 'abc123', class: 'client' }] },
    );
    assert.ok(db.some((m) => m.includes('2 times')));
  });

  it('requires the service registered in PRIVATE_SERVICES', () => {
    const f = GATE.privateServiceRegistryFailures('w.jsonc', cfg, granted, {}, {});
    assert.equal(f.length, 1);
    assert.ok(f[0].includes('absent from PRIVATE_SERVICES'));
  });

  it('fails an http grant when the transport file is absent or unreadable', () => {
    const absent = GATE.privateServiceRegistryFailures('w.jsonc', cfg, granted, undefined, {});
    assert.equal(absent.length, 1);
    assert.ok(absent[0].includes('does not exist'));
    const unreadable = GATE.privateServiceRegistryFailures('w.jsonc', cfg, granted, null, {});
    assert.equal(unreadable.length, 1);
    assert.ok(unreadable[0].includes('statically'));
  });

  it('refuses one name registered as both a database and an HTTP service', () => {
    const asHttp = GATE.privateServiceRegistryFailures('w.jsonc', cfg, granted, services, {
      example_api: 'internal',
    });
    assert.equal(asHttp.length, 1);
    assert.ok(asHttp[0].includes('registered as a database'));

    const dbGranted = { vpc_services: [{ id: 'svc-http-1', class: 'internal' }] };
    const asDb = GATE.privateServiceRegistryFailures('w.jsonc', cfg, dbGranted, services, {});
    assert.equal(asDb.length, 1);
    assert.ok(asDb[0].includes('registered as an HTTP service'));
  });

  it('leaves existing database vpc_services grants exactly as before', () => {
    const dbCfg = { vpc_services: [{ binding: 'VPC_IPA', service_id: 'svc-1' }] };
    const dbGranted = { vpc_services: [{ id: 'svc-1', class: 'internal' }] };
    assert.deepEqual(bindingAllowlistFailures('w.jsonc', dbCfg, dbGranted), []);
    assert.deepEqual(sourceRegistryFailures('w.jsonc', dbCfg, dbGranted, { ipa: 'internal' }), []);
    const missing = sourceRegistryFailures('w.jsonc', dbCfg, dbGranted, {});
    assert.equal(missing.length, 1);
    assert.ok(missing[0].includes('absent from AURORA_SOURCES'));
    // An absent transport file changes nothing for a database grant.
    assert.deepEqual(
      GATE.privateServiceRegistryFailures('w.jsonc', dbCfg, dbGranted, undefined, {}),
      [],
    );
  });
});

describe('PRIVATE_SERVICES table — the kit’s proof, and the fork’s invariants', () => {
  const readTransport = () =>
    readFileSync(new URL(`../../${GATE.PRIVATE_SERVICES_FILE}`, import.meta.url), 'utf8');

  it('reads a plain object literal and refuses anything it cannot see', () => {
    const parse = GATE.parsePrivateServices;
    assert.deepEqual(parse('export const PRIVATE_SERVICES = Object.freeze({})'), {});
    assert.deepEqual(
      parse(
        'export const PRIVATE_SERVICES = Object.freeze({\n' +
          "  // a comment: `x: 'Y',`\n  example_api: 'EXAMPLE_API_TOKEN',\n  b: \"B_KEY\",\n})",
      ),
      { example_api: 'EXAMPLE_API_TOKEN', b: 'B_KEY' },
    );
    assert.equal(parse("export const PRIVATE_SERVICES = Object.freeze({ ...more, a: 'A' })"), null);
    assert.equal(
      parse("export const PRIVATE_SERVICES = Object.freeze({ a: { secret: 'A' } })"),
      null,
    );
    assert.equal(parse('no table here'), null);
  });

  // The table's own doc comment carries an example declaration; reading it as the table would make
  // the real table invisible.
  it('never reads a doc-comment example as the table', () => {
    const text =
      "/**\n *     export const PRIVATE_SERVICES = Object.freeze({\n *       a: 'A',\n *     })\n */\n" +
      "export const PRIVATE_SERVICES = Object.freeze({\n  real_one: 'REAL',\n})";
    assert.deepEqual(GATE.parsePrivateServices(text), { real_one: 'REAL' });
  });

  // Codex audit F2: the declaration is found OUTSIDE comments and strings — an ordinary block
  // comment, not only a starred doc comment — and there must be exactly one.
  it('never reads a commented-out or quoted table, and requires exactly one declaration', () => {
    const parse = GATE.parsePrivateServices;
    const real = 'export const PRIVATE_SERVICES = Object.freeze({});\n';
    const commented =
      "/*\nexport const PRIVATE_SERVICES = Object.freeze({\n  example_api: 'EXAMPLE_API_TOKEN',\n})\n*/\n";
    assert.deepEqual(parse(commented + real), {});
    assert.equal(parse(commented), null, 'a table that exists only in a comment is no table');
    assert.deepEqual(
      parse(`// export const PRIVATE_SERVICES = Object.freeze({ a: 'A' })\n${real}`),
      {},
    );
    assert.equal(
      parse("const s = `\nexport const PRIVATE_SERVICES = Object.freeze({ a: 'A' })\n`;\n"),
      null,
    );
    assert.equal(parse(real + real), null, 'two declarations are ambiguous');
    // The initializer must end where the table does.
    assert.equal(
      parse("export const PRIVATE_SERVICES = Object.freeze({ a: 'A' }) && extra;\n"),
      null,
    );
    assert.deepEqual(
      parse("export const PRIVATE_SERVICES = Object.freeze({ a: 'A' }) satisfies X;\n"),
      { a: 'A' },
    );
    // A `})` or `//` inside a value-looking string elsewhere does not confuse the reader.
    assert.deepEqual(parse(`const u = 'https://x.test/})';\nconst r = /['"]/;\n${real}`), {});
  });

  it('reads AURORA_SOURCES the same way', () => {
    const real = "export const AURORA_SOURCES = Object.freeze({ ret1_ro: 'internal' });\n";
    assert.deepEqual(
      parseAuroraSources(
        `/*\nexport const AURORA_SOURCES = Object.freeze({ c_ro: 'client' })\n*/\n${real}`,
      ),
      { ret1_ro: 'internal' },
    );
    assert.equal(
      parseAuroraSources(
        "/*\nexport const AURORA_SOURCES = Object.freeze({ c_ro: 'client' })\n*/\n",
      ),
      null,
    );
    assert.equal(parseAuroraSources(real + real), null);
  });

  // Codex re-audit F1: JavaScript continues an expression across a newline, so `})` at the end of
  // a line is not the end of the initializer. The gate read the first table while the runtime
  // used the whole expression — an empty table, or `internal` where the gate saw `client`.
  it('refuses an initializer that continues past the table, on either table', () => {
    const http =
      "export const PRIVATE_SERVICES = Object.freeze({\n  example_api: 'EXAMPLE_API_TOKEN',\n})\n  && Object.freeze({});\n";
    assert.equal(GATE.parsePrivateServices(http), null);
    const aurora =
      "export const AURORA_SOURCES = Object.freeze({\n  c_ro: 'client',\n})\n  && Object.freeze({ c_ro: 'internal' });\n";
    assert.equal(parseAuroraSources(aurora), null);
    for (const tail of [' as X;', ' || {};', '.valueOf();', ' ? a : b;']) {
      assert.equal(
        GATE.parsePrivateServices(`export const PRIVATE_SERVICES = Object.freeze({})${tail}`),
        null,
        tail,
      );
    }
  });

  // Codex re-audit F2: the old scanner indexed code points in one place and UTF-16 units in
  // another, so one emoji before the table made it unreadable and blocked the gate.
  it('reads a table after non-BMP characters in strings and comments', () => {
    const text =
      "// 🧪 a comment\nconst icon = '🧪';\nconst t = `𝔘`;\n" +
      "export const PRIVATE_SERVICES = Object.freeze({ example_api: 'EXAMPLE_API_TOKEN' });\n" +
      "export const AURORA_SOURCES = Object.freeze({ ret1_ro: 'internal' });\n";
    assert.deepEqual(GATE.parsePrivateServices(text), { example_api: 'EXAMPLE_API_TOKEN' });
    assert.deepEqual(parseAuroraSources(text), { ret1_ro: 'internal' });
  });

  it('refuses every shape the runtime could read differently', () => {
    const parse = GATE.parsePrivateServices;
    for (const [why, text] of [
      ['let, not const', "export let PRIVATE_SERVICES = Object.freeze({ a: 'A' });"],
      ['not frozen', "export const PRIVATE_SERVICES = { a: 'A' };"],
      [
        'a shadowed Object',
        "const Object = { freeze: (x) => ({}) };\nexport const PRIVATE_SERVICES = Object.freeze({ a: 'A' });",
      ],
      ['a computed key', "export const PRIVATE_SERVICES = Object.freeze({ ['a']: 'A' });"],
      ['a duplicate key', "export const PRIVATE_SERVICES = Object.freeze({ a: 'A', a: 'B' });"],
      ['__proto__', "export const PRIVATE_SERVICES = Object.freeze({ __proto__: 'A' });"],
      ['a non-string value', 'export const PRIVATE_SERVICES = Object.freeze({ a: SECRET });'],
      ['a syntax error', "export const PRIVATE_SERVICES = Object.freeze({ a: 'A' "],
    ]) {
      assert.equal(parse(text), null, why);
    }
    assert.deepEqual(parse("export const PRIVATE_SERVICES = Object.freeze({ 'a_b': 'A' });"), {
      a_b: 'A',
    });
  });

  // Codex re-audit 3: `Object.freeze` is only the platform's if this file leaves `Object` alone.
  // `const { Object } = …` made the gate read EXAMPLE_API_TOKEN while the Worker used OTHER_TOKEN.
  // Every way a module can rebind, alias, hand out or write `Object` is refused, on both tables.
  it('refuses a file that could change what Object.freeze is', () => {
    const table = (name, body) => `export const ${name} = Object.freeze({ ${body} });\n`;
    const ways = [
      ['destructured', 'const { Object } = { Object: { freeze: () => ({}) } };'],
      ['nested destructuring', 'const { a: { Object } } = x;'],
      ['array destructuring', 'const [Object] = [x];'],
      ['a default in a pattern', 'const { a = 1, ...Object } = x;'],
      ['an import alias', "import { Fake as Object } from './fake';"],
      ['a default import', "import Object from './fake';"],
      ['a namespace import', "import * as Object from './fake';"],
      ['a declaration', 'var Object = x;'],
      ['a function', 'function Object() {}'],
      ['a class', 'class Object {}'],
      ['an enum', 'enum Object { A }'],
      ['a namespace', 'namespace Object { export const freeze = 1; }'],
      ['import-equals', "import Object = require('./fake');"],
      ['a parameter', 'function f(Object) { return Object; }'],
      ['a catch binding', 'try {} catch (Object) {}'],
      ['an alias then a write', 'const O = Object; O.freeze = () => ({});'],
      ['a direct write', 'Object.freeze = () => ({});'],
      ['a computed write', "Object['freeze'] = () => ({});"],
      ['a deep write', 'Object.prototype.x = 1;'],
      ['a delete', 'delete Object.freeze;'],
      ['a destructuring write', '({ a: Object.freeze } = x);'],
      ['defineProperty', "Object.defineProperty(Object, 'freeze', { value: () => ({}) });"],
      ['Reflect', "Reflect.set(Object, 'freeze', () => ({}));"],
      ['globalThis', 'globalThis.Object = x;'],
      ['self, computed', "self['Object'].freeze = x;"],
      ['globalThis, dynamic', 'globalThis[k] = x;'],
      ['an enum initializer', 'enum E { A = (Object.freeze = f, 1) }'],
      ['exported', 'export default Object;'],
    ];
    for (const [why, prelude] of ways) {
      assert.equal(
        GATE.parsePrivateServices(
          `${prelude}\n${table('PRIVATE_SERVICES', "example_api: 'EXAMPLE_API_TOKEN'")}`,
        ),
        null,
        `PRIVATE_SERVICES with ${why}`,
      );
      assert.equal(
        parseAuroraSources(`${prelude}\n${table('AURORA_SOURCES', "ret1_ro: 'client'")}`),
        null,
        `AURORA_SOURCES with ${why}`,
      );
    }
  });

  it('still reads a file that only reads Object members, names a key Object, or types it', () => {
    const text =
      "const has = Object.hasOwn({}, 'a');\nconst keys = Object.keys({ Object: 1 });\n" +
      'type T = typeof Object;\nlet v: Object | undefined;\nconst o = { Object: 1 }.Object;\n' +
      "export const PRIVATE_SERVICES = Object.freeze({ example_api: 'EXAMPLE_API_TOKEN' });\n";
    assert.deepEqual(GATE.parsePrivateServices(text), { example_api: 'EXAMPLE_API_TOKEN' });
  });

  it('checks the table independently of any grant', () => {
    const fail = GATE.privateServiceTableFailures;
    assert.deepEqual(fail(undefined, true), [], 'an absent file is silent here');
    assert.ok(fail(null, false)[0].includes('statically'));
    assert.ok(fail({ Example: 'X' }, false)[0].includes('LOWERCASED'));
    assert.ok(fail({ example: 'token' }, false)[0].includes('UPPER_SNAKE_CASE'));
    for (const secret of ['VPC_EXAMPLE_API', 'VPC_EXAMPLE_API_HOST', 'HYPERDRIVE_RET1_RO']) {
      assert.ok(fail({ example_api: secret }, false)[0].includes('not a VPC_/HYPERDRIVE_'), secret);
    }
    assert.deepEqual(fail({ example_api: 'EXAMPLE_API_TOKEN' }, false), []);
    const kit = fail({ example_api: 'EXAMPLE_API_TOKEN' }, true);
    assert.equal(kit.length, 1);
    assert.ok(kit[0].includes('ships empty'));
    assert.ok(kit[0].includes('new-app'));
  });

  it('is satisfied by this repo, in whichever state it is in', () => {
    const idCfg = parseJsonc(
      readFileSync(new URL(`../../${IDENTITY_CONFIG}`, import.meta.url), 'utf8'),
    );
    const services = GATE.parsePrivateServices(readTransport());
    assert.notEqual(services, null, 'PRIVATE_SERVICES must stay statically readable');
    const unforked = isUnforkedTemplate(idCfg);
    assert.deepEqual(GATE.privateServiceTableFailures(services, unforked), []);
    if (unforked) assert.deepEqual(services, {}, 'the unforked kit calls no private service');
  });

  // The gate cannot import TypeScript, so it mirrors the transport's host pattern; one character
  // of drift would let the gate pass a host the transport refuses at run time, or the reverse.
  it('mirrors the transport’s host pattern exactly', () => {
    assert.ok(readTransport().includes(GATE.PRIVATE_SERVICE_HOST.source));
  });
});

describe('HTTP service grants — end to end through checkBindingAllowlist', () => {
  const FLAGS = { workers_dev: false, preview_urls: false };
  const HOST = 'example-api.private.staging.example.test';
  const rootWith = (files) => {
    const dir = mkdtempSync(join(tmpdir(), 'edge-gate-http-'));
    for (const [name, text] of Object.entries(files)) {
      mkdirSync(join(dir, dirname(name)), { recursive: true });
      writeFileSync(join(dir, name), text);
    }
    return dir;
  };
  // An app (its config has a name that is not the template's), granting one HTTP service in staging.
  const appRoot = (extra = {}) =>
    rootWith({
      'wrangler.jsonc': JSON.stringify({ name: 'some-app', ...FLAGS }),
      'wrangler.staging.jsonc': JSON.stringify({
        ...FLAGS,
        vars: { VPC_EXAMPLE_API_HOST: HOST },
        vpc_services: [{ binding: 'VPC_EXAMPLE_API', service_id: 'svc-http-1' }],
      }),
      'binding-allowlist.jsonc': JSON.stringify({
        'wrangler.jsonc': {},
        'wrangler.staging.jsonc': { vpc_services: [{ id: 'svc-http-1', class: 'http' }] },
      }),
      'src/data/aurora.ts': 'export const AURORA_SOURCES = Object.freeze({});\n',
      'src/data/privateServices.ts':
        "export const PRIVATE_SERVICES = Object.freeze({\n  example_api: 'EXAMPLE_API_TOKEN',\n});\n",
      ...extra,
    });

  it('passes a fully declared HTTP service', () => {
    assert.deepEqual(checkBindingAllowlist(appRoot()), []);
  });

  it('fails when the transport file is missing, naming it', () => {
    const root = appRoot();
    rmSync(join(root, 'src/data/privateServices.ts'));
    const f = checkBindingAllowlist(root);
    assert.equal(f.length, 1);
    assert.ok(f[0].includes('privateServices.ts'));
  });

  it('fails when the service is not registered', () => {
    const f = checkBindingAllowlist(
      appRoot({
        'src/data/privateServices.ts': 'export const PRIVATE_SERVICES = Object.freeze({});\n',
      }),
    );
    assert.equal(f.length, 1);
    assert.ok(f[0].includes('absent from PRIVATE_SERVICES'));
  });

  // Codex audit F2, end to end: a commented-out registration above an empty runtime table used to
  // pass the whole gate while every deployed call failed as unregistered.
  it('fails a registration that exists only in a comment', () => {
    const f = checkBindingAllowlist(
      appRoot({
        'src/data/privateServices.ts':
          "/*\nexport const PRIVATE_SERVICES = Object.freeze({\n  example_api: 'EXAMPLE_API_TOKEN',\n})\n*/\n" +
          'export const PRIVATE_SERVICES = Object.freeze({});\n',
      }),
    );
    assert.equal(f.length, 1);
    assert.ok(f[0].includes('absent from PRIVATE_SERVICES'));
  });

  it('holds the unforked kit to an empty transport table', () => {
    const f = checkBindingAllowlist(
      appRoot({ 'wrangler.jsonc': JSON.stringify({ name: TEMPLATE_KEBAB, ...FLAGS }) }),
    );
    assert.ok(f.some((m) => m.includes('ships empty') && m.includes('PRIVATE_SERVICES')));
  });
});

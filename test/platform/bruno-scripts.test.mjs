// Pins the JS embedded in tools/bruno/cf-provisioning/*.bru — Bruno only parses a script
// block when the request RUNS, so a syntax error in a pre-request guard ships silently and
// surfaces as a broken provisioning session on the shared CIAL account. Run by `node --test`
// (imports node:fs), so it's a *.test.mjs picked up by `test:scripts`, like its siblings.
//
// Also pins the collection's contract. Per-app secrets are **per-Worker plain secrets**, not
// entries in the shared account Secrets Store; only fleet-shared secrets still go to the store
// (08/09). The load-bearing properties:
//
//   1. 06/07/07b target the per-Worker secrets endpoint, and every write is gated on a fresh
//      05 verdict for that NAME on that WORKER. 05 fails closed: a denied list is "unknown",
//      never "free", and a successful write flips the verdict so it cannot run twice.
//   2. 05b (placeholder Worker for a NEW app) runs only on 05's "this exact Worker is missing"
//      verdict — the same PUT against an existing Worker replaces that app's code.
//   3. 03/03a/03b mirror scripts/provision.mjs exactly, and 03b is read-modify-write behind
//      03a: the fleet gateway's non-kit settings survive a repair.
//   4. Secret values come from .env keyed by their target, never from an unkeyed variable.
//   5. 09 refuses a name that is not fleet-shared, using its OWN handshake variables.
//
// Where a rule is a security gate, the test RUNS the script against a minimal stand-in for
// Bruno's script runtime (runScript below) instead of only matching its text.
import { strict as assert } from 'node:assert';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { TEMPLATE_CONSTANT } from '../../scripts/new-app.mjs';

// The kit's canonical gateway settings. Imported lazily, inside the suite: a fork that adopts
// this test tree without tools/ skips the suite, and must not need a provision.mjs that
// matches this file's imports to do so.
const provision = () => import('../../scripts/provision.mjs');

const COLLECTION = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'tools',
  'bruno',
  'cf-provisioning',
);

const JS_BLOCKS = ['script:pre-request', 'script:post-response', 'tests'];

// The fleet-shared Secrets Store prefix the collection allows, from the template's one definition:
// a renamed app keeps this file, and its residual scan flags the name written out.
const SHARED_PREFIX = `${TEMPLATE_CONSTANT}_`;
const SHARED_NAME = `${SHARED_PREFIX}X`;
const VALUE_KEY = `SHARED_SECRET_VALUE__${SHARED_NAME}`;

const WORKER_SECRETS_URL =
  '{{baseUrl}}/accounts/{{accountId}}/workers/scripts/{{scriptName}}/secrets';

// Every per-Worker secret writer. 06/07 each own one binding; 07b writes any OTHER name.
const WRITERS = [
  '06-store-ai-gateway-token.bru',
  '07-store-anthropic-api-key.bru',
  '07b-set-worker-secret.bru',
];
const PINNED_WRITERS = [
  ['06-store-ai-gateway-token.bru', 'AI_GATEWAY_TOKEN'],
  ['07-store-anthropic-api-key.bru', 'ANTHROPIC_API_KEY'],
];

// The lowercase Worker-name rule 02/04/05b apply to "app" (wrangler.jsonc "name", not the repo).
const WORKER_NAME_RULE = '/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(app)';

// Built at runtime so no literal here looks like a real key to a secret scanner.
const FAKE_ANTHROPIC_KEY = `sk-ant-api03-${'k'.repeat(95)}`;

function read(file) {
  return readFileSync(join(COLLECTION, file), 'utf8');
}

function bruFiles() {
  return readdirSync(COLLECTION).filter((f) => f.endsWith('.bru'));
}

// The single `url:` line inside the method block — pinning it is how we tell "writes onto the
// app's own Worker" from "writes into the shared account store" without tripping over the words
// `secrets_store_secrets`, which the writers legitimately mention in their 10053 remedy.
function requestUrl(src) {
  const m = /^\s*url:\s*(.+)$/m.exec(src);
  return m ? m[1].trim() : '';
}

// Extract `<name> { ... }` by brace counting. Good enough for this collection: its scripts
// hold only balanced braces; an unbalanced brace in a string would make the extracted text
// fail to parse, which fails the test loudly — fail-closed is the point.
function extractBlock(src, name) {
  const start = src.indexOf(`${name} {`);
  if (start === -1) return null;
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(src.indexOf('{', start) + 1, i);
  }
  throw new Error(`${name}: unbalanced braces`);
}

// Runs one script block against a minimal stand-in for Bruno's script runtime: environment
// variables, runtime variables, process env (.env), req.setBody and res. That is the whole
// surface these scripts use. A refusal is a thrown Error, so callers assert its message — a
// ReferenceError from a missing stand-in would not match and fails the test.
function runScript(file, block, { env = {}, vars = {}, processEnv = {}, res } = {}) {
  const out = { vars: { ...vars }, body: undefined, logs: [], error: null };
  const bru = {
    getEnvVar: (k) => env[k],
    getVar: (k) => out.vars[k],
    setVar: (k, v) => {
      out.vars[k] = v;
    },
    getProcessEnv: (k) => processEnv[k],
  };
  const req = {
    setBody: (b) => {
      out.body = b;
    },
  };
  const log = { log: (...args) => out.logs.push(args.join(' ')) };
  try {
    new Function('bru', 'req', 'res', 'console', extractBlock(read(file), block))(
      bru,
      req,
      res,
      log,
    );
  } catch (e) {
    out.error = e.message;
  }
  return out;
}

const okRes = (result) => ({ getStatus: () => 200, body: { success: true, errors: [], result } });
const errRes = (status, code) => ({
  getStatus: () => status,
  body: { success: false, errors: [{ code, message: 'synthetic' }], result: null },
});

// The names in a `const SERVER_MANAGED = [...]` list (03a and 03b each carry one).
function serverManagedList(src) {
  const m = /const SERVER_MANAGED = \[([^\]]*)\]/.exec(src);
  assert.ok(m, 'no SERVER_MANAGED list');
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

// Forks carry no tools/ — it is platform-maintainer content, deliberately not adopted on
// /kit-upgrade (same reason ci.yml's plugin-mirror step is hashFiles-guarded). Self-skip
// instead of throwing at readdirSync, so a fork adopting the kit's test tree wholesale
// keeps this file harmlessly — three forks in the AICOE-484 wave had to hand-drop it.
describe('bruno cf-provisioning script blocks', {
  skip: !existsSync(COLLECTION) && 'tools/bruno absent (fork) — kit-only pins',
}, () => {
  it('every JS block in every .bru file parses', () => {
    for (const file of bruFiles()) {
      const src = read(file);
      for (const name of JS_BLOCKS) {
        const body = extractBlock(src, name);
        if (body === null) continue;
        // Parse-only (never executed): the same surface Bruno hands these blocks.
        assert.doesNotThrow(
          () => new Function('bru', 'req', 'res', 'console', 'expect', 'test', body),
          `${file} ${name} does not parse`,
        );
      }
    }
  });

  it('only numbered provisioning steps live here, each with its own seq, in file order', () => {
    // The folder IS the run order. Ad-hoc requests dropped in here once collided on seq with
    // 08/09 and put a cert-signing write and a zone-wide REPLACE inside "Run Collection" reach.
    const requests = bruFiles()
      .filter((f) => f !== 'collection.bru')
      .sort();
    const strays = requests.filter((f) => !/^\d\d[a-z]?-[a-z0-9-]+\.bru$/.test(f));
    assert.deepEqual(strays, [], 'every request must be a numbered step (NN- or NNx-)');
    const seqs = requests.map((f) => Number(/^\s*seq:\s*(\d+)/m.exec(read(f))?.[1]));
    assert.ok(seqs.every(Number.isInteger), 'every request needs a seq');
    assert.deepEqual(
      seqs,
      [...seqs].sort((a, b) => a - b),
      'seq order must follow file order',
    );
    assert.equal(new Set(seqs).size, seqs.length, 'seq values must be unique');
  });

  it('01 resolves AI Gateway READ for the deploy token — no live line pairs it with Edit/Write', () => {
    // DECISIONS 2026-08-28: the gateway is fleet-shared, so Edit on a per-app deploy token
    // is fleet-wide blast radius (one leaked CI token could delete or de-authenticate it
    // for every app). STRUCTURAL, not literal: any non-comment line mentioning "ai gateway"
    // together with edit/write re-arms the hazard whatever the regex spelling — including
    // an Edit entry added ALONGSIDE the Read one while debugging a MISS.
    const one = read('01-lookup-permission-groups.bru');
    assert.ok(
      /\/\^ai gateway read/i.test(one),
      '01 must resolve the Read permission group into the deploy-token policy',
    );
    const offenders = one
      .split('\n')
      .filter((l) => !l.trim().startsWith('//'))
      .filter((l) => /ai gateway/i.test(l) && /(edit|write)/i.test(l));
    assert.deepEqual(offenders, [], 'no live 01 line may pair AI Gateway with Edit/Write');
  });

  it('03/03a/03b act on the FLEET gateway id, never a per-app name', () => {
    // The gateway is fleet-shared (`all-pr-apps` — Cloudflare caps AI Gateways at
    // ~20/account; per-app attribution rides cf-aig-metadata, DECISIONS 2026-08-28).
    // A regression back to {{app}} here would quietly recreate a gateway per fork.
    const three = read('03-create-ai-gateway.bru');
    assert.match(three, /"id":\s*"\{\{gatewayId\}\}"/, '03 must create the fleet gateway');
    assert.ok(!three.includes('"id": "{{app}}"'), '03 must not create per-app gateways');
    for (const file of ['03a-check-fleet-gateway.bru', '03b-ensure-gateway-authenticated.bru']) {
      assert.match(
        requestUrl(read(file)),
        /\/ai-gateway\/gateways\/\{\{gatewayId\}\}$/,
        `${file} must target the fleet gateway`,
      );
    }
    assert.match(read('03a-check-fleet-gateway.bru'), /^get \{/m, '03a must be a read');
    // All three guard on the env var actually set in environments/cial.bru.
    const envFile = readFileSync(join(COLLECTION, 'environments', 'cial.bru'), 'utf8');
    assert.match(envFile, /gatewayId:\s*all-pr-apps/, 'cial env must pin the fleet id');
  });

  it('03 creates exactly aiGatewayCreatePayload(); 03a checks exactly aiGatewayDrift()s fields', async () => {
    // The kit side is canonical. If provision.mjs changes its settings, these go red here
    // instead of the collection quietly drifting from it.
    const { aiGatewayCreatePayload, aiGatewayDrift } = await provision();
    const body = extractBlock(read('03-create-ai-gateway.bru'), 'body:json');
    assert.deepEqual(
      JSON.parse(body.replace('{{gatewayId}}', 'all-pr-apps')),
      aiGatewayCreatePayload('all-pr-apps'),
    );

    const check = (live) =>
      runScript('03a-check-fleet-gateway.bru', 'script:post-response', {
        env: { gatewayId: 'all-pr-apps' },
        res: okRes(live),
      });
    const canonical = aiGatewayCreatePayload('all-pr-apps');
    const clean = check(canonical);
    assert.equal(clean.error, null);
    assert.equal(clean.vars.gatewayDrift, '', 'a canonical gateway has no drift');
    assert.equal(clean.vars.gatewayCheckedId, 'all-pr-apps');
    // The same five fields provision verifies — each one, flipped, is drift; nothing else is.
    const fields = aiGatewayDrift({}).map((d) => d.split('=')[0]);
    assert.equal(fields.length, 5);
    for (const k of fields) {
      const flipped = check({ ...canonical, [k]: 'drifted' });
      assert.match(flipped.vars.gatewayDrift, new RegExp(`^${k}=`), `03a must flag ${k}`);
    }
    assert.equal(check({ ...canonical, rate_limiting_technique: 'sliding' }).vars.gatewayDrift, '');

    // A failed read leaves no snapshot behind, so 03b has nothing stale to act on.
    const failed = runScript('03a-check-fleet-gateway.bru', 'script:post-response', {
      env: { gatewayId: 'all-pr-apps' },
      vars: { gatewayLive: '{"stale":true}', gatewayCheckedId: 'all-pr-apps' },
      res: errRes(404, 7002),
    });
    assert.equal(failed.vars.gatewayLive, '');
    assert.equal(failed.vars.gatewayCheckedId, '');
  });

  it('03b is read-modify-write: needs a fresh 03a with drift, carries every non-server field', async () => {
    const { aiGatewayCreatePayload } = await provision();
    const threeA = read('03a-check-fleet-gateway.bru');
    const threeB = read('03b-ensure-gateway-authenticated.bru');
    assert.deepEqual(
      serverManagedList(threeB),
      serverManagedList(threeA),
      '03a and 03b must agree on what is server-managed',
    );
    // 03a's KIT_MANAGED is what it tells the operator 03b will OVERWRITE — it must be exactly the
    // kit payload, or 03a lists a field as "preserved" that 03b then forces.
    const kitManaged = /const KIT_MANAGED = \[([^\]]*)\]/.exec(threeA);
    assert.ok(kitManaged, '03a has no KIT_MANAGED list');
    const { id: _kitId, ...kitPayload } = aiGatewayCreatePayload('all-pr-apps');
    assert.deepEqual(
      [...kitManaged[1].matchAll(/'([^']+)'/g)].map((x) => x[1]).sort(),
      Object.keys(kitPayload).sort(),
      '03a KIT_MANAGED must equal aiGatewayCreatePayload() minus id',
    );
    assert.match(threeB, /getVar\('gatewayLive'\)/, '03b must build from the 03a snapshot');

    const env = { gatewayId: 'all-pr-apps' };
    const live = {
      ...aiGatewayCreatePayload('all-pr-apps'),
      cache_ttl: 300,
      dlp: { enabled: true, action: 'BLOCK' },
      zdr: true,
      log_management: 100000,
      log_management_strategy: 'DELETE_OLDEST',
      store_id: 'store-123',
      // A field no kit list knows about — Cloudflare adds them. A repair must carry it, not reset it.
      some_future_setting: { enabled: true, rules: [1] },
      logpush_public_key: null,
      account_tag: 'acct-fixture',
      is_default: false,
      created_at: '2026-08-28T00:00:00Z',
      modified_at: '2026-10-08T09:31:00Z',
    };
    const fresh = {
      gatewayLive: JSON.stringify(live),
      gatewayCheckedId: 'all-pr-apps',
      gatewayDrift: 'cache_ttl=300 (want 0)',
    };
    const repair = (vars) =>
      runScript('03b-ensure-gateway-authenticated.bru', 'script:pre-request', { env, vars });

    assert.match(repair({}).error, /Run "03a/, 'no 03a, no write');
    assert.match(
      repair({ ...fresh, gatewayCheckedId: 'another-gateway' }).error,
      /Run "03a/,
      'a snapshot of another gateway is not a snapshot of this one',
    );
    assert.match(repair({ ...fresh, gatewayDrift: '' }).error, /no drift/, 'no drift, no write');

    const { error, body } = repair(fresh);
    assert.equal(error, null);
    const { id: _id, ...kitFields } = aiGatewayCreatePayload('all-pr-apps');
    for (const [k, v] of Object.entries(kitFields)) {
      assert.deepEqual(body[k], v, `03b must force kit field ${k}`);
    }
    for (const k of [
      'dlp',
      'zdr',
      'log_management',
      'log_management_strategy',
      'store_id',
      'some_future_setting',
    ]) {
      assert.deepEqual(body[k], live[k], `03b must carry ${k} over unchanged`);
    }
    for (const k of ['id', 'account_tag', 'is_default', 'created_at', 'modified_at']) {
      assert.ok(!(k in body), `03b must not send read-only field ${k}`);
    }
    assert.ok(!('logpush_public_key' in body), 'a null is already unset — not sent back');
  });

  it('05/06/07/07b act on the per-Worker secrets endpoint, not the shared store', () => {
    // The migration in one assertion. If a writer ever points back at
    // /secrets_store/stores/... it is consuming an account-wide slot again.
    assert.equal(requestUrl(read('05-check-secret-absent.bru')), WORKER_SECRETS_URL);
    for (const file of WRITERS) {
      const src = read(file);
      assert.equal(requestUrl(src), WORKER_SECRETS_URL, `${file} must write onto the Worker`);
      assert.match(src, /^put \{/m, `${file} must PUT the per-Worker secret`);
      assert.ok(src.includes("type: 'secret_text'"), `${file} must send type secret_text`);
    }
  });

  it('05 records the name AND the Worker its free-verdict was for; every writer enforces both', () => {
    const five = read('05-check-secret-absent.bru');
    assert.match(five, /setVar\('secretCheckedName', secretName\)/);
    assert.match(five, /setVar\('secretCheckedScript', scriptName\)/);
    for (const file of WRITERS) {
      const src = read(file);
      assert.match(src, /getVar\('secretCheckedName'\)/, `${file} must check the 05 name`);
      assert.match(src, /getVar\('secretCheckedScript'\)/, `${file} must check the 05 Worker`);
    }
  });

  it('05 fails closed: a non-200 list is "unknown", never "free"', () => {
    // main once set "no" (= free) when the list call was DENIED: a token without Workers
    // Scripts access then authorized a blind write.
    assert.match(read('05-check-secret-absent.bru'), /res\.getStatus\(\) !== 200/);
    const env = { scriptName: 'demo-staging', secretName: 'AI_GATEWAY_TOKEN' };
    const list = (res, vars) =>
      runScript('05-check-secret-absent.bru', 'script:post-response', { env, vars, res });

    for (const status of [401, 403, 429, 500]) {
      const r = list(errRes(status, 10000), { secretExists: 'no', workerMissing: 'demo-staging' });
      assert.equal(r.vars.secretExists, 'unknown', `${status} must not read as free`);
      assert.equal(r.vars.workerMissing, '', `${status} must not authorize 05b`);
    }
    // Only a 404 with code 10007 ("This Worker does not exist") marks THIS Worker missing.
    const missing = list(errRes(404, 10007));
    assert.equal(missing.vars.secretExists, 'unknown');
    assert.equal(missing.vars.workerMissing, 'demo-staging');
    assert.equal(list(errRes(404, 7003)).vars.workerMissing, '');

    const taken = list(okRes([{ name: 'AI_GATEWAY_TOKEN' }]), { workerMissing: 'demo-staging' });
    assert.equal(taken.vars.secretExists, 'yes');
    assert.equal(taken.vars.workerMissing, '');
    const free = list(okRes([{ name: 'ANTHROPIC_API_KEY' }]));
    assert.equal(free.vars.secretExists, 'no');
    assert.equal(free.vars.secretCheckedName, 'AI_GATEWAY_TOKEN');
    assert.equal(free.vars.secretCheckedScript, 'demo-staging');
  });

  it('each pinned writer cross-checks its own binding name; every writer pins the Worker to the app', () => {
    // The naming cross-check INVERTED at the migration. A per-Worker secret's name IS the
    // binding name — plain AI_GATEWAY_TOKEN / ANTHROPIC_API_KEY, no app prefix, because the
    // Worker is the namespace. So the old `app.toUpperCase().split('-').join('_')` store
    // formula is gone, and the app-identity check it used to carry moved onto scriptName:
    // that is now the only variable saying which app — and which environment — is written.
    for (const [file, binding] of PINNED_WRITERS) {
      assert.ok(
        read(file).includes(`if (secretName !== '${binding}')`),
        `${file} must cross-check secretName against ${binding}`,
      );
    }
    for (const file of WRITERS) {
      const src = read(file);
      assert.ok(
        src.includes("scriptName !== app && scriptName !== app + '-staging'"),
        `${file} must pin scriptName to the app's prod or staging Worker`,
      );
      assert.ok(
        !src.includes("app.toUpperCase().split('-').join('_')"),
        `${file} still derives the old store-prefixed name`,
      );
    }
  });

  it('every writer carries the 10053 diagnosis', () => {
    // "Binding name already in use" is the expected failure against an app whose wrangler
    // config still binds a Secrets Store secret of that name. The fix is a different PR, not a
    // retry — 06/07 name the migration PR, 07b (any name, any binding type) the binding.
    for (const file of WRITERS) {
      const src = read(file);
      assert.match(src, /e\.code === 10053/, `${file} must detect error 10053`);
      assert.match(src, /Binding name already in use/, `${file} must name the 10053 error`);
    }
    for (const [file] of PINNED_WRITERS) {
      assert.match(read(file), /secrets-migration alignment PR/, `${file} must give the remedy`);
    }
    assert.match(read('07b-set-worker-secret.bru'), /remove that binding from the app wrangler/);
  });

  it('a successful write flips the free verdict, so the same write cannot run twice', () => {
    const env = { app: 'demo', scriptName: 'demo-staging', secretName: 'X' };
    for (const file of WRITERS) {
      const r = runScript(file, 'script:post-response', {
        env,
        vars: { secretExists: 'no' },
        res: okRes({ name: 'X', type: 'secret_text' }),
      });
      assert.equal(r.error, null);
      assert.equal(r.vars.secretExists, 'yes', `${file} must flip the 05 verdict`);
    }
    const nine = runScript('09-store-shared-secret.bru', 'script:post-response', {
      vars: { storeSecretExists: 'no' },
      res: okRes([{ name: SHARED_NAME, id: 'id', status: 'active' }]),
    });
    assert.equal(nine.vars.storeSecretExists, 'yes', '09 must flip the 08 verdict');
  });

  it('a verdict for another Worker is reported as stale — never as "already set" on this one', () => {
    // After a write on <app>-staging flips the verdict to "yes", flipping scriptName to <app>
    // without re-running 05 must say "re-run 05", not claim prod already has the secret.
    for (const file of WRITERS) {
      // 06/07 only accept their own binding name; 07b takes any other.
      const name = PINNED_WRITERS.find(([f]) => f === file)?.[1] ?? 'X';
      const r = runScript(file, 'script:pre-request', {
        env: { app: 'demo', scriptName: 'demo', secretName: name },
        vars: {
          secretExists: 'yes',
          secretCheckedName: name,
          secretCheckedScript: 'demo-staging',
          aiGatewayToken: 'gw',
        },
        processEnv: {
          ANTHROPIC_API_KEY_VALUE__demo: FAKE_ANTHROPIC_KEY,
          WORKER_SECRET__demo__X: 'v',
        },
      });
      assert.match(r.error, /Request 05 last checked/, `${file} must report the stale verdict`);
      assert.doesNotMatch(r.error, /ALREADY SET/, `${file} must not claim the secret is set`);
    }
    // A "free" verdict with no record of what it was for authorizes nothing.
    const orphan = runScript('07b-set-worker-secret.bru', 'script:pre-request', {
      env: { app: 'demo', scriptName: 'demo-staging', secretName: 'X' },
      vars: { secretExists: 'no' },
      processEnv: { 'WORKER_SECRET__demo-staging__X': 'v' },
    });
    assert.match(orphan.error, /Request 05 last checked "\(nothing\)"/);
  });

  it('a write refused for want of a Worker points at the new-app path (05b/05c)', () => {
    for (const file of WRITERS) {
      const src = read(file);
      assert.ok(src.includes('New app: 05b creates'), `${file} must name 05b for a 404`);
      assert.ok(src.includes('05c turns workers.dev off'), `${file} must name 05c for a 404`);
    }
  });

  it('07 reads the key keyed to THIS app, never an unkeyed name, never ANTHROPIC_API_KEY', () => {
    const seven = read('07-store-anthropic-api-key.bru');
    assert.ok(seven.includes("const envKey = 'ANTHROPIC_API_KEY_VALUE__' + app;"));
    assert.match(seven, /getProcessEnv\(envKey\)/);
    // A shell-exported personal dev key must never be pushable by accident, and neither may
    // the old unkeyed line (a key left over from the last app would land on this one).
    assert.ok(!seven.includes("getProcessEnv('ANTHROPIC_API_KEY')"));
    assert.ok(!seven.includes("getProcessEnv('ANTHROPIC_API_KEY_VALUE')"));

    const env = { app: 'demo', scriptName: 'demo-staging', secretName: 'ANTHROPIC_API_KEY' };
    const vars = {
      secretExists: 'no',
      secretCheckedName: 'ANTHROPIC_API_KEY',
      secretCheckedScript: 'demo-staging',
    };
    const write = (processEnv) =>
      runScript('07-store-anthropic-api-key.bru', 'script:pre-request', { env, vars, processEnv });
    for (const processEnv of [
      { 'ANTHROPIC_API_KEY_VALUE__other-app': FAKE_ANTHROPIC_KEY },
      { ANTHROPIC_API_KEY_VALUE: FAKE_ANTHROPIC_KEY },
      { ANTHROPIC_API_KEY: FAKE_ANTHROPIC_KEY },
    ]) {
      assert.match(write(processEnv).error, /No Anthropic key for "demo"/);
    }
    const ok = write({ ANTHROPIC_API_KEY_VALUE__demo: FAKE_ANTHROPIC_KEY });
    assert.equal(ok.error, null);
    assert.deepEqual(ok.body, {
      name: 'ANTHROPIC_API_KEY',
      text: FAKE_ANTHROPIC_KEY,
      type: 'secret_text',
    });
  });

  it('07b writes any other per-Worker secret, from a line keyed by Worker AND name', () => {
    const seven = read('07b-set-worker-secret.bru');
    assert.ok(seven.includes("const envKey = 'WORKER_SECRET__' + scriptName + '__' + secretName;"));

    const free = (scriptName, secretName) => ({
      secretExists: 'no',
      secretCheckedName: secretName,
      secretCheckedScript: scriptName,
    });
    const write = (scriptName, secretName, value, extra = {}) =>
      runScript('07b-set-worker-secret.bru', 'script:pre-request', {
        env: { app: 'demo', scriptName, secretName },
        vars: { ...free(scriptName, secretName), ...extra.vars },
        processEnv: {
          CF_BOOTSTRAP_TOKEN: 'bootstrap-credential',
          [`WORKER_SECRET__${scriptName}__${secretName}`]: value,
          ...extra.processEnv,
        },
      });

    const ok = write('demo-staging', 'UPSTREAM_TOKEN', 'v1');
    assert.equal(ok.error, null);
    assert.deepEqual(ok.body, { name: 'UPSTREAM_TOKEN', text: 'v1', type: 'secret_text' });
    // Raw login links at rest: staging only, never on the production Worker.
    assert.match(write('demo', 'MAGIC_LINK_OUTBOX', 'x').error, /staging-only/);
    assert.equal(write('demo-staging', 'MAGIC_LINK_OUTBOX', 'x').error, null);

    for (const [name, why] of [
      ['AI_GATEWAY_TOKEN', /its own writer/],
      ['ANTHROPIC_API_KEY', /its own writer/],
      ['PAVED_ROAD_ALERT_WEBHOOK_URL', /FLEET-SHARED/],
      ['ALERT_WEBHOOK_URL', /FLEET-SHARED/],
      ['TURNSTILE_SECRET', /FLEET-SHARED/],
      ['ENTRA_CLIENT_SECRET', /FLEET-SHARED/],
      ['REGISTRY_TOKEN', /FLEET-SHARED/],
      ['paved_road_intercom_token', /FLEET-SHARED/],
      ['SEAL_KEY', /sensitive-data-key\.md/],
      ['not-a-binding', /not a valid binding name/],
    ]) {
      assert.match(write('demo-staging', name, 'v').error ?? '', why, `07b must refuse ${name}`);
    }
    // The collection's own credentials, under any name.
    assert.match(write('demo-staging', 'X', 'bootstrap-credential').error, /bootstrap credential/);
    assert.match(
      write('demo-staging', 'X', 'deploy-token', { vars: { deployToken: 'deploy-token' } }).error,
      /deploy token/,
    );
    assert.match(
      write('demo-staging', 'X', 'gw-token', { vars: { aiGatewayToken: 'gw-token' } }).error,
      /AI Gateway token/,
    );
    // 5 KB, counted in UTF-8 bytes (2000 × "€" = 6000 bytes, 2000 characters).
    assert.match(write('demo-staging', 'X', '€'.repeat(2000)).error, /6000 bytes/);
    // A line keyed to the other Worker is never read.
    const crossed = runScript('07b-set-worker-secret.bru', 'script:pre-request', {
      env: { app: 'demo', scriptName: 'demo', secretName: 'X' },
      vars: free('demo', 'X'),
      processEnv: { 'WORKER_SECRET__demo-staging__X': 'staging-value' },
    });
    assert.match(crossed.error, /No value for X on demo/);
  });

  it('02/04/05b refuse an "app" that is not a lowercase Worker name', () => {
    for (const file of [
      '02-create-deploy-token.bru',
      '04-create-ai-gateway-token.bru',
      '05b-create-placeholder-worker.bru',
    ]) {
      assert.ok(read(file).includes(WORKER_NAME_RULE), `${file} must check the Worker name`);
      const r = runScript(file, 'script:pre-request', {
        env: { app: 'il-Lingua-paved', scriptName: 'il-Lingua-paved-staging' },
      });
      assert.match(r.error, /Worker base name/, `${file} must refuse a repo-style name`);
    }
  });

  it('02 prints the gh commands — the token is never on a command line', () => {
    const mint = (githubRepo) =>
      runScript('02-create-deploy-token.bru', 'script:post-response', {
        env: { githubRepo },
        res: okRes({ id: 'tok-id', name: 'demo provisioning token', value: 'TOKEN-VALUE' }),
      });
    for (const repo of ['CialDNB/demo', 'https://github.com/CialDNB/demo.git']) {
      const { logs } = mint(repo);
      assert.ok(logs.includes('     gh secret set CLOUDFLARE_API_TOKEN --repo CialDNB/demo'));
      assert.ok(
        logs.includes('     gh variable set DEPLOY_ENABLED --body true --repo CialDNB/demo'),
      );
      for (const l of logs.filter((x) => x.includes('gh '))) {
        assert.ok(!l.includes('TOKEN-VALUE'), 'the token value must never ride a gh command');
      }
    }
    assert.ok(mint('SET-ME').logs.some((l) => l.endsWith('--repo CialDNB/<repo>')));
  });

  it('05b creates only a Worker 05 proved missing, as a multipart upload with a secret-free URL', () => {
    const src = read('05b-create-placeholder-worker.bru');
    // The URL names the Worker and nothing else — no credential, no process.env.
    assert.equal(
      requestUrl(src),
      '{{baseUrl}}/accounts/{{accountId}}/workers/scripts/{{scriptName}}?excludeScript=true',
    );
    assert.match(src, /^put \{/m);
    // The collection header says application/json, which makes Bruno skip multipart encoding;
    // 05b must carry its own (Bruno then appends the boundary).
    assert.equal(extractBlock(src, 'headers').trim(), 'Content-Type: multipart/form-data');
    const form = extractBlock(src, 'body:multipart-form')
      .trim()
      .split('\n')
      .map((l) => l.trim());
    assert.deepEqual(form, [
      'metadata: {"main_module":"placeholder.mjs","bindings":[]} @contentType(application/json)',
      'placeholder.mjs: @file(placeholder.mjs) @contentType(application/javascript+module)',
    ]);
    // The only key is 05's "missing" verdict for THIS Worker — and it is single-use.
    assert.match(src, /bru\.getVar\('workerMissing'\) !== scriptName/);
    const env = { app: 'demo', scriptName: 'demo-staging' };
    const create = (vars) =>
      runScript('05b-create-placeholder-worker.bru', 'script:pre-request', { env, vars });
    for (const vars of [{}, { workerMissing: '' }, { workerMissing: 'demo' }]) {
      assert.match(create(vars).error, /proved MISSING/, 'no matching 404 verdict, no PUT');
    }
    assert.equal(create({ workerMissing: 'demo-staging' }).error, null);
    const other = runScript('05b-create-placeholder-worker.bru', 'script:pre-request', {
      env: { app: 'demo', scriptName: 'other-app-staging' },
      vars: { workerMissing: 'other-app-staging' },
    });
    assert.match(other.error, /neither "demo" nor "demo-staging"/);
    const after = runScript('05b-create-placeholder-worker.bru', 'script:post-response', {
      env,
      vars: { workerMissing: 'demo-staging' },
      res: errRes(400, 10021),
    });
    assert.equal(after.vars.workerMissing, '', 'the verdict is spent whatever the outcome');
  });

  it('placeholder.mjs answers 503 and reads nothing', async () => {
    const mod = await import(pathToFileURL(join(COLLECTION, 'placeholder.mjs')).href);
    assert.equal(mod.default.fetch.length, 0, 'the placeholder takes no env, binds nothing');
    const res = mod.default.fetch();
    assert.equal(res.status, 503);
    assert.equal(res.headers.get('cache-control'), 'no-store');
  });

  it('05c switches workers.dev AND preview URLs off, the way wrangler deploy does', () => {
    const src = read('05c-disable-workers-dev.bru');
    assert.equal(
      requestUrl(src),
      '{{baseUrl}}/accounts/{{accountId}}/workers/scripts/{{scriptName}}/subdomain',
    );
    assert.match(src, /^post \{/m);
    assert.deepEqual(JSON.parse(extractBlock(src, 'body:json')), {
      enabled: false,
      previews_enabled: false,
    });
    assert.equal(
      extractBlock(src, 'headers').trim(),
      'Cloudflare-Workers-Script-Api-Date: 2025-08-01',
    );
    assert.ok(src.includes("scriptName !== app && scriptName !== app + '-staging'"));
  });

  it('08 fails closed too: a failed store list never reads as free', () => {
    const r = runScript('08-list-store-and-quota.bru', 'script:post-response', {
      env: { secretName: SHARED_NAME, storeId: 'store' },
      vars: { storeSecretExists: 'no', storeCheckedName: SHARED_NAME },
      res: errRes(403, 10000),
    });
    assert.equal(r.vars.storeSecretExists, 'unknown');
    assert.equal(r.vars.storeCheckedName, '');
    const listed = runScript('08-list-store-and-quota.bru', 'script:post-response', {
      env: { secretName: SHARED_NAME, storeId: 'store' },
      res: okRes([{ name: 'REGISTRY_TOKEN', id: 'a' }]),
    });
    assert.equal(listed.vars.storeSecretExists, 'no');
    assert.equal(listed.vars.storeCheckedName, SHARED_NAME);
  });

  it('09 writes to the store, refuses non-shared names, and keeps its own handshake', () => {
    const nine = read('09-store-shared-secret.bru');
    assert.match(requestUrl(nine), /\/secrets_store\/stores\//);
    assert.ok(
      nine.includes(`indexOf('${SHARED_PREFIX}') === 0`),
      '09 must allow the shared prefix',
    );
    assert.ok(nine.includes("'REGISTRY_TOKEN'"), '09 must allowlist REGISTRY_TOKEN');
    assert.ok(nine.includes("'paved_road_intercom_token'"), '09 must allowlist the intercom token');
    // The comment ritual survives the migration on the store path only: a per-Worker secret is
    // attributable by the Worker it sits on, a store secret by nothing but its comment.
    assert.match(nine, /secretComment/);
    // Its own verdict variables. A "free" verdict about a per-Worker secret must never
    // authorize a write into the account-wide store.
    assert.match(nine, /getVar\('storeSecretExists'\)/);
    assert.match(nine, /getVar\('storeCheckedName'\)/);
    assert.ok(!nine.includes("getVar('secretCheckedName')"), '09 must not reuse 05s verdict');
    assert.ok(!nine.includes("getVar('secretExists')"), '09 must not reuse 05s verdict');
    // The value is keyed by NAME: a leftover line for another shared secret is never read.
    assert.ok(nine.includes("const envKey = 'SHARED_SECRET_VALUE__' + secretName;"));
    const write = (processEnv) =>
      runScript('09-store-shared-secret.bru', 'script:pre-request', {
        env: { secretName: SHARED_NAME, secretComment: 'fleet-shared test value' },
        vars: { storeSecretExists: 'no', storeCheckedName: SHARED_NAME },
        processEnv,
      });
    assert.ok(write({ SHARED_SECRET_VALUE: 'v' }).error.includes(`No value for ${SHARED_NAME}`));
    assert.match(write({ [`SHARED_SECRET_VALUE__${SHARED_PREFIX}Y`]: 'v' }).error, /No value/);
    // 1024 BYTES, counted in UTF-8 (600 × "€" = 1800 bytes, 600 characters).
    assert.match(write({ [VALUE_KEY]: '€'.repeat(600) }).error, /1800 bytes/);
    // The collection's own credentials never land in a store every Worker can bind.
    for (const [vars, why] of [
      [{ deployToken: 'tok' }, /deploy token/],
      [{ aiGatewayToken: 'tok' }, /AI Gateway token/],
    ]) {
      const r = runScript('09-store-shared-secret.bru', 'script:pre-request', {
        env: { secretName: SHARED_NAME, secretComment: 'fleet-shared test value' },
        vars: { storeSecretExists: 'no', storeCheckedName: SHARED_NAME, ...vars },
        processEnv: { [VALUE_KEY]: 'tok' },
      });
      assert.match(r.error, why);
    }
    const ok = write({ [VALUE_KEY]: 'v' });
    assert.equal(ok.error, null);
    assert.deepEqual(ok.body, [
      { name: SHARED_NAME, value: 'v', scopes: ['workers'], comment: 'fleet-shared test value' },
    ]);
  });

  it('secret values live only in the gitignored .env — the environment holds none', () => {
    // environments/cial.bru is committed and edited in Bruno's UI. It once carried
    // vars:secret slots, and an unkeyed value there was pushed onto whichever app ran next.
    const envFile = readFileSync(join(COLLECTION, 'environments', 'cial.bru'), 'utf8');
    assert.ok(!envFile.includes('vars:secret'), 'no secret vars in the committed environment');
    assert.match(envFile, /githubRepo:\s*SET-ME/);
    for (const file of bruFiles()) {
      const src = read(file);
      for (const gone of ["getEnvVar('anthropicApiKey')", "getEnvVar('sharedSecretValue')"]) {
        assert.ok(!src.includes(gone), `${file} still reads ${gone}`);
      }
    }
    const ignore = read('.gitignore').split('\n');
    for (const line of ['.env', '.env.*', '!.env.example']) {
      assert.ok(ignore.includes(line), `.gitignore must carry ${line}`);
    }
  });
});

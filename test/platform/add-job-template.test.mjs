// Runs the /add-job step 4 template (.claude/skills/add-job/SKILL.md) as written, the way a fork
// copies it. Step 4's TypeScript blocks are type-stripped and imported next to stand-ins for the
// imports the template names (createLogger, field, sendAlert, runMyJob) and the kit's real
// rateLimit. A fork that follows step 4 gets exactly what these tests pin, so a template edit
// that pages on every failed run, whose liveness task turns the kit's own cron tests red, or that
// lets a job that never runs stay green, fails here and not in a fork. Plain node (node:test,
// node:module's stripTypeScriptTypes, a mocked Date), so it runs under `test:scripts`.
import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, afterEach, before, beforeEach, describe, it, mock } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** Step 4's fenced TypeScript blocks, dedented, in order. */
function stepFourBlocks(markdown) {
  const start = markdown.indexOf('4. **Schedule:**');
  const end = markdown.indexOf('5. **Tests**');
  assert.ok(start >= 0 && end > start, 'add-job SKILL.md: step 4 or step 5 heading not found');
  const fences = markdown.slice(start, end).matchAll(/^( *)```ts\n([\s\S]*?)^\1```$/gm);
  return [...fences].map(([, indent, body]) =>
    body
      .split('\n')
      .map((line) => line.slice(indent.length))
      .join('\n'),
  );
}

/** The KV prefixes seedDb (test/helpers/db.ts) clears before every kit test. */
function seedDbClearedPrefixes() {
  const db = readFileSync(join(REPO, 'test/helpers/db.ts'), 'utf8');
  const list = db.match(/for \(const prefix of \[([^\]]*)\]\)/);
  assert.ok(list, 'test/helpers/db.ts: the prefix list seedDb clears was not found');
  return [...list[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

/** An in-memory SESSIONS KV that honours expirationTtl against the (mocked) clock. */
function memoryKv() {
  const store = new Map();
  const live = (key) => {
    const entry = store.get(key);
    if (entry && entry.expiresAt !== null && Date.now() >= entry.expiresAt) store.delete(key);
    return store.get(key);
  };
  return {
    store,
    failing: false,
    async get(key) {
      if (this.failing) throw new Error('KV GET failed');
      return live(key)?.value ?? null;
    },
    async put(key, value, opts) {
      if (this.failing) throw new Error('KV PUT failed');
      const ttl = opts?.expirationTtl;
      store.set(key, { value: String(value), expiresAt: ttl ? Date.now() + ttl * 1000 : null });
    },
    async delete(key) {
      store.delete(key);
    },
  };
}

const harness = { logs: [], alerts: [], registry: null, runMyJob: null, sendAlert: null };
let template;
let dir;

before(async () => {
  const skill = readFileSync(join(REPO, '.claude/skills/add-job/SKILL.md'), 'utf8');
  const blocks = stepFourBlocks(skill);
  assert.ok(
    blocks.length >= 2,
    `expected step 4's handler and liveness blocks, got ${blocks.length}`,
  );
  const rateLimitTs = readFileSync(join(REPO, 'src/security/rateLimit.ts'), 'utf8');
  const source = [
    'const __h = globalThis.__addJobTemplateHarness;',
    'const createLogger = (registry) => { __h.registry = registry;',
    '  return (event, fields) => { __h.logs.push({ event, fields }); }; };',
    "const field = { err: { kind: 'error' } };",
    'const sendAlert = (env, failures) => __h.sendAlert(env, failures);',
    'const runMyJob = (env) => __h.runMyJob(env);',
    stripTypeScriptTypes(rateLimitTs),
    ...blocks.map((block) => stripTypeScriptTypes(block)),
  ].join('\n');
  globalThis.__addJobTemplateHarness = harness;
  dir = mkdtempSync(join(tmpdir(), 'add-job-template-'));
  const file = join(dir, 'myJob.mjs');
  writeFileSync(file, source);
  template = await import(pathToFileURL(file).href);
});

after(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  delete globalThis.__addJobTemplateHarness;
});

describe('/add-job step 4 template, run as written', () => {
  let env;
  const fail = async () => {
    throw new Error('upstream refused /v1/query?cpf=00000000000');
  };
  const ok = async () => {};
  const tick = (ms) => mock.timers.tick(ms);
  const events = () => harness.logs.map((l) => l.event);

  beforeEach(() => {
    mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 9, 21, 9, 0, 0) });
    harness.logs = [];
    harness.alerts = [];
    harness.runMyJob = ok;
    harness.sendAlert = async (_env, failures) => {
      harness.alerts.push({ at: new Date().toISOString(), failures });
    };
    env = { SESSIONS: memoryKv() };
  });
  afterEach(() => mock.timers.reset());

  it('exports the names step 4 tells you to wire', () => {
    assert.equal(typeof template.runMyJobSafely, 'function');
    assert.equal(typeof template.checkMyJobLiveness, 'function');
    assert.equal(typeof template.MY_JOB_LAST_OK, 'string');
    assert.equal(typeof template.MY_JOB_STALE_HOURS, 'number');
  });

  describe('the handler', () => {
    it('one failed run right after a good one is logged and pages nobody', async () => {
      await template.runMyJobSafely(env);
      harness.runMyJob = fail;
      tick(15 * MINUTE);
      await template.runMyJobSafely(env);
      assert.ok(events().includes('my_job_failed'));
      assert.equal(harness.alerts.length, 0);
    });

    it('a 3 h outage of a */15 job pages once, not once a run', async () => {
      await template.runMyJobSafely(env);
      harness.runMyJob = fail;
      for (let run = 0; run < 12; run++) {
        tick(15 * MINUTE);
        await template.runMyJobSafely(env);
      }
      assert.equal(events().filter((e) => e === 'my_job_failed').length, 12);
      assert.equal(harness.alerts.length, 1);
      assert.equal(harness.alerts[0].failures[0].task, 'my_job');
    });

    it('a per-minute job down for two days pages at most once per UTC day', async () => {
      await template.runMyJobSafely(env);
      harness.runMyJob = fail;
      for (let run = 0; run < 2 * 24 * 60; run++) {
        tick(MINUTE);
        await template.runMyJobSafely(env);
      }
      const perDay = Map.groupBy(harness.alerts, (a) => a.at.slice(0, 10));
      assert.ok(harness.alerts.length >= 2, 'a two-day outage still pages');
      for (const [day, pages] of perDay) assert.equal(pages.length, 1, `pages on ${day}`);
    });

    it('a brand-new job whose first run fails gets the whole bar before it pages', async () => {
      harness.runMyJob = fail;
      await template.runMyJobSafely(env);
      tick(template.MY_JOB_STALE_HOURS * HOUR - MINUTE);
      await template.runMyJobSafely(env);
      assert.equal(harness.alerts.length, 0);
      tick(2 * MINUTE);
      await template.runMyJobSafely(env);
      assert.equal(harness.alerts.length, 1);
    });

    it('never rejects: not when the job throws, the page fails, or KV refuses every call', async () => {
      harness.runMyJob = fail;
      harness.sendAlert = async () => {
        throw new Error('alert path rejected');
      };
      await template.runMyJobSafely(env);
      tick(template.MY_JOB_STALE_HOURS * HOUR + MINUTE);
      await template.runMyJobSafely(env);
      assert.ok(events().includes('my_job_alert_failed'));

      env.SESSIONS.failing = true;
      harness.runMyJob = ok; // the job works, but its record cannot be written
      const before = harness.logs.length;
      await template.runMyJobSafely(env);
      assert.ok(events().slice(before).includes('my_job_failed'));
      // Every event goes through the app's own registry with the error as an error field, which
      // the logger reduces to its class (PIA C5): never the raw message.
      for (const { event, fields } of harness.logs) {
        assert.deepEqual(harness.registry[event]?.fields, { err: { kind: 'error' } }, event);
        assert.ok(fields.err instanceof Error, event);
      }
    });
  });

  describe('the liveness task', () => {
    it('passes on an empty KV, which is what every kit cron test runs with', async () => {
      // seedDb clears heartbeat: (and rl:) before each kit test, so a liveness task in TASKS sees
      // no record in cron.test.ts and appendOnlyTriggers.test.ts. It must not fail those runs, and
      // the purge-window test runs the loop twice in one test.
      assert.equal(typeof (await template.checkMyJobLiveness(env)), 'string');
      tick(MINUTE);
      assert.equal(typeof (await template.checkMyJobLiveness(env)), 'string');
    });

    it('pages at the next daily run when the job has never had a good run (trigger missing)', async () => {
      await template.checkMyJobLiveness(env); // the first daily run after the deploy
      tick(24 * HOUR);
      await assert.rejects(template.checkMyJobLiveness(env), /no good run/);
    });

    it('passes on a fresh record, and throws on a stale or garbled one', async () => {
      await template.runMyJobSafely(env);
      tick(template.MY_JOB_STALE_HOURS * HOUR - MINUTE);
      assert.equal(typeof (await template.checkMyJobLiveness(env)), 'string');
      tick(2 * MINUTE);
      await assert.rejects(template.checkMyJobLiveness(env), /no good run/);
      await env.SESSIONS.put(template.MY_JOB_LAST_OK, 'not a date');
      await assert.rejects(template.checkMyJobLiveness(env), /no good run/);
    });

    it('throws when KV refuses the read, so the loop pages', async () => {
      env.SESSIONS.failing = true;
      await assert.rejects(template.checkMyJobLiveness(env));
    });
  });

  it('writes only keys that seedDb clears, so the kit tests stay independent', async () => {
    harness.runMyJob = fail;
    await template.checkMyJobLiveness(env);
    await template.runMyJobSafely(env);
    tick(template.MY_JOB_STALE_HOURS * HOUR + MINUTE);
    await template.runMyJobSafely(env);
    harness.runMyJob = ok;
    await template.runMyJobSafely(env);
    const cleared = seedDbClearedPrefixes();
    assert.ok(env.SESSIONS.store.size > 0);
    for (const key of env.SESSIONS.store.keys()) {
      assert.ok(
        cleared.some((p) => key.startsWith(p)),
        `${key} survives seedDb (${cleared.join(', ')})`,
      );
    }
  });
});

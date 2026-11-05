// Pins scripts/provision.mjs — the plain-JS mirror of src/platform/naming.ts plus the AI
// Gateway create payload. Run by `node --test` (NOT vitest's Workers pool: provision.mjs
// imports node:fs), so it's a *.test.mjs, outside the `test/**/*.test.ts` glob.
//
// Why this file exists: the provision mirror had silently drifted from naming.ts (it omitted
// kvCache, r2Media, secretPrefix) and nothing pinned it. And the AI Gateway body was stale
// (the old { id, collect_logs } fails the create API with error 7001, so the gateway was
// never created). Both are contracts now.
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
// parseJsonc is the JSONC reader the bootstrap uses; reuse it to read the real wrangler configs
// (importing new-app.mjs is side-effect-free — its main() is guarded behind an argv check).
import { parseJsonc } from '../../scripts/new-app.mjs';
import {
  aiGatewayCreatePayload,
  aiGatewayDrift,
  BACKUP_LIFECYCLE_RULE_ID,
  BACKUP_PREFIX,
  backupRetentionDays,
  carriedFromResourcesMd,
  edgeRulesState,
  linearFromResourcesMd,
  renderResourcesMd,
  resourceNames,
  withBackupLifecycleRule,
} from '../../scripts/provision.mjs';

describe('provision resourceNames mirror', () => {
  it('matches the full naming scheme (incl. kvCache, r2Media, secretPrefix)', () => {
    // The same contract test/platform/naming.test.ts pins for src/platform/naming.ts —
    // if either drifts from this object, CI fails and the mirror must be re-synced.
    assert.deepEqual(resourceNames('arena-go'), {
      worker: 'arena-go',
      workerStaging: 'arena-go-staging',
      d1: 'arena-go-db',
      d1Staging: 'arena-go-db-staging',
      kvSessions: 'arena-go-sessions',
      kvSessionsStaging: 'arena-go-sessions-staging',
      kvCache: 'arena-go-cache',
      r2Backups: 'arena-go-backups',
      r2BackupsStaging: 'arena-go-backups-staging',
      r2Media: 'arena-go-media',
      // FLEET-SHARED (the one non-derived name): a drift back to a per-app id would
      // recreate a gateway per fork and re-hit the ~20/account cap. Must equal
      // naming.test.ts's pin of src/platform/naming.ts.
      aiGateway: 'all-pr-apps',
      dnsProd: 'arena-go.cialdnb.ai',
      dnsStaging: 'staging-arena-go.cialdnb.ai',
      githubRepo: 'CialDNB/arena-go',
      secretPrefix: 'arena-go',
    });
  });

  it('rejects names that would break attributability', () => {
    for (const bad of ['Arena', 'a', 'app--x', '-app', 'app-', '1app', 'app_name']) {
      assert.throws(() => resourceNames(bad), undefined, bad);
    }
  });
});

describe('aiGatewayCreatePayload', () => {
  it('sends the rate-limiting + cache fields the gateways create API requires', () => {
    // The old { id, collect_logs } body fails validation (error 7001). The current API
    // requires rate_limiting_* + cache_ttl (numbers) + cache_invalidate_on_update. We
    // disable both (the app's budget gates are the control) and keep metadata logs ON.
    assert.deepEqual(aiGatewayCreatePayload('all-pr-apps'), {
      id: 'all-pr-apps',
      authentication: true,
      cache_invalidate_on_update: false,
      cache_ttl: 0,
      collect_logs: true,
      rate_limiting_interval: 0,
      rate_limiting_limit: 0,
      rate_limiting_technique: 'fixed',
    });
  });

  it('creates an AUTHENTICATED gateway — an open one is a billable proxy for anyone', () => {
    // Not cosmetic. The account id and the gateway id are both non-secret, so an
    // unauthenticated gateway lets anyone who knows them bill inference to this account —
    // and on the FLEET gateway that exposure covers every app at once. If this ever flips
    // to false, ensuring the gateway ships an open proxy — so pin the VALUE, not the type.
    assert.equal(aiGatewayCreatePayload('all-pr-apps').authentication, true);
  });

  it('pins field TYPES — the API rejects strings where it wants numbers/booleans', () => {
    const p = aiGatewayCreatePayload('all-pr-apps');
    assert.equal(typeof p.cache_ttl, 'number');
    assert.equal(typeof p.rate_limiting_interval, 'number');
    assert.equal(typeof p.rate_limiting_limit, 'number');
    assert.equal(typeof p.rate_limiting_technique, 'string');
    assert.equal(typeof p.cache_invalidate_on_update, 'boolean');
    assert.equal(typeof p.collect_logs, 'boolean');
    assert.equal(typeof p.authentication, 'boolean');
  });
});

describe('the gateway step is GET-first (source pin — main() is not unit-testable)', () => {
  // Same pattern as the R2 lifecycle PUT pin below: the invariant lives in main(), so pin
  // the source. Create-first would re-arm the AI Gateway:Edit requirement on every deploy
  // token (DECISIONS 2026-08-28) — the create call must sit behind a real HTTP 404 check,
  // never in front of the GET.
  const src = readFileSync(new URL('../../scripts/provision.mjs', import.meta.url), 'utf8');

  it('reads the gateway before any create attempt, and gates the create on HTTP 404', () => {
    const getIdx = src.indexOf("await cf(token, 'GET', gatewayUrl)");
    const guardIdx = src.indexOf('live.status === 404');
    const createIdx = src.indexOf('aiGatewayCreatePayload(names.aiGateway)');
    assert.ok(getIdx !== -1, 'gateway GET is missing');
    assert.ok(
      guardIdx !== -1,
      'the HTTP 404 guard is missing (error-prose matching is not enough)',
    );
    assert.ok(createIdx !== -1, 'the guarded create call is missing');
    assert.ok(getIdx < guardIdx && guardIdx < createIdx, 'order must be GET → 404 guard → create');
  });

  it('cf() exposes the HTTP status the 404 guard rides on', () => {
    assert.ok(src.includes('status: res.status'), 'cf() must return the HTTP status');
  });
});

describe('next steps never route a new app through `wrangler secret put` (source pin)', () => {
  // On a missing Worker, `wrangler secret put` does not fail: createDraftWorker uploads a stub
  // Worker, its prompt defaulting to yes even non-interactively, and the stub gets a workers.dev
  // route. The old "a per-Worker secret needs the Worker" line read as "deploy, then secret
  // put" — or invited a secret put that creates the Worker. Pinned on provision.mjs only:
  // /kit-upgrade carries scripts/ whole, while the wrangler configs' comments are the fork's.
  const src = readFileSync(new URL('../../scripts/provision.mjs', import.meta.url), 'utf8');

  it('warns against secret put before the first deploy, and names the stub-Worker consequence', () => {
    assert.ok(src.includes('NOT `wrangler secret put` first'), 'the warning is missing');
    assert.ok(src.includes('silently creates a stub one'), 'the consequence is missing');
    // The printed deploy command itself — the RESOURCES.md row template also mentions --secrets-file.
    assert.match(
      src,
      /npx wrangler deploy --config \$\{cfgFile\} --secrets-file/,
      'the first-deploy path is gone',
    );
  });

  it('drops the misleading "needs the Worker" claim', () => {
    assert.ok(!src.includes('A per-Worker secret needs the'), 'stale next-steps wording is back');
    assert.ok(!src.includes("can't be set before the Worker exists"), 'stale note wording is back');
  });
});

describe('aiGatewayDrift — the exists-path VERIFIES the shared gateway, not just its name', () => {
  it('is empty when the live config matches the canonical payload', () => {
    assert.deepEqual(aiGatewayDrift(aiGatewayCreatePayload('all-pr-apps')), []);
  });

  it('flags auth-off, caching-on, and rate-limiting-on — each a fleet-wide hazard', () => {
    const drift = aiGatewayDrift({
      ...aiGatewayCreatePayload('all-pr-apps'),
      authentication: false, // open billable proxy for EVERY app
      cache_ttl: 3600, // one app's completion served to another app's user
      rate_limiting_limit: 100, // one app's burst throttles the whole fleet
    });
    assert.equal(drift.length, 3);
    assert.match(drift.join('; '), /authentication=false/);
    assert.match(drift.join('; '), /cache_ttl=3600/);
    assert.match(drift.join('; '), /rate_limiting_limit=100/);
  });

  it('treats an absent/unreadable config as fully drifted (fail closed)', () => {
    assert.equal(aiGatewayDrift(null).length, 5);
    assert.equal(aiGatewayDrift(undefined).length, 5);
  });
});

describe('legacy per-app gateway row — migration residue stays visible until deleted', () => {
  const names = resourceNames('myapp');
  // The pre-migration manifest shape: the app's own gateway under the plain 'AI Gateway'
  // kind (what every fork's RESOURCES.md says before its first post-migration provision).
  const OLD_MANIFEST = `# Resources — myapp

| Kind | Name | ID | Purpose |
| --- | --- | --- | --- |
| AI Gateway | \`myapp\` | created | All LLM calls route here; payload logging OFF |
`;

  it('carriedFromResourcesMd captures the retired per-app row as aiGatewayLegacy', () => {
    const carried = carriedFromResourcesMd(OLD_MANIFEST, 'myapp', names);
    assert.equal(carried.aiGatewayLegacy, 'created');
  });

  it('renderResourcesMd renders the legacy row only when carried', () => {
    const withLegacy = renderResourcesMd('myapp', names, { aiGatewayLegacy: 'created' });
    assert.ok(withLegacy.includes('| AI Gateway (legacy) | `myapp` | created |'));
    const fresh = renderResourcesMd('myapp', names, {});
    assert.ok(!fresh.includes('AI Gateway (legacy)'));
  });

  it('round-trips: the regenerated manifest re-carries the legacy row it rendered', () => {
    // Without this, the first post-migration provision run would erase the only record of
    // the stranded gateway the platform owner still has to delete to reclaim the cap.
    const rendered = renderResourcesMd('myapp', names, { aiGatewayLegacy: 'created' });
    const carried = carriedFromResourcesMd(rendered, 'myapp', names);
    assert.equal(carried.aiGatewayLegacy, 'created');
  });
});

describe('R2 backup lifecycle — re-provision is idempotent (AICOE-226 R1)', () => {
  it('builds one backup-expiry rule: enabled, db-backups/ prefix, age in seconds beyond retention', () => {
    const [rule] = withBackupLifecycleRule([], 30);
    assert.equal(rule.id, BACKUP_LIFECYCLE_RULE_ID);
    assert.equal(rule.enabled, true);
    assert.equal(rule.conditions.prefix, BACKUP_PREFIX);
    assert.equal(rule.deleteObjectsTransition.condition.type, 'Age');
    // 30d retention + 7d backstop buffer, expressed in SECONDS (per the R2 lifecycle API).
    assert.equal(rule.deleteObjectsTransition.condition.maxAge, (30 + 7) * 86_400);
  });

  it('is idempotent — re-applying upserts by id, never appends a duplicate', () => {
    const once = withBackupLifecycleRule([], 30);
    const twice = withBackupLifecycleRule(once, 30);
    assert.deepEqual(twice, once); // the re-provision case that previously double-created
    assert.equal(twice.filter((r) => r.id === BACKUP_LIFECYCLE_RULE_ID).length, 1);
  });

  it('preserves unrelated app-owned lifecycle rules', () => {
    const appRule = {
      id: 'app-thumbnails-expiry',
      enabled: true,
      conditions: { prefix: 'thumbs/' },
    };
    const merged = withBackupLifecycleRule([appRule], 30);
    assert.ok(
      merged.some((r) => r.id === 'app-thumbnails-expiry'),
      'app rule kept',
    );
    assert.equal(merged.filter((r) => r.id === BACKUP_LIFECYCLE_RULE_ID).length, 1);
  });

  it('reads BACKUP_RETENTION_DAYS from config vars, defaulting to 30', () => {
    assert.equal(backupRetentionDays({ vars: { BACKUP_RETENTION_DAYS: '14' } }), 14);
    assert.equal(backupRetentionDays({}), 30);
    assert.equal(backupRetentionDays({ vars: { BACKUP_RETENTION_DAYS: 'nope' } }), 30);
  });

  it('sets the lifecycle via PUT (replace), not an appending POST', () => {
    // Source-level guard: the bug was a POST that appended a duplicate rule each run. The
    // pure-function tests above prove the upsert is idempotent; this pins the wire verb.
    const src = readFileSync(new URL('../../scripts/provision.mjs', import.meta.url), 'utf8');
    assert.match(src, /cf\(token, 'PUT'/, 'lifecycle is set with PUT (replace), not append');
    assert.doesNotMatch(src, /'POST'[^\n]*lifecycle/, 'no POST to a lifecycle endpoint');
  });
});

describe('RESOURCES.md regeneration keeps the recorded Linear project', () => {
  // The Linear row is written by /new-app AFTER generation — the one value provision cannot
  // re-derive. Every regeneration used to reset it to _pending_ (found in the status-admin
  // bootstrap review); main() now parses the prior manifest and seeds the fresh state with it.
  const names = resourceNames('arena-go');
  const url = 'https://linear.app/cialdnb/project/arena-go-0000';
  const linearRow = (md) => md.split('\n').find((l) => l.startsWith('| Linear project |'));

  it('extracts the recorded value from a previously generated manifest', () => {
    const prior = renderResourcesMd('arena-go', names, { linear: url });
    assert.equal(linearFromResourcesMd(prior), url);
  });

  it('a prior manifest with a Linear row survives regeneration', () => {
    const prior = renderResourcesMd('arena-go', names, { linear: url });
    const regenerated = renderResourcesMd('arena-go', names, {
      d1Staging: '358e2840-0000-0000-0000-000000000000',
      linear: linearFromResourcesMd(prior),
    });
    assert.equal(linearRow(regenerated)?.endsWith(`| ${url} |`), true, linearRow(regenerated));
  });

  it('keeps a markdown-link cell intact, however /new-app wrote it', () => {
    const cell = `[AICOE — arena-go](${url})`;
    const prior = renderResourcesMd('arena-go', names, { linear: cell });
    assert.equal(linearFromResourcesMd(prior), cell);
  });

  it('treats _pending_, a placeholder manifest, and a missing file as nothing-recorded', () => {
    // A fresh render (no value) must round-trip to undefined so `?? '_pending_'` still applies,
    // never carrying the literal placeholder forward as if it were a recorded value.
    assert.equal(linearFromResourcesMd(renderResourcesMd('arena-go', names, {})), undefined);
    // scripts/new-app.mjs stamps a table-less placeholder before the first provision.
    assert.equal(
      linearFromResourcesMd('# Resources — arena-go\n\n> NOT YET GENERATED.\n'),
      undefined,
    );
    assert.equal(linearFromResourcesMd(''), undefined);
    assert.equal(linearFromResourcesMd(undefined), undefined);
  });

  it('parses the real-world TWO-column row /new-app wrote into the placeholder (status-admin)', () => {
    // The row shape that motivated this fix, verbatim from cial-status/docs/RESOURCES.md:
    // /new-app recorded into the table-less placeholder, inventing a two-column table. The
    // first cut of this fix required the generator's three-column shape and missed it.
    const md = [
      '# Resources — status-admin',
      '',
      '| Resource | Value |',
      '| --- | --- |',
      '| Linear project | [CIAL Status Page](https://linear.app/cialdnb/project/cial-status-page-d87c11841bbc) (team: CIAL SRE) |',
    ].join('\n');
    assert.equal(
      linearFromResourcesMd(md),
      '[CIAL Status Page](https://linear.app/cialdnb/project/cial-status-page-d87c11841bbc) (team: CIAL SRE)',
    );
  });

  it('keeps a raw pipe inside the cell intact in both row shapes (no truncation)', () => {
    const twoCol = '| Linear project | [AICOE | arena-go](https://linear.app/x) |';
    assert.equal(linearFromResourcesMd(twoCol), '[AICOE | arena-go](https://linear.app/x)');
    const threeCol =
      '| Linear project | ask /new-app — it links or creates one | [AICOE | arena-go](https://linear.app/x) |';
    assert.equal(linearFromResourcesMd(threeCol), '[AICOE | arena-go](https://linear.app/x)');
  });

  it('keeps a GFM-escaped \\| intact and renders it back unchanged (stable round-trip)', () => {
    const cell = '[AICOE \\| arena-go](https://linear.app/x)';
    const rendered = renderResourcesMd('arena-go', names, { linear: cell });
    assert.equal(linearFromResourcesMd(rendered), cell);
    // Render-side escaping: a RAW pipe in a carried value is escaped on emit, so the row
    // we write always parses back into the same cells on the next run.
    const raw = renderResourcesMd('arena-go', names, { linear: '[a | b](url)' });
    assert.equal(linearFromResourcesMd(raw), '[a \\| b](url)');
  });
});

describe('carriedFromResourcesMd — regeneration carries the whole recorded manifest', () => {
  const names = resourceNames('arena-go');

  it('round-trips every recorded value and leaves placeholders unrecorded', () => {
    const state = {
      d1Prod: 'p-d1',
      d1Staging: 's-d1',
      kvProd: 'p-kv',
      kvStaging: 's-kv',
      r2Prod: 'ok',
      r2Staging: 'ok',
      aiGateway: 'created',
      secrets: 'minted + stored (arena-go-ai-gateway)',
      dnsStaging: 'live',
      dnsProd: 'live',
      token: 'in owner vault',
      repo: 'done',
      ci: 'done',
      email: 'done',
      entraSso: 'both URIs added 2026-10-10',
      linear: 'https://linear.app/cialdnb/project/arena-go-0000',
    };
    const carried = carriedFromResourcesMd(
      renderResourcesMd('arena-go', names, state),
      'arena-go',
      names,
    );
    assert.deepEqual(carried, state);
  });

  it('a staging-only re-run keeps the production ids (the cross-env wipe)', () => {
    const afterProd = renderResourcesMd('arena-go', names, {
      d1Prod: 'prod-d1-id',
      kvProd: 'prod-kv-id',
      r2Prod: 'ok',
    });
    // What main() does on a later --env staging run: seed from the file, then assign
    // this run's fresh staging values over it.
    const carried = carriedFromResourcesMd(afterProd, 'arena-go', names);
    const afterStaging = renderResourcesMd('arena-go', names, {
      ...carried,
      d1Staging: 'stg-d1-id',
    });
    assert.ok(afterStaging.includes('prod-d1-id'), 'production D1 id survives a staging run');
    assert.ok(afterStaging.includes('prod-kv-id'), 'production KV id survives a staging run');
    assert.ok(afterStaging.includes('stg-d1-id'), 'fresh staging id recorded');
  });

  it('a --plan run preserves everything previously provisioned', () => {
    const provisioned = renderResourcesMd('arena-go', names, {
      d1Staging: 'stg-id',
      kvStaging: 'kv-id',
      aiGateway: 'created',
      linear: 'https://linear.app/cialdnb/project/arena-go-0000',
    });
    const replanned = renderResourcesMd(
      'arena-go',
      names,
      carriedFromResourcesMd(provisioned, 'arena-go', names),
    );
    for (const value of ['stg-id', 'kv-id', 'created', 'arena-go-0000']) {
      assert.ok(replanned.includes(value), `${value} survives --plan regeneration`);
    }
  });

  it('keeps a hand-recorded Entra SSO status, and lists BOTH callbacks (db-talents, 2026-10-10)', () => {
    // The platform owner records this row by hand after adding the app's redirect URIs to the
    // shared registration. It was the one hand-recorded row outside the carried set, so every
    // provision run reset it to _pending platform setup_. The value cell is carried; the URI
    // cell is regenerated, and the app needs BOTH redirect URIs registered, not just prod's.
    const entraRow = (md) => md.split('\n').find((l) => l.startsWith('| Entra SSO redirect URI |'));
    const status = 'reported added by the app owner 2026-10-10; unproven until a staging login';
    const handEdited = renderResourcesMd('arena-go', names, {}).replace(
      /^\| Entra SSO redirect URI \|.*$/m,
      `| Entra SSO redirect URI | https://arena-go.cialdnb.ai/auth/oidc/callback + https://staging-arena-go.cialdnb.ai/auth/oidc/callback (client \`00000000-fixture\`) | ${status} |`,
    );
    const carried = carriedFromResourcesMd(handEdited, 'arena-go', names);
    assert.equal(carried.entraSso, status);
    const regenerated = entraRow(renderResourcesMd('arena-go', names, carried));
    assert.ok(regenerated.endsWith(`| ${status} |`), regenerated);
    assert.ok(regenerated.includes('https://arena-go.cialdnb.ai/auth/oidc/callback'), regenerated);
    assert.ok(
      regenerated.includes('https://staging-arena-go.cialdnb.ai/auth/oidc/callback'),
      regenerated,
    );
    // A status recorded against the OLD prod-only row is not carried onto the two-URI row: it
    // never said anything about the staging callback.
    const prodOnly = handEdited.replace(
      /^\| Entra SSO redirect URI \|.*$/m,
      `| Entra SSO redirect URI | https://arena-go.cialdnb.ai/auth/oidc/callback on the shared registration | added |`,
    );
    assert.equal(carriedFromResourcesMd(prodOnly, 'arena-go', names).entraSso, undefined);
    // Nothing recorded → the placeholder, never carried forward as a value.
    const fresh = renderResourcesMd('arena-go', names, {});
    assert.ok(entraRow(fresh).endsWith('| _pending platform setup_ |'));
    assert.equal(carriedFromResourcesMd(fresh, 'arena-go', names).entraSso, undefined);
  });

  it('carries NOTHING from a foreign app’s manifest (identity guard)', () => {
    // The manifest is a security-attribution file: a repo copied from a bootstrapped app
    // without the /new-app rename must not launder the origin's values under a new header.
    const foreign = renderResourcesMd('arena-go', names, {
      d1Prod: 'foreign-id',
      linear: 'https://linear.app/cialdnb/project/arena-go-0000',
    });
    const other = resourceNames('other-app');
    assert.deepEqual(carriedFromResourcesMd(foreign, 'other-app', other), {});
  });

  it('carries nothing from the placeholder manifest or a missing file', () => {
    assert.deepEqual(
      carriedFromResourcesMd('# Resources — arena-go\n\n> NOT YET GENERATED.\n', 'arena-go', names),
      {},
    );
    assert.deepEqual(carriedFromResourcesMd('', 'arena-go', names), {});
  });
});

describe('per-app secrets are per-Worker (secrets.required); shared secrets stay in the store (AICOE-467)', () => {
  // The migration's whole point: a NEW app must mint ZERO account Secrets Store entries for its
  // own ANTHROPIC_API_KEY / AI_GATEWAY_TOKEN (the 100-cap store was at 71/100). These read the
  // REAL shipped wrangler configs so a regression — someone re-adding a per-app store binding, or
  // dropping the `required` fail-closed gate — fails CI. App-agnostic (never asserts the app name),
  // so the same assertions hold in every bootstrapped fork.
  const PER_APP = ['ANTHROPIC_API_KEY', 'AI_GATEWAY_TOKEN'];
  const readConfig = (file) =>
    parseJsonc(readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8'));

  for (const file of ['wrangler.jsonc', 'wrangler.staging.jsonc']) {
    describe(file, () => {
      const cfg = readConfig(file);

      it('parses and declares the per-app secrets as `required` (deploy fails closed if missing)', () => {
        assert.ok(cfg, `${file} parsed as JSONC`);
        // Per-environment, NOT inherited — so it must be present in BOTH configs verbatim.
        assert.deepEqual(cfg.secrets?.required, PER_APP);
      });

      it('does NOT bind the per-app secrets to the account Secrets Store (no store slot consumed)', () => {
        const storeBindings = (cfg.secrets_store_secrets ?? []).map((s) => s.binding);
        for (const name of PER_APP) {
          assert.ok(
            !storeBindings.includes(name),
            `${name} must be a per-Worker secret, not a secrets_store_secrets binding`,
          );
        }
      });

      it('keeps the SHARED alert webhook as a Secrets Store binding (one entry for every app)', () => {
        const alert = (cfg.secrets_store_secrets ?? []).find(
          (s) => s.binding === 'ALERT_WEBHOOK_URL',
        );
        assert.ok(alert, 'ALERT_WEBHOOK_URL stays a shared account Secrets Store binding');
        assert.equal(alert.secret_name, 'PAVED_ROAD_ALERT_WEBHOOK_URL');
      });
    });
  }

  it('leaves the TEST config alone — unit tests inject secrets on the env directly', () => {
    // wrangler.test.jsonc has no Secrets Store binding and no `required` gate (the Workers test
    // pool has no store, and test/ai/anthropic.test.ts sets ANTHROPIC_API_KEY on the env object).
    assert.equal(readConfig('wrangler.test.jsonc').secrets, undefined);
  });

  it('provision no longer writes any per-app secret to the account Secrets Store', () => {
    // Source-level guard, like the R2-lifecycle PUT guard above: the old step minted an AI-Gateway
    // token and POSTed it to /secrets_store/stores/{id}/secrets. Per-Worker secrets can't be set
    // before the Worker exists, and minting here would leak the value into CI logs — so it's gone.
    const src = readFileSync(new URL('../../scripts/provision.mjs', import.meta.url), 'utf8');
    assert.doesNotMatch(
      src,
      /secrets_store\/stores\/[^\n]*\/secrets/,
      'provision must not read or write per-app secrets in the Secrets Store',
    );
    assert.doesNotMatch(
      src,
      /provisionAiGatewayToken/,
      'the store-writing token minter is removed',
    );
  });
});

describe('edgeRulesState — opt-out vs unreadable stay distinguishable (issue #182)', () => {
  it('renders plain notes when phases were readable', () => {
    const cell = edgeRulesState({
      rateLimit: 'set',
      hostPin: 'skipped (shared zone)',
      unreadable: false,
    });
    assert.equal(cell, 'set / skipped (shared zone)');
    assert.doesNotMatch(cell, /attempted|Zone WAF/);
  });

  it('marks the unreadable case as ATTEMPTED and names the token scope + issue', () => {
    const cell = edgeRulesState({
      rateLimit:
        'manual (GET failed: [{"code":10000,"message":"Authentication error"}]) — skipped PUT',
      hostPin: 'skipped (shared zone)',
      unreadable: true,
    });
    // The cell must not read like the CLOUDFLARE_ZONE_ID opt-out: the zone id WAS set. It has
    // to say the attempt happened and point at the likely cause (§8.1 Zone WAF:Edit).
    assert.match(cell, /attempted/i);
    assert.match(cell, /Zone WAF:Edit/);
    assert.match(cell, /#?182/);
    assert.doesNotMatch(cell, /set CLOUDFLARE_ZONE_ID/);
  });

  it('names a missing entrypoint as such — never as the token-scope problem (10003)', () => {
    // A phase that never held a rule answers 10003; provision still refuses to PUT (DECISIONS
    // 2026-07-13) but must point at the real remedy, a first rule by hand — not a token re-mint.
    const cell = edgeRulesState({
      rateLimit:
        'manual (phase http_ratelimit has no entrypoint ruleset yet: [{"code":10003}]) — provision never creates the first rule',
      hostPin: 'skipped (shared zone)',
      unreadable: false,
      noEntrypoint: true,
    });
    assert.match(cell, /attempted/i);
    assert.match(cell, /no entrypoint ruleset yet/);
    assert.match(cell, /by hand/);
    assert.doesNotMatch(cell, /Zone WAF:Edit|#182/);
    assert.doesNotMatch(cell, /set CLOUDFLARE_ZONE_ID/);
  });

  it('keeps both remedies when one phase is unreadable and another has no entrypoint', () => {
    const cell = edgeRulesState({
      rateLimit: 'manual (…10003…)',
      hostPin: 'manual (GET failed: 10000)',
      unreadable: true,
      noEntrypoint: true,
    });
    assert.match(cell, /Zone WAF:Edit/);
    assert.match(cell, /no entrypoint ruleset yet/);
  });

  it('main() exits non-zero on a missing entrypoint too, via exitCode at end of run (source pin)', () => {
    const src = readFileSync(new URL('../../scripts/provision.mjs', import.meta.url), 'utf8');
    assert.match(src, /if \(edgeNoEntrypoint\) \{/);
    const block = src.split('if (edgeNoEntrypoint) {')[1].split('\n  }')[0];
    assert.match(block, /process\.exitCode = 1/);
    assert.doesNotMatch(block, /process\.exit\(/);
    assert.doesNotMatch(block, /Zone WAF:Edit/, 'the no-entrypoint remedy is not a token fix');
  });

  it('main() exits non-zero on unreadable but only via exitCode at end of run (source pin)', () => {
    const src = readFileSync(new URL('../../scripts/provision.mjs', import.meta.url), 'utf8');
    // The loud failure must not abort mid-run (resources/RESOURCES.md must still complete):
    // process.exitCode, never process.exit, on the edgeUnreadable path.
    assert.match(src, /if \(edgeUnreadable\) \{/);
    const block = src.split('if (edgeUnreadable) {')[1].split('}')[0];
    assert.match(block, /process\.exitCode = 1/);
    assert.doesNotMatch(block, /process\.exit\(/);
  });
});

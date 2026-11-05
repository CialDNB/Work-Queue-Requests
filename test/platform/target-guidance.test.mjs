// The guidance follows the app's deployment target (ILOPS-8888 item 6). Every skill that tests
// staging, ships, goes live, upgrades the kit, onboards a person or adds a job reads the target
// with the reader before its first step, and has a DB Israel branch that names what the central
// pipeline does instead of the CIAL path. The adopt command, the docs those skills point at and
// the wrangler comments say which instructions are CIAL only.
//
// A drift tripwire against an edit that drops a branch, not a proof that the guidance is right:
// each case looks for the few facts a DB Israel app cannot do without. The plugin's copies of the
// skills are held byte-identical to these by verify:plugin.
//
// Kit only: an app keeps the copy of this file it was generated with, while /kit-upgrade replaces
// the skills under it, and its own GO-LIVE.md, SECRETS.md and wrangler configs are its own. So it
// skips itself in a renamed app. CHANGELOG.md is the kit's own release notes. Nothing here names
// the template as a literal; a renamed app keeps this file, and its residual scan would flag one.
// Run by `node --test` (test:scripts).
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { CALLER_PATH, LEGACY_CALLER_PATH, MARKER_PATH } from '../../scripts/deployment-target.mjs';
import { isTemplateRepo, TEMPLATE_KEBAB } from '../../scripts/new-app.mjs';

const ROOT = join(import.meta.dirname, '..', '..');
const read = (path) => readFileSync(join(ROOT, path), 'utf8');

const READER = 'node scripts/deployment-target.mjs';
const SECTION = '## DB Israel apps';
const STAGING_HOST = '<app>.staging.dbisrael.ai';
const RELEASE_WORKFLOW = `il-${TEMPLATE_KEBAB}-release`;

/** The text of a skill's DB Israel section: from its heading to the next `## ` heading. */
function israelSection(skill, text) {
  const start = text.indexOf(`\n${SECTION}\n`);
  assert.ok(start >= 0, `${skill}: no "${SECTION}" section`);
  const next = text.indexOf('\n## ', start + SECTION.length + 2);
  return text.slice(start, next === -1 ? undefined : next);
}

/** A CHANGELOG entry, from its opening words to the next top-level entry, on one line. */
function changelogEntry(opening) {
  const changelog = read('CHANGELOG.md');
  const start = changelog.indexOf(opening);
  assert.ok(start > 0, `the CHANGELOG entry "${opening}"`);
  const ends = ['\n- **', '\n## ']
    .map((marker) => changelog.indexOf(marker, start))
    .filter((at) => at > 0);
  return changelog.slice(start, ends.length ? Math.min(...ends) : undefined).replace(/\s+/g, ' ');
}

/**
 * The production daily-evidence run is dispatched after the first daily run that follows the
 * launch. Central's verdict is `none` (and the run red) until that run writes the first
 * heartbeat, so "within 26 hours of the launch" sends an operator to a red run that is no failure.
 */
function assertAfterFirstDailyRun(where, text) {
  const prose = text.replace(/\s+/g, ' ');
  for (const fact of ['first daily run that follows the launch', '03:00 UTC', '`none`']) {
    assert.ok(prose.includes(fact), `${where} does not name ${fact}`);
  }
  assert.ok(
    !prose.includes('within 26 hours of the launch'),
    `${where} times the run from the launch`,
  );
}

// What each skill's DB Israel section must name, beyond the target check every skill has.
const SKILLS = {
  qa: [
    STAGING_HOST,
    'Microsoft',
    'ENTRA_CLIENT_SECRET',
    'seed-owner',
    'platform operator',
    '**blocked**',
    'bypass',
    // The central hostnames are WAF-restricted: a block page is not an app failure.
    'WAF',
    '**blocked (network)**',
  ],
  'go-live': [
    'Promote to production',
    'production/<release-id>',
    'platform operator',
    'operate-app',
    'ILOPS-8891',
    'Provision production',
    // Enabling production hands release to every Write collaborator, so it follows the sign-off.
    'enabled only after sign-off',
    'Write, Maintain or Admin',
    // The gates whose CIAL evidence a DB Israel app lacks.
    'Gate 2',
    'stages.production.vars',
    'daily-evidence',
    'ALERT_EMAIL',
    'WAF',
  ],
  ship: [RELEASE_WORKFLOW, 'release id', 'enrollment', 'DEPLOY_ENABLED', 'dual-delivered'],
  'kit-upgrade': [
    CALLER_PATH,
    MARKER_PATH,
    `il-${TEMPLATE_KEBAB}-*`,
    '103',
    'org admin',
    'Dependabot',
    'verify:bootstrap',
    'dual-delivered',
    // The workflow hunks travel with the tests that pin them, in one merge.
    "upgrade's own branch",
    // verify:bootstrap reads the target; this shows a changed marker or a deleted caller.
    'git diff --exit-code',
  ],
  'join-app': ['CLOUDFLARE_API_TOKEN', 'platform operator', 'ALERT_EMAIL', 'ILOPS-8950'],
  'add-job': ['schedules', 'catalog PR', 'receipt', 'read-back', 'optional_runtime_secrets'],
};

// A `cial` app with a release caller is dual-delivered: these skills send it to their DB Israel
// section too, from the target check, since the reader prints `cial` for it.
const DUAL_DELIVERED = ['kit-upgrade', 'ship', 'add-job'];

describe('the skills follow the deployment target', {
  skip: !isTemplateRepo(ROOT) && 'kit only: this repo is already renamed',
}, () => {
  for (const [skill, facts] of Object.entries(SKILLS)) {
    const text = read(`.claude/skills/${skill}/SKILL.md`);

    it(`/${skill} reads the target before its first section`, () => {
      const firstSection = text.indexOf('\n## ');
      const reader = text.indexOf(READER);
      assert.ok(reader >= 0, `/${skill} never runs ${READER}`);
      assert.ok(firstSection === -1 || reader < firstSection, `/${skill} reads the target late`);
      for (const outcome of ['`cial`', '`dbisrael`', 'exits 1']) {
        assert.ok(text.slice(0, firstSection).includes(outcome), `/${skill}: no ${outcome} branch`);
      }
    });

    it(`/${skill} has a DB Israel section that names what central does instead`, () => {
      const section = israelSection(skill, text);
      const missing = facts.filter((fact) => !section.includes(fact));
      assert.deepEqual(missing, [], `/${skill}'s DB Israel section lacks these`);
    });

    if (DUAL_DELIVERED.includes(skill)) {
      it(`/${skill} sends a dual-delivered app (cial with a caller) to that section too`, () => {
        const intro = text.slice(0, text.indexOf('\n## '));
        for (const fact of [CALLER_PATH, 'dual-delivered', '**DB Israel apps**']) {
          assert.ok(intro.includes(fact), `/${skill}'s target check does not name ${fact}`);
        }
      });
    }
  }

  it('/kit-upgrade notes the target before step 1, also on a tree with no reader yet', () => {
    // A dual-delivered fork upgrading to the version that brings the reader has none at step 1;
    // its target is then the marker's value, which it merged in its own PR before the upgrade.
    const section = israelSection('kit-upgrade', read('.claude/skills/kit-upgrade/SKILL.md'));
    const rule = section.match(/^- \*\*Before step 1,[\s\S]*?(?=^- \*\*)/m)?.[0] ?? '';
    assert.ok(rule, 'the "Before step 1" rule was not found');
    for (const fact of ['git rev-parse HEAD', READER, 'deploymentTarget']) {
      assert.ok(rule.includes(fact), `the "Before step 1" rule does not name ${fact}`);
    }
  });

  it("/go-live's gate 13 reads the open catalog PR before sign-off, and daily-evidence after the launch", () => {
    // Production is enabled only after sign-off, so before it there is no production Worker,
    // database or heartbeat for a production daily-evidence run to read.
    const section = israelSection('go-live', read('.claude/skills/go-live/SKILL.md'));
    const gate13 = section.match(/^- \*\*Gate 13[\s\S]*?(?=^- \*\*|^\*\*)/m)?.[0] ?? '';
    assert.ok(gate13, '/go-live: the Gate 13 item was not found');
    for (const fact of ['open catalog PR', 'stages.production.vars', 'MACHINE_LIVENESS_ARMED']) {
      assert.ok(gate13.includes(fact), `/go-live's Gate 13 item does not name ${fact}`);
    }
    const after = section.indexOf('**After the launch (step 5):**');
    assert.ok(after >= 0, '/go-live: the step 5 part was not found');
    for (const fact of ['daily-evidence', ', armed)', 'sync-run warn-only']) {
      assert.ok(
        section.slice(after).includes(fact),
        `/go-live's step 5 part does not name ${fact}`,
      );
    }
    assertAfterFirstDailyRun("/go-live's step 5 part", section.slice(after));
  });

  it("/kit-upgrade's trap T2 keeps step 3's rules for app-owned files and app sections", () => {
    const upgrade = read('.claude/skills/kit-upgrade/SKILL.md');
    const t2 = upgrade.match(/^2\. \*\*T2 [\s\S]*?(?=^3\. \*\*T3 )/m)?.[0] ?? '';
    assert.ok(t2, 'trap T2 was not found');
    const prose = t2.replace(/\s+/g, ' ');
    assert.ok(prose.includes('the step 3 rules for app-owned files and app sections'), prose);
    assert.ok(prose.includes('still apply'), prose);
  });

  it('/kit-upgrade carries the tests that pin the bootstrap and the deployment target', () => {
    const upgrade = read('.claude/skills/kit-upgrade/SKILL.md');
    const diffSet = upgrade.match(/git diff HEAD kit\/main -- ([^`]+)`/)?.[1].split(/\s+/) ?? [];
    assert.ok(diffSet.length > 0, 'the /kit-upgrade skill names its diff set');
    const missing = [
      'test/platform/new-app.test.mjs',
      'test/platform/bootstrap.test.ts',
      'test/platform/deployment-target.test.mjs',
      'test/platform/workflow-enrollment-safety.test.mjs',
      'test/platform/template-purity.test.mjs',
      // The modules they pin (scripts/central-proposal.mjs, src/platform/runtimeConfig.mjs) ride
      // the upgrade, so an app's copies of these must too, or a later kit change to either turns
      // the app's own test:scripts red.
      'test/platform/central-proposal.test.mjs',
      'test/platform/runtime-config.test.mjs',
    ].filter((path) => !diffSet.includes(path));
    assert.deepEqual(missing, []);
  });
});

// The two entry points that carry the target to the bootstrap: the repo's /new-app skill and the
// plugin's pave. The plugin-path e2e simulates the bootstrap runs; this pins the words that make
// them, so dropping `--target` from a command, or the question, fails here and not only in the
// plugin's stamp.
describe('the entry points ask the deployment target and pass it on', {
  skip: !isTemplateRepo(ROOT) && 'kit only: this repo is already renamed',
}, () => {
  const QUESTION =
    'Is this a DB Israel application deployed under dbisrael.ai, or a standard CIAL application?';
  const TARGET = '--target <cial|dbisrael>';
  const flat = (text) => text.replace(/\s+/g, ' ');
  /** The text from `start` to the next match of `end` (or the end of the text). */
  const between = (text, start, end) => {
    const from = text.indexOf(start);
    assert.ok(from >= 0, `"${start}" was not found`);
    const to = text.indexOf(end, from + start.length);
    return text.slice(from, to === -1 ? undefined : to);
  };

  it('/new-app asks the target before the name, in these words, and passes it to the bootstrap', () => {
    const skill = read('.claude/skills/new-app/SKILL.md');
    const step0 = between(skill, '\n## 0. ', '\n## 1. ');
    const step1 = between(skill, '\n## 1. ', '\n## 2. ');
    assert.ok(skill.indexOf('\n## 0. ') < skill.indexOf('\n## 1. Name the app'), 'step 0 first');
    assert.ok(flat(step0).includes(QUESTION), 'step 0 asks the question verbatim');
    assert.ok(
      step1.includes(`node scripts/new-app.mjs <name> --display "<Display Name>" ${TARGET}`),
      'step 1 passes the target',
    );
  });

  it('/new-app reads the target on a renamed tree, and asks once where an older pave never did', () => {
    // An older plugin's pave makes a CIAL rename without asking. While nothing is provisioned, the
    // repo's /new-app asks once and converts it; otherwise it takes what the reader prints.
    const step0 = flat(between(read('.claude/skills/new-app/SKILL.md'), '\n## 0. ', '\n## 1. '));
    for (const fact of [
      'npm run -s deployment-target',
      'older `pave`',
      'PLACEHOLDER_RUN_PROVISION',
      'NOT YET GENERATED',
      'ask it once',
      'node scripts/new-app.mjs <name> --target dbisrael',
    ]) {
      assert.ok(step0.includes(fact), `step 0 does not name ${fact}`);
    }
  });

  it('pave asks the target with the name, in the same words, and passes it to the bootstrap', () => {
    const pave = read(`plugins/${TEMPLATE_KEBAB}/commands/pave.md`);
    const step2 = between(pave, '\n2. **Ask the deployment target', '\n3. ');
    assert.ok(flat(step2).includes(QUESTION), 'step 2 asks the question verbatim');
    const step5 = between(pave, '\n5. **Rename the template', '\n6. ');
    assert.ok(step5.includes(`node scripts/new-app.mjs <app-name> ${TARGET}`), 'step 5 passes it');
  });
});

describe('the adopt command and the docs say what is CIAL only', {
  skip: !isTemplateRepo(ROOT) && 'kit only: this repo is already renamed',
}, () => {
  it("adopt's full-migration step sends the target to /new-app and keeps provisioning CIAL", () => {
    const adopt = read(`plugins/${TEMPLATE_KEBAB}/commands/adopt.md`);
    const step = adopt.match(/^4\. Use `\/new-app`[\s\S]*?(?=^5\. )/m)?.[0] ?? '';
    assert.ok(step, 'adopt.md: the /new-app step was not found');
    for (const fact of ['deployment target', 'DB Israel', 'CIAL app only']) {
      assert.ok(step.includes(fact), `adopt.md's /new-app step does not say ${fact}`);
    }
  });

  it('GO-LIVE.md and SECRETS.md each have a DB Israel section', () => {
    for (const doc of ['docs/GO-LIVE.md', 'docs/SECRETS.md']) {
      assert.match(read(doc), /^## DB Israel apps$/m, doc);
    }
    assert.ok(israelSection('SECRETS.md', read('docs/SECRETS.md')).includes('dual-delivered'));
  });

  it("GO-LIVE.md's DB Israel section maps every gate whose evidence is CIAL only, and enables production after sign-off", () => {
    const section = israelSection('GO-LIVE.md', read('docs/GO-LIVE.md'));
    const mapped = [...section.matchAll(/^\| ([0-9a-z, ]+) \|/gm)].flatMap((m) => m[1].split(', '));
    const missing = ['2', '5', '5a', '7', '8a', '9', '11', '12', '13'].filter(
      (gate) => !mapped.includes(gate),
    );
    assert.deepEqual(missing, [], 'gates with no DB Israel row');
    assert.ok(section.includes('Production is enabled only after sign-off'));
    assert.ok(section.includes('WAF-restricted'));
  });

  it("GO-LIVE.md's gate 13 reads the open catalog PR before sign-off, and daily-evidence after the launch", () => {
    const section = israelSection('GO-LIVE.md', read('docs/GO-LIVE.md'));
    const row13 = section.match(/^\| 13 \|.*$/m)?.[0] ?? '';
    assert.ok(row13, 'GO-LIVE.md: no gate 13 row');
    for (const fact of ['open catalog PR', 'stages.production.vars', 'MACHINE_LIVENESS_ARMED']) {
      assert.ok(row13.includes(fact), `GO-LIVE.md's gate 13 row does not name ${fact}`);
    }
    const launch = section.indexOf('**Launch, after sign-off');
    assert.ok(launch >= 0, 'GO-LIVE.md: the DB Israel launch paragraph was not found');
    for (const fact of ['daily-evidence', ', armed)', 'sync-run warn-only']) {
      assert.ok(section.slice(launch).includes(fact), `the launch paragraph does not name ${fact}`);
    }
    assertAfterFirstDailyRun("GO-LIVE.md's post-launch paragraph", section.slice(launch));
  });

  it("the Entra runbook names a DB Israel app's staging redirect URI", () => {
    const runbook = read('docs/runbooks/entra-sso-setup.md');
    assert.ok(runbook.includes(`https://${STAGING_HOST}/auth/oidc/callback`));
  });

  it('PLUGIN.md says an older installed plugin ignores the target', () => {
    assert.match(
      read('docs/PLUGIN.md'),
      /older than 1\.6\.0[\s\S]{0,200}ignore the deployment target/,
    );
  });

  it('the wrangler comments mark each laptop secret or resource command CIAL only', () => {
    for (const config of ['wrangler.jsonc', 'wrangler.staging.jsonc']) {
      // Each comment paragraph that tells you to run one of the commands says it is CIAL only.
      const paragraphs = read(config)
        .split(/\n(?!\s*\/\/)/)
        .filter((p) => /secret put|--update-config/.test(p));
      assert.ok(paragraphs.length > 0, `${config}: no such comment`);
      const unmarked = paragraphs.filter((p) => !p.includes('CIAL only'));
      assert.deepEqual(unmarked, [], `${config}: a comment paragraph is not marked CIAL only`);
    }
  });
});

// A fork with a release caller takes the version that brings these rules with its own, older
// /kit-upgrade, which has no DB Israel section. Its step 3 applies `.github` hunk by hunk, and the
// caller, a file only the fork has, shows there as a deletion. So the release notes carry the
// rules for that one upgrade, and the reader entry's workflow hunks leave the caller out.
describe("the CHANGELOG keeps a fork's release caller through the upgrade that brings the rules", {
  skip: !isTemplateRepo(ROOT) && "kit only: CHANGELOG.md is the kit's own release notes",
}, () => {
  const markerDir = MARKER_PATH.slice(0, MARKER_PATH.lastIndexOf('/') + 1);
  const manualSteps = (entry) => {
    const at = entry.indexOf('**Manual steps for forks:**');
    assert.ok(at >= 0, 'the entry has no manual steps');
    return entry.slice(at);
  };

  it("the target-aware guidance entry sends a fork with a caller to kit/main's DB Israel rules", () => {
    const steps = manualSteps(changelogEntry('**The guidance follows the deployment target'));
    for (const fact of [
      CALLER_PATH,
      'git show kit/main:.claude/skills/kit-upgrade/SKILL.md',
      // No reader yet at step 1: the target is the marker's value.
      'deploymentTarget',
      `git diff --exit-code <start> -- ${markerDir} ${CALLER_PATH} ${LEGACY_CALLER_PATH}`,
    ]) {
      assert.ok(steps.includes(fact), `the manual steps do not name ${fact}`);
    }
    assert.match(steps, /never take the caller's deletion/i);
    assert.match(steps, /pushes no deletion/);
  });

  it("the reader entry's manual step 1 leaves the caller's deletion out of the workflow hunks", () => {
    const steps = manualSteps(changelogEntry('**One reader decides the deployment target'));
    const step1 = steps.slice(steps.indexOf(' 1. **'), steps.indexOf(' 2. **'));
    assert.ok(step1.includes('org admin'), step1);
    assert.match(step1, /never take the caller's deletion/i);
    assert.match(step1, /pushes no deletion/);
  });
});

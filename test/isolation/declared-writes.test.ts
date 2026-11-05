// THE DECLARED-WRITES TRIPWIRE. For EVERY repository `makeDb()` returns, it proves:
//   (a) a method NAMED like a write (`upsert…`, `insert…`, `delete…`, `replace…`, `bulk…`) is
//       known to be one: it is on the kit's `WRITE_METHOD_NAMES`, or its repository declares it
//       under `DECLARED_WRITES` (src/data/declaredWrites.ts);
//   (b) every declared name is a real method on that repository, and the declaration is an array
//       of strings, so a typo or a wrong shape cannot pass for a declaration.
//
// Why it exists: the read ledger counts every method it does not know as a READ, on purpose
// (src/framework/readAudit.ts, property 3). A read that quietly records nothing is invisible, a
// spare row is not. But a write nobody declared files one false read row per call, and on an
// ingest route that is most of the ledger. This makes the undeclared write a red test instead of
// a quiet row.
//
// Why it lives in test/isolation/: like the uniformity tripwire next to it, it walks the app's
// LIVE registry (`makeDb()` here, `allRoutes` there), so a new repository is covered the moment it
// is added, and `/kit-upgrade` carries this directory into every fork (kit-upgrade SKILL.md step
// 3). That is the point of it. On upgrade, this test is what tells a fork which of its write
// methods to declare.
//
// What the naming rule does NOT catch: a write whose name starts with some other verb
// (`recordMigrations`, `setStatus`, `markSeen`). Declare those too. The rule is a floor that
// catches the common, unambiguous names, not a classifier, and unknown names still count as
// reads.
//
// What it does NOT check: that a declared method writes. It can flag a real read whose name starts
// with one of the verbs (a `bulkExport` that returns rows), and declaring that read turns the test
// green and removes the method from the trail for every caller. The failure message leads with the
// rename for that reason, and src/data/declaredWrites.ts says why a declaration is a reviewed
// decision.
//
// The fixture half judges its cases against a list it owns (`FIXTURE_WRITE_NAMES`), never the
// app's live `WRITE_METHOD_NAMES`: this file runs in every fork, and a fork may keep names of its
// own on that list.
import { env } from 'cloudflare:test';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { makeDb } from '../../src/data';
import { DECLARED_WRITES, declaredWritesOf } from '../../src/data/declaredWrites';
import type { Env } from '../../src/env';
import { WRITE_METHOD_NAMES } from '../../src/framework/readAudit';

/**
 * A name that reads as a write: one of the five verbs as a whole camelCase word. `deleteRule`,
 * `insert`, `bulkUpsert` and `replace2` match. `deletedSince` and `insertionOrder` do not, because
 * a past participle or a noun is how a READ is usually named ("rows deleted since…").
 */
const WRITE_NAMED = /^(?:upsert|insert|delete|replace|bulk)(?![a-z])/;

/**
 * Every callable member of a repository, own or inherited, so a class-shaped repository is walked
 * as fully as the kit's object literals. Read through descriptors, so enumerating a repository
 * never runs one of its getters.
 */
function methodNames(repo: object): Set<string> {
  const names = new Set<string>();
  for (let o: object | null = repo; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) {
    for (const key of Object.getOwnPropertyNames(o)) {
      if (key === 'constructor') continue;
      const desc = Object.getOwnPropertyDescriptor(o, key);
      if (desc && typeof desc.value === 'function') names.add(key);
    }
  }
  return names;
}

interface WriteAudit {
  /** Write-named methods that are neither on the global list nor declared. `repo.method`. */
  undeclared: string[];
  /** Declared names that are not a method on their repository (a typo, or a removed method). */
  phantom: string[];
  /** Repositories whose `DECLARED_WRITES` is present but is not an array of strings. */
  malformed: string[];
}

/**
 * The audit, against an EXPLICIT global list. The live-registry tests pass the app's own
 * `WRITE_METHOD_NAMES`; the fixture tests pass `FIXTURE_WRITE_NAMES`, a list they own, so a fork
 * that has added names to its copy of the global list cannot move a fixture's verdict.
 */
function auditDeclaredWrites(db: object, writeNames: ReadonlySet<string>): WriteAudit {
  const out: WriteAudit = { undeclared: [], phantom: [], malformed: [] };
  for (const [repoName, repo] of Object.entries(db)) {
    if (repo === null || typeof repo !== 'object') continue;
    const raw: unknown = Reflect.get(repo, DECLARED_WRITES);
    if (
      raw !== undefined &&
      !(Array.isArray(raw) && raw.every((name) => typeof name === 'string'))
    ) {
      out.malformed.push(repoName);
    }
    const declared = declaredWritesOf(repo);
    const methods = methodNames(repo);
    for (const name of methods) {
      if (!WRITE_NAMED.test(name)) continue;
      if (writeNames.has(name) || declared.has(name)) continue;
      out.undeclared.push(`${repoName}.${name}`);
    }
    for (const name of declared) {
      if (!methods.has(name)) out.phantom.push(`${repoName}.${name}`);
    }
  }
  out.undeclared.sort();
  out.phantom.sort();
  out.malformed.sort();
  return out;
}

const HOW_TO_DECLARE =
  'Each of these repository methods is named like a write but is not declared as one, so the ' +
  'read ledger files every call to it as a READ (one false read_log row per call when ' +
  'READ_AUDIT is armed).\n\n' +
  'First check that it really is a write. A method that hands stored rows back to its caller (a ' +
  'lookup, a list, an export such as `bulkExport`) is a READ: rename it, and do not declare it. ' +
  'A declared method is never attributed again, for any caller, people included, so declaring a ' +
  'read to turn this test green takes it out of the trail.\n\n' +
  'If it only writes, declare it on its repository object, next to the methods:\n\n' +
  "  import { DECLARED_WRITES } from './declaredWrites';\n" +
  '  return {\n' +
  "    [DECLARED_WRITES]: ['upsertBatch'],\n" +
  '    async upsertBatch(...) { ... },\n' +
  '  };\n\n' +
  'See src/data/declaredWrites.ts.';

describe('declared-writes tripwire: every makeDb() repository', () => {
  const db = makeDb(env as Env);

  it('walks real repositories and real methods (it cannot pass by finding nothing)', () => {
    const repos = Object.entries(db).filter(([, r]) => r !== null && typeof r === 'object');
    expect(repos.length).toBeGreaterThan(0);
    const total = repos.reduce((n, [, r]) => n + methodNames(r).size, 0);
    expect(total).toBeGreaterThan(repos.length);
    // The kit's own write-named methods are seen by the walk, which is what makes the empty
    // result below mean "all declared" rather than "never looked".
    expect(methodNames(db.audit).has('insert')).toBe(true);
    expect(methodNames(db.readLog).has('insertManyComplete')).toBe(true);
  });

  it('every write-named method is on the kit list or declared by its repository', () => {
    expect(auditDeclaredWrites(db, WRITE_METHOD_NAMES).undeclared, HOW_TO_DECLARE).toEqual([]);
  });

  it('every declaration is an array of real method names on its repository', () => {
    const { phantom, malformed } = auditDeclaredWrites(db, WRITE_METHOD_NAMES);
    expect(
      phantom,
      'These declared writes are not methods on their repository (a typo, or a method that was ' +
        'removed). A misspelled declaration excludes nothing, so the real write keeps recording ' +
        'as a read.',
    ).toEqual([]);
    expect(
      malformed,
      '[DECLARED_WRITES] must be an array of method-name strings on these repositories.',
    ).toEqual([]);
  });
});

/**
 * The global list every fixture below is judged against: two of the kit's names, which is enough
 * to show the list is honoured. Owned by this file on purpose, never the app's live
 * `WRITE_METHOD_NAMES`. `/kit-upgrade` carries this file into forks, and a fork may already keep
 * names of its own on its copy of that list (insights' A1.1 pilot adds `upsert` and
 * `upsertBatch`). Judged against the live list, a fixture that expects `upsertBatch` to be flagged
 * goes red in that fork, and no declaration can make it green.
 */
const FIXTURE_WRITE_NAMES: ReadonlySet<string> = new Set(['insert', 'insertUsage']);

const auditFixture = (repos: object): WriteAudit => auditDeclaredWrites(repos, FIXTURE_WRITE_NAMES);

/**
 * The rule itself, on fixtures. A function rather than one describe block, so the same cases run
 * twice below: once as the kit ships, and once inside a simulated fork.
 */
function ruleOnFixtures(): void {
  it('flags an undeclared write-named method by repo and name, and nothing read-shaped', () => {
    const fixture = {
      ledger: {
        async upsertDigests() {},
        async deleteRule() {},
        async bulkImport() {},
        async replaceAll() {},
        async insertEvent() {},
        // Read-shaped names that merely START with a verb's letters.
        async deletedSince() {},
        async insertionOrder() {},
        async listRules() {},
      },
    };
    expect(auditFixture(fixture).undeclared).toEqual([
      'ledger.bulkImport',
      'ledger.deleteRule',
      'ledger.insertEvent',
      'ledger.replaceAll',
      'ledger.upsertDigests',
    ]);
  });

  it('does not flag a name on the global list, which is how the kit repositories are covered', () => {
    const fixture = { audit: { async insert() {} }, aiBudget: { async insertUsage() {} } };
    expect(auditFixture(fixture)).toEqual({ undeclared: [], phantom: [], malformed: [] });
  });

  it("app-registry's ingest writes: flagged undeclared, clean once declared", () => {
    // The seven write methods POST /api/apps/ingest calls per report (app-registry
    // src/routes/apps.ts), across its two repositories. Unarmed today; armed, each report would
    // have filed seven false read rows.
    const apps = {
      async upsertBySource() {},
      async upsertStatus() {},
      async upsertManifest() {},
      async upsertObservedSecrets() {},
      async get() {},
    };
    const ledger = {
      async upsertDigests() {},
      async recordMigrations() {},
      async upsertReportState() {},
      async countIngest() {},
    };
    // Undeclared: the naming rule finds six. `recordMigrations` is a write it cannot see by name,
    // which is exactly why the declaration, not the rule, is what classifies.
    expect(auditFixture({ apps, ledger }).undeclared).toEqual([
      'apps.upsertBySource',
      'apps.upsertManifest',
      'apps.upsertObservedSecrets',
      'apps.upsertStatus',
      'ledger.upsertDigests',
      'ledger.upsertReportState',
    ]);
    const declared = {
      apps: {
        [DECLARED_WRITES]: [
          'upsertBySource',
          'upsertStatus',
          'upsertManifest',
          'upsertObservedSecrets',
        ],
        ...apps,
      },
      ledger: {
        [DECLARED_WRITES]: ['upsertDigests', 'recordMigrations', 'upsertReportState'],
        ...ledger,
      },
    };
    expect(auditFixture(declared)).toEqual({ undeclared: [], phantom: [], malformed: [] });
  });

  it('a declaration covers only its OWN repository', () => {
    const fixture = {
      a: { [DECLARED_WRITES]: ['upsertThing'], async upsertThing() {} },
      b: { async upsertThing() {} },
    };
    expect(auditFixture(fixture).undeclared).toEqual(['b.upsertThing']);
  });

  it('flags a misspelled declaration and a malformed one', () => {
    const fixture = {
      typo: { [DECLARED_WRITES]: ['upsertBach'], async upsertBatch() {} },
      shape: { [DECLARED_WRITES]: 'upsertBatch', async upsertBatch() {} },
      mixed: { [DECLARED_WRITES]: ['upsertBatch', 7], async upsertBatch() {} },
    };
    const audit = auditFixture(fixture);
    expect(audit.phantom).toEqual(['typo.upsertBach']);
    expect(audit.malformed).toEqual(['mixed', 'shape']);
    // …and the real write behind each bad declaration is still reported as undeclared, except
    // where a valid entry survived the bad one.
    expect(audit.undeclared).toEqual(['shape.upsertBatch', 'typo.upsertBatch']);
  });

  it('walks a class-shaped repository too, and never runs a getter while walking', () => {
    class Repo {
      async upsertRow() {}
      async list() {}
      get explodes(): never {
        throw new Error('a getter ran during the walk');
      }
    }
    expect(auditFixture({ rows: new Repo() }).undeclared).toEqual(['rows.upsertRow']);
  });
}

describe('declared-writes tripwire: the rule itself, on fixtures', ruleOnFixtures);

/**
 * Names a fork might have put on its OWN copy of `WRITE_METHOD_NAMES` before this release:
 * insights' A1.1 pilot adds `upsert` and `upsertBatch`, and il-Lingua-paved keeps about 45 of its
 * own there. The worst case is a fork whose list happens to hold every write-named method the
 * fixtures above use, so that is what this simulates.
 */
const FORK_LIST_ADDITIONS: ReadonlySet<string> = new Set([
  'upsert',
  'upsertBatch',
  'upsertDigests',
  'upsertBySource',
  'upsertStatus',
  'upsertManifest',
  'upsertObservedSecrets',
  'upsertReportState',
  'upsertThing',
  'upsertRow',
  'deleteRule',
  'bulkImport',
  'replaceAll',
  'insertEvent',
  'recordMigrations',
]);

describe('declared-writes tripwire: the same fixtures, in a fork that added names to its own WRITE_METHOD_NAMES', () => {
  // /kit-upgrade carries this file into every fork, next to that fork's copy of readAudit.ts. A
  // fixture verdict that moved with the fork's list would go red there for a reason no declaration
  // can fix (it did, on insights' A1.1 branch). So the live list is made to answer as such a
  // fork's would, and every fixture case above must still hold.
  beforeAll(() => {
    const kitHas = Set.prototype.has;
    vi.spyOn(WRITE_METHOD_NAMES, 'has').mockImplementation(
      (name: string) => FORK_LIST_ADDITIONS.has(name) || kitHas.call(WRITE_METHOD_NAMES, name),
    );
  });
  afterAll(() => {
    vi.restoreAllMocks();
  });

  it('simulates the fork: the live list now holds the fork names', () => {
    expect(WRITE_METHOD_NAMES.has('upsertBatch')).toBe(true);
    expect(WRITE_METHOD_NAMES.has('insert')).toBe(true);
  });

  ruleOnFixtures();
});

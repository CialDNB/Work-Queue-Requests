// The walk over what this app REALLY registers with the upstream read seam (PIA C15). It lives in
// its own file on purpose: test/data/upstream.test.ts registers synthetic reads and resets them
// after every test, and a walk that ran after those resets could only ever see an empty list.
// Here nothing synthetic is registered and nothing is reset, and the worker entry is imported so
// every module that registers a read at load — the seam itself, the integration modules, the
// routes — has run before the snapshot is taken.
//
// In the kit both lists are empty (it reads no upstream), so the loops are vacuous; they are the
// check a fork's first source and first read have to pass.
import { describe, expect, it } from 'vitest';
import type { ReadSourceClass } from '../../src/data/readLog';
import {
  __resetUpstreamRegistryForTest,
  registeredUpstreamReads,
  UPSTREAM_IDENTIFIER,
  UPSTREAM_SOURCES,
  upstreamSourceClass,
} from '../../src/data/upstream';
import '../../src/index';

// Taken at import, before any test body runs.
const AT_LOAD = [...registeredUpstreamReads()];

describe('the registered upstream sources and reads', () => {
  it('every shipped source is an identifier with a real class', () => {
    for (const [name, cls] of Object.entries(UPSTREAM_SOURCES) as [string, ReadSourceClass][]) {
      expect(name).toMatch(UPSTREAM_IDENTIFIER);
      expect(['client', 'internal']).toContain(cls);
    }
  });

  // The same shape read_log's CHECK enforces on an upstream row, so no registered read can be
  // refused by the table for its names — and each one's source resolves through the REVIEWED table.
  it('every read registered at load holds the identifier rule and a reviewed source', () => {
    for (const spec of AT_LOAD) {
      for (const value of [spec.source, spec.name, spec.target]) {
        expect(value).toMatch(UPSTREAM_IDENTIFIER);
      }
      expect(Object.isFrozen(spec)).toBe(true);
      expect(() => upstreamSourceClass(spec.source)).not.toThrow();
    }
    const keys = AT_LOAD.map((s) => `${s.source}.${s.name}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('a test reset never forgets a read a module registered for real', () => {
    __resetUpstreamRegistryForTest();
    expect([...registeredUpstreamReads()]).toEqual(AT_LOAD);
  });
});

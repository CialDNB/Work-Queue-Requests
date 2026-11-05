// The pure rules behind machine routes (src/framework/machine.ts): X-Sync-Run validation, the
// warn-only switch, and the audit payload cap. The request-level behaviour is pinned in
// test/framework/machine-routes.test.ts; these pin the edges without a request.
import { describe, expect, it } from 'vitest';
import {
  isValidSyncRunId,
  MACHINE_AUDIT_PAYLOAD_MAX_BYTES,
  machineAuditJson,
  machineAuditPayload,
  readSyncRun,
  SYNC_RUN_HEADER,
  syncRunMode,
} from '../../src/framework/machine';

describe('X-Sync-Run', () => {
  it('is the header the docs name, read case-insensitively', () => {
    expect(SYNC_RUN_HEADER).toBe('X-Sync-Run');
    expect(readSyncRun(new Headers({ 'x-sync-run': 'r1' }))).toEqual({
      runId: 'r1',
      problem: null,
    });
    expect(readSyncRun(new Headers({ 'X-SYNC-RUN': 'r1' }))).toEqual({
      runId: 'r1',
      problem: null,
    });
  });

  it('accepts exactly 1-64 characters of [A-Za-z0-9._:-]', () => {
    for (const ok of [
      'a',
      'Z',
      '0',
      '.',
      '_',
      ':',
      '-',
      'x'.repeat(64),
      'etl:2026-09-24T10:00Z.r_1',
    ]) {
      expect(isValidSyncRunId(ok)).toBe(true);
    }
    for (const bad of [
      '',
      'x'.repeat(65),
      'a b',
      'a/b',
      'a,b',
      'a+b',
      'a=b',
      'caf\u00E9',
      '\u0000',
    ]) {
      expect(isValidSyncRunId(bad)).toBe(false);
    }
    for (const notString of [null, undefined, 7, {}, ['a']]) {
      expect(isValidSyncRunId(notString)).toBe(false);
    }
  });

  it('missing and invalid are different problems, and an invalid value is never returned', () => {
    expect(readSyncRun(new Headers())).toEqual({ runId: null, problem: 'missing' });
    expect(readSyncRun(new Headers({ 'x-sync-run': 'a b' }))).toEqual({
      runId: null,
      problem: 'invalid',
    });
  });

  it('a header sent twice is invalid, never a guess at which copy was meant', () => {
    const headers = new Headers();
    headers.append('x-sync-run', 'run-a');
    headers.append('x-sync-run', 'run-b');
    expect(readSyncRun(headers)).toEqual({ runId: null, problem: 'invalid' });
  });

  it('only the word warn selects warn-only; everything else enforces', () => {
    for (const warn of ['warn', 'WARN', ' Warn ']) expect(syncRunMode(warn)).toBe('warn');
    for (const enforce of [
      undefined,
      '',
      'enforce',
      'warning',
      'warn-only',
      'off',
      'true',
      'false',
    ]) {
      expect(syncRunMode(enforce)).toBe('enforce');
    }
  });
});

describe('machineAuditJson — stamp and cap', () => {
  it('stamps runId on the payload, over any runId it carried', () => {
    expect(machineAuditJson({ a: 1, runId: 'forged' }, 'real')).toEqual({
      json: JSON.stringify({ a: 1, runId: 'real' }),
      oversizeBytes: null,
    });
    expect(machineAuditJson(undefined, null)).toEqual({
      json: JSON.stringify({ runId: null }),
      oversizeBytes: null,
    });
  });

  it('never mutates the handler payload', () => {
    const payload = { a: 1, runId: 'forged' };
    machineAuditJson(payload, 'real');
    expect(payload).toEqual({ a: 1, runId: 'forged' });
  });

  it('the cap is 1 KB of UTF-8, inclusive', () => {
    expect(MACHINE_AUDIT_PAYLOAD_MAX_BYTES).toBe(1024);
    const frame = JSON.stringify({ pad: '', runId: null }).length;
    const at = machineAuditJson({ pad: 'p'.repeat(1024 - frame) }, null);
    expect(at.oversizeBytes).toBeNull();
    const over = machineAuditJson({ pad: 'p'.repeat(1025 - frame) }, null);
    expect(over.oversizeBytes).toBe(1025);
    expect(JSON.parse(over.json)).toEqual({ oversize: true, bytes: 1025, runId: null });
  });

  it('machineAuditPayload is the same rule as an object (what executeRoute attributes), never mutating', () => {
    const payload = { a: 1, runId: 'forged' };
    expect(machineAuditPayload(payload, 'real')).toEqual({
      payload: { a: 1, runId: 'real' },
      oversizeBytes: null,
    });
    expect(payload).toEqual({ a: 1, runId: 'forged' });
    const frame = JSON.stringify({ pad: '', runId: null }).length;
    const over = machineAuditPayload({ pad: 'p'.repeat(1025 - frame), suppressed: true }, null);
    expect(over.oversizeBytes).toBe(1025 + ',"suppressed":true'.length);
    expect(over.payload).toEqual({
      oversize: true,
      bytes: 1025 + ',"suppressed":true'.length,
      runId: null,
      suppressed: true,
    });
    // machineAuditJson is exactly its JSON.
    for (const p of [{ a: 1 }, { pad: 'p'.repeat(2000) }, undefined]) {
      expect(machineAuditJson(p, 'r')).toEqual({
        json: JSON.stringify(machineAuditPayload(p, 'r').payload),
        oversizeBytes: machineAuditPayload(p, 'r').oversizeBytes,
      });
    }
  });

  it('keeps suppressed: true through the cap, and only a literal true', () => {
    const big = 'b'.repeat(2000);
    expect(JSON.parse(machineAuditJson({ suppressed: true, big }, 'r').json)).toMatchObject({
      oversize: true,
      suppressed: true,
    });
    for (const notTrue of ['true', 1, false]) {
      expect(
        JSON.parse(machineAuditJson({ suppressed: notTrue, big }, 'r').json),
      ).not.toHaveProperty('suppressed');
    }
  });
});

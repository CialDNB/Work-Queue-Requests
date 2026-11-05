import { env } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runBackup } from '../../src/cron/backup';
import { runRestoreVerify } from '../../src/cron/restoreVerify';
import type { Env } from '../../src/env';
import { applySchema, seedDb } from '../helpers/db';

// Recompress a set of JSONL lines into a gzipped R2 body, mirroring backup.ts's writer — used
// to plant a TAMPERED backup (truncated / count-mismatched) at the marker's key.
async function gzipLines(lines: string[]): Promise<ArrayBuffer> {
  const { readable, writable } = new CompressionStream('gzip');
  const writer = writable.getWriter();
  const enc = new TextEncoder();
  const compressed = new Response(readable).arrayBuffer();
  await writer.write(enc.encode(lines.join('\n')));
  await writer.close();
  return compressed;
}

// Read the marker written by runBackup so a test can tamper against its declared counts.
async function readMarker(): Promise<{ key: string; tables: number; rows: number }> {
  const obj = await env.BACKUPS!.get('db-backups/latest-marker');
  return (await obj!.json()) as { key: string; tables: number; rows: number };
}

describe('restore_verify cron', () => {
  beforeAll(applySchema);
  beforeEach(seedDb);

  it('is dormant (skips) when the BACKUPS binding is absent', async () => {
    const detail = await runRestoreVerify({ ...env, BACKUPS: undefined } as Env);
    expect(detail).toMatch(/skipped/);
    expect(detail).toMatch(/BACKUPS binding absent/);
  });

  it('skips (does not throw) on a brand-new app with no backup yet', async () => {
    // No runBackup has been called and seedDb clears heartbeat/health KV — R2 has no marker.
    // Ensure the marker really is absent for this test (isolated storage, but be explicit).
    await env.BACKUPS!.delete('db-backups/latest-marker');
    const detail = await runRestoreVerify(env);
    expect(detail).toMatch(/skipped/);
    expect(detail).toMatch(/no backup yet/);
  });

  it('verifies a freshly written backup as complete and consistent (green)', async () => {
    // Create a real backup first, then verify it end-to-end.
    await runBackup(env);
    const detail = await runRestoreVerify(env);
    expect(detail).toMatch(/^restore-verify: \d+ tables, \d+ rows, consistent/);

    // The counts it reports must match the marker the backup wrote.
    const marker = await readMarker();
    expect(detail).toContain(`${marker.tables} tables`);
    expect(detail).toContain(`${marker.rows} rows`);
  });

  it('throws when the backup object the marker points at is missing', async () => {
    await runBackup(env);
    const marker = await readMarker();
    await env.BACKUPS!.delete(marker.key); // marker still points at a now-gone object
    await expect(runRestoreVerify(env)).rejects.toThrow(/is missing/);
  });

  it('throws when the backup is truncated (a data row is cut off)', async () => {
    await runBackup(env);
    const marker = await readMarker();
    // Rebuild the dump with the LAST data row dropped: fewer rows than the marker declares.
    const gz = await env.BACKUPS!.get(marker.key);
    const text = await new Response(gz!.body.pipeThrough(new DecompressionStream('gzip'))).text();
    const lines = text.split('\n');
    const truncated = lines.slice(0, -1); // drop one data row → count mismatch
    await env.BACKUPS!.put(marker.key, await gzipLines(truncated));
    await expect(runRestoreVerify(env)).rejects.toThrow(/truncated or inconsistent|data rows/);
  });

  it('throws on a count mismatch even when every line is valid JSON', async () => {
    await runBackup(env);
    const marker = await readMarker();
    const gz = await env.BACKUPS!.get(marker.key);
    const text = await new Response(gz!.body.pipeThrough(new DecompressionStream('gzip'))).text();
    const lines = text.split('\n');
    // Append an EXTRA well-formed row for a known table → more rows than the marker declares.
    const header = JSON.parse(lines[0] as string) as { tables: string[] };
    const extra = JSON.stringify({ _table: header.tables[0], _synthetic: 'extra-row' });
    await env.BACKUPS!.put(marker.key, await gzipLines([...lines, extra]));
    await expect(runRestoreVerify(env)).rejects.toThrow(/inconsistent|data rows/);
  });

  it('throws when a data line is not valid JSON (corruption)', async () => {
    await runBackup(env);
    const marker = await readMarker();
    const gz = await env.BACKUPS!.get(marker.key);
    const text = await new Response(gz!.body.pipeThrough(new DecompressionStream('gzip'))).text();
    const lines = text.split('\n');
    lines.splice(1, 0, '{not valid json'); // inject a garbage line after the header
    await env.BACKUPS!.put(marker.key, await gzipLines(lines));
    await expect(runRestoreVerify(env)).rejects.toThrow(/not valid JSON/);
  });

  it('throws when the marker is present but unparseable', async () => {
    await env.BACKUPS!.put('db-backups/latest-marker', 'not-json-at-all');
    await expect(runRestoreVerify(env)).rejects.toThrow(/unparseable|missing its key/);
  });

  it('throws when the meta header table count disagrees with the marker', async () => {
    await runBackup(env);
    const marker = await readMarker();
    const gz = await env.BACKUPS!.get(marker.key);
    const text = await new Response(gz!.body.pipeThrough(new DecompressionStream('gzip'))).text();
    const lines = text.split('\n');
    const header = JSON.parse(lines[0] as string) as { tables: string[] };
    header.tables = header.tables.slice(0, -1); // header now lists fewer tables than declared
    lines[0] = JSON.stringify(header);
    await env.BACKUPS!.put(marker.key, await gzipLines(lines));
    await expect(runRestoreVerify(env)).rejects.toThrow(/tables but marker declares/);
  });

  it('copies the verified backup offsite when the dormant VAULT binding is armed', async () => {
    await runBackup(env);
    const marker = await readMarker();
    // Minimal fake VAULT: record the key + bytes it receives.
    const puts: { key: string; bytes: number }[] = [];
    const vault = {
      async put(key: string, body: ReadableStream) {
        const buf = await new Response(body).arrayBuffer();
        puts.push({ key, bytes: buf.byteLength });
        return {};
      },
    } as unknown as R2Bucket;

    const detail = await runRestoreVerify({ ...env, VAULT: vault } as Env);
    expect(detail).toMatch(/consistent/);
    expect(detail).toMatch(/vault: copied offsite/);
    expect(puts).toHaveLength(1);
    expect(puts[0]!.key).toBe(marker.key); // same key, offsite
    expect(puts[0]!.bytes).toBeGreaterThan(0);
  });

  it('does not fail the verify when the VAULT copy errors (best-effort offsite)', async () => {
    await runBackup(env);
    const vault = {
      put() {
        throw new Error('vault unreachable');
      },
    } as unknown as R2Bucket;

    // The verify itself succeeded; a broken offsite copy only logs + notes, never throws.
    const detail = await runRestoreVerify({ ...env, VAULT: vault } as Env);
    expect(detail).toMatch(/consistent/);
    expect(detail).toMatch(/vault: copy failed, logged/);
  });
});

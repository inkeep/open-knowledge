/**
 * Unit tests for the bug-report sidecar store — write/read/list/delete,
 * retention, forgiving reads, containment, the in-flight lock, and the
 * send-path state transitions — all against a temp bug-reports directory.
 *
 * The filesystem IS the contract here: every assertion reads the on-disk
 * sidecar (or the presence/absence of the zip) rather than a recording double,
 * so the state machine and retention invariants are proven against real files.
 */

import { existsSync, mkdtempSync, rmSync, truncateSync, utimesSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { ReportSidecar } from '@inkeep/open-knowledge-core';
import { afterEach, describe, expect, test } from 'vitest';
import {
  createBugReportSidecarStore,
  createInFlightRegistry,
  deleteReport,
  listReports,
  readReportSidecar,
  reconcileStaleUploading,
  runRetentionSweep,
  sidecarPathForId,
  writeReportSidecar,
  zipPathForId,
} from './bug-report-sidecar.ts';
import {
  MAX_SENT_TOMBSTONE_COUNT,
  MAX_UNSENT_REPORT_BYTES,
  MAX_UNSENT_REPORT_COUNT,
} from './ipc/bug-report.ts';

const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = mkdtempSync(resolve(tmpdir(), 'ok-bugreport-sidecar-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const d of tmpDirs) {
    if (existsSync(d)) rmSync(d, { recursive: true, force: true });
  }
  tmpDirs.length = 0;
});

/** Indexed access that asserts presence (tests control the arrays). */
function nth<T>(arr: readonly T[], index: number): T {
  const value = arr.at(index);
  if (value === undefined) throw new Error(`no element at index ${index}`);
  return value;
}

/** A valid report id (timestamp-basename shape) whose seconds/counter order it. */
function rid(seconds: number, counter?: number): string {
  const ss = String(seconds).padStart(2, '0');
  return `2026-07-15T18-30-${ss}-000Z-bugreport${counter ? `-${counter}` : ''}.zip`;
}

/** The ISO createdAt that matches an `rid(seconds)` so on-disk order is deterministic. */
function ridCreatedAt(seconds: number): string {
  return `2026-07-15T18:30:${String(seconds).padStart(2, '0')}.000Z`;
}

function seedZip(dir: string, id: string, bytes = 128): void {
  const path = join(dir, id);
  writeFileSync(path, Buffer.alloc(bytes));
}

/**
 * Seed a report whose zip *reports* `bytes` to `stat` without occupying them:
 * `truncate` extends the file sparsely, so the byte-budget cap can be driven
 * past its 1 GiB threshold without writing a gigabyte to a temp dir. Retention
 * sizes bundles from `stat().size`, which counts the sparse length.
 */
async function seedSparseReport(
  dir: string,
  seconds: number,
  bytes: number,
  overrides: Partial<ReportSidecar> = {},
): Promise<string> {
  const id = rid(seconds);
  const path = join(dir, id);
  writeFileSync(path, '');
  truncateSync(path, bytes);
  await writeReportSidecar(
    dir,
    makeSidecar({ id, createdAt: ridCreatedAt(seconds), zipBytes: bytes, ...overrides }),
  );
  return id;
}

function makeSidecar(overrides: Partial<ReportSidecar> & { id: string }): ReportSidecar {
  return {
    version: 1,
    createdAt: ridCreatedAt(0),
    bundleLevel: 'standard',
    zipBytes: 128,
    state: 'generated',
    systemWide: false,
    projectSlug: 'demo',
    ...overrides,
  };
}

async function seedReport(
  dir: string,
  seconds: number,
  overrides: Partial<ReportSidecar> = {},
): Promise<string> {
  const id = rid(seconds);
  seedZip(dir, id);
  await writeReportSidecar(
    dir,
    makeSidecar({ id, createdAt: ridCreatedAt(seconds), ...overrides }),
  );
  return id;
}

describe('writeReportSidecar / readReportSidecar', () => {
  test('round-trips a generated sidecar to disk as YAML next to the zip', async () => {
    const dir = makeTmpDir();
    const id = rid(1);
    await writeReportSidecar(dir, makeSidecar({ id, state: 'generated' }));

    expect(existsSync(sidecarPathForId(dir, id))).toBe(true);
    const raw = await readFile(sidecarPathForId(dir, id), 'utf-8');
    // A YAML document, not JSON — the reader parses it back.
    expect(raw).toContain('state: generated');

    const parsed = await readReportSidecar(sidecarPathForId(dir, id));
    expect(parsed?.id).toBe(id);
    expect(parsed?.state).toBe('generated');
    expect(parsed?.projectSlug).toBe('demo');
  });

  test('reading an absent sidecar returns null (forgiving)', async () => {
    const dir = makeTmpDir();
    expect(await readReportSidecar(sidecarPathForId(dir, rid(1)))).toBeNull();
  });

  test('recordGenerated persists the note it was handed', async () => {
    const dir = makeTmpDir();
    const id = rid(1);
    seedZip(dir, id);
    const store = createBugReportSidecarStore({ dir });

    await store.recordGenerated({
      zipPath: zipPathForId(dir, id),
      zipBytes: 128,
      level: 'standard',
      systemWide: false,
      projectSlug: 'demo',
      note: 'sync hung on a large repo',
    });

    expect((await readReportSidecar(sidecarPathForId(dir, id)))?.note).toBe(
      'sync hung on a large repo',
    );
  });

  test('recordGenerated without a note writes no note key at all', async () => {
    const dir = makeTmpDir();
    const id = rid(1);
    seedZip(dir, id);
    const store = createBugReportSidecarStore({ dir });

    await store.recordGenerated({
      zipPath: zipPathForId(dir, id),
      zipBytes: 128,
      level: 'standard',
      systemWide: false,
      projectSlug: 'demo',
    });

    const sidecar = await readReportSidecar(sidecarPathForId(dir, id));
    expect(sidecar).not.toBeNull();
    expect(sidecar && 'note' in sidecar).toBe(false);
  });
});

describe('listReports — states and ordering', () => {
  test('returns rows newest-first with the right state, retryability and reference', async () => {
    const dir = makeTmpDir();
    await seedReport(dir, 1, { state: 'upload-failed', lastError: { reason: 'offline', at: 'x' } });
    await seedReport(dir, 3, { state: 'generated' });
    const sentId = rid(2);
    // A sent tombstone: sidecar present, zip already reclaimed.
    await writeReportSidecar(
      dir,
      makeSidecar({
        id: sentId,
        createdAt: ridCreatedAt(2),
        state: 'sent',
        reference: 'OK-42',
        zipDeleted: true,
      }),
    );

    const result = await listReports(dir);
    if (!result.ok) throw new Error(`expected ok, got ${result.reason}`);
    expect(result.reports.map((r) => r.id)).toEqual([rid(3), rid(2), rid(1)]);

    const [generated, sent, failed] = result.reports;
    expect(generated?.state).toBe('generated');
    expect(generated?.retryable).toBe(true);
    expect(sent?.state).toBe('sent');
    expect(sent?.reference).toBe('OK-42');
    expect(sent?.retryable).toBe(false);
    expect(sent?.zipExists).toBe(false);
    expect(failed?.state).toBe('upload-failed');
    expect(failed?.retryable).toBe(true);
    expect(failed?.lastError?.reason).toBe('offline');
  });

  test('a row carries the sidecar note, and omits it when the sidecar has none', async () => {
    const dir = makeTmpDir();
    await seedReport(dir, 1, { note: 'the editor froze after a paste' });
    await seedReport(dir, 2);

    const result = await listReports(dir);
    if (!result.ok) throw new Error(`expected ok, got ${result.reason}`);

    const [withoutNote, withNote] = result.reports;
    expect(withNote?.note).toBe('the editor froze after a paste');
    expect(withoutNote && 'note' in withoutNote).toBe(false);
  });
});

describe('listReports — forgiving reads (FR9)', () => {
  test('a legacy zip with no sidecar renders as a retryable generated row', async () => {
    const dir = makeTmpDir();
    const id = rid(5);
    seedZip(dir, id);

    const result = await listReports(dir);
    if (!result.ok) throw new Error('expected ok');
    const row = result.reports.find((r) => r.id === id);
    expect(row?.state).toBe('generated');
    expect(row?.retryable).toBe(true);
    expect(row?.degraded).toBe(false);
  });

  test('a corrupt sidecar renders as a degraded unknown row without breaking the list', async () => {
    const dir = makeTmpDir();
    const goodId = await seedReport(dir, 2, { state: 'generated' });
    const badId = rid(1);
    seedZip(dir, badId);
    // A sidecar file present but neither valid YAML for the schema nor parseable.
    writeFileSync(sidecarPathForId(dir, badId), 'id: [unterminated\n  : : :');

    const result = await listReports(dir);
    if (!result.ok) throw new Error('expected ok');
    expect(result.reports.map((r) => r.id).sort()).toEqual([badId, goodId].sort());
    const bad = result.reports.find((r) => r.id === badId);
    expect(bad?.state).toBe('unknown');
    expect(bad?.degraded).toBe(true);
  });

  test('an unknown state and a newer version both render (open enum, best-effort)', async () => {
    const dir = makeTmpDir();
    const unknownId = rid(1);
    seedZip(dir, unknownId);
    await writeReportSidecar(
      dir,
      makeSidecar({ id: unknownId, state: 'quarantined' as ReportSidecar['state'] }),
    );
    const newerId = rid(2);
    seedZip(dir, newerId);
    await writeReportSidecar(dir, makeSidecar({ id: newerId, version: 999, state: 'generated' }));

    const result = await listReports(dir);
    if (!result.ok) throw new Error('expected ok');
    expect(result.reports.find((r) => r.id === unknownId)?.state).toBe('unknown');
    expect(result.reports.find((r) => r.id === unknownId)?.degraded).toBe(true);
    // Newer version still parses and renders its known state.
    expect(result.reports.find((r) => r.id === newerId)?.state).toBe('generated');
  });
});

describe('deleteReport — containment and in-flight', () => {
  test('deletes a valid report zip + sidecar', async () => {
    const dir = makeTmpDir();
    const id = await seedReport(dir, 1);
    const inFlight = createInFlightRegistry();

    expect(await deleteReport(dir, id, inFlight)).toEqual({ ok: true });
    expect(existsSync(zipPathForId(dir, id))).toBe(false);
    expect(existsSync(sidecarPathForId(dir, id))).toBe(false);
  });

  test('refuses a non-report-shaped id, a traversal, and a relative id', async () => {
    const dir = makeTmpDir();
    const inFlight = createInFlightRegistry();
    for (const badId of ['../escape.zip', 'report.zip', '/etc/passwd', 'not-a-report.txt']) {
      const result = await deleteReport(dir, badId, inFlight);
      expect(result).toEqual({ ok: false, reason: 'id-invalid' });
    }
  });

  test('returns not-found when neither zip nor sidecar exists', async () => {
    const dir = makeTmpDir();
    expect(await deleteReport(dir, rid(9), createInFlightRegistry())).toEqual({
      ok: false,
      reason: 'not-found',
    });
  });

  test('refuses to delete a report whose send is in flight', async () => {
    const dir = makeTmpDir();
    const id = await seedReport(dir, 1);
    const inFlight = createInFlightRegistry();
    inFlight.add(id);

    expect(await deleteReport(dir, id, inFlight)).toEqual({ ok: false, reason: 'in-flight' });
    expect(existsSync(zipPathForId(dir, id))).toBe(true);
  });
});

describe('send hooks — state transitions and in-flight lock', () => {
  test('onSendStart marks uploading and blocks a second concurrent send', async () => {
    const dir = makeTmpDir();
    const id = await seedReport(dir, 1, { state: 'generated' });
    const store = createBugReportSidecarStore({ dir });

    expect(await store.sendHooks.onSendStart(id)).toEqual({ proceed: true });
    expect((await readReportSidecar(sidecarPathForId(dir, id)))?.state).toBe('uploading');
    // A second retry while the first is in flight is refused.
    expect(await store.sendHooks.onSendStart(id)).toEqual({ proceed: false });
  });

  test('a synthesized sidecar claims no project, so the row can never be titled by one', async () => {
    const dir = makeTmpDir();
    const id = rid(1);
    // A sidecar-less bundle, as the CLI writes: the first retry synthesizes a
    // record for it. That record asserts a bundle level and a system-wide flag
    // nobody supplied, which is why the row title may lean on neither. The slug
    // is the one identity signal synthesis cannot invent, and it must stay null
    // or an untitled report starts claiming a project it never came from.
    seedZip(dir, id);
    const store = createBugReportSidecarStore({ dir });

    expect(await store.sendHooks.onSendStart(id)).toEqual({ proceed: true });

    const synthesized = await readReportSidecar(sidecarPathForId(dir, id));
    expect(synthesized).not.toBeNull();
    expect(synthesized?.projectSlug ?? null).toBeNull();
    expect(synthesized && 'note' in synthesized).toBe(false);
  });

  test('a sent result records the reference, appends an attempt, and reclaims the zip', async () => {
    const dir = makeTmpDir();
    const id = await seedReport(dir, 1, {
      state: 'generated',
      note: 'the editor froze after a paste',
    });
    const store = createBugReportSidecarStore({ dir });

    await store.sendHooks.onSendStart(id);
    await store.sendHooks.onSendResult(id, { kind: 'sent', reference: 'OK-777' });

    const sidecar = await readReportSidecar(sidecarPathForId(dir, id));
    expect(sidecar?.state).toBe('sent');
    expect(sidecar?.reference).toBe('OK-777');
    expect(sidecar?.zipDeleted).toBe(true);
    expect(sidecar?.attempts?.at(-1)).toMatchObject({ transport: 'upload', outcome: 'success' });
    expect(sidecar?.note).toBe('the editor froze after a paste');
    // The confirmed-sent zip is reclaimed, its tombstone sidecar kept.
    expect(existsSync(zipPathForId(dir, id))).toBe(false);
    expect(existsSync(sidecarPathForId(dir, id))).toBe(true);
    // The lock is released, so a later op on the same id is allowed.
    expect(await store.sendHooks.onSendStart(id)).toEqual({ proceed: true });
  });

  test('an upload-failed result records the reason and stays retryable', async () => {
    const dir = makeTmpDir();
    const id = await seedReport(dir, 1, {
      state: 'generated',
      note: 'the editor froze after a paste',
    });
    const store = createBugReportSidecarStore({ dir });

    await store.sendHooks.onSendStart(id);
    await store.sendHooks.onSendResult(id, {
      kind: 'upload-failed',
      reason: 'complete-rejected: 503',
    });

    const sidecar = await readReportSidecar(sidecarPathForId(dir, id));
    expect(sidecar?.state).toBe('upload-failed');
    expect(sidecar?.lastError?.reason).toBe('complete-rejected: 503');
    expect(sidecar?.attempts?.at(-1)).toMatchObject({ transport: 'upload', outcome: 'failed' });
    expect(sidecar?.note).toBe('the editor froze after a paste');
    expect(existsSync(zipPathForId(dir, id))).toBe(true);
  });

  test('an email-drafted result records the email transport without touching the zip', async () => {
    const dir = makeTmpDir();
    const id = await seedReport(dir, 1, {
      state: 'generated',
      note: 'the editor froze after a paste',
    });
    const store = createBugReportSidecarStore({ dir });

    await store.sendHooks.onSendResult(id, { kind: 'email-drafted' });

    const sidecar = await readReportSidecar(sidecarPathForId(dir, id));
    expect(sidecar?.state).toBe('email-drafted');
    expect(sidecar?.attempts?.at(-1)).toMatchObject({ transport: 'email' });
    expect(sidecar?.note).toBe('the editor froze after a paste');
    expect(existsSync(zipPathForId(dir, id))).toBe(true);
  });
});

describe('runRetentionSweep', () => {
  test('drops the zip on a confirmed send and keeps the sidecar tombstone', async () => {
    const dir = makeTmpDir();
    const id = await seedReport(dir, 1, { state: 'sent', reference: 'OK-1' });

    await runRetentionSweep(dir, createInFlightRegistry());

    expect(existsSync(zipPathForId(dir, id))).toBe(false);
    expect((await readReportSidecar(sidecarPathForId(dir, id)))?.zipDeleted).toBe(true);
  });

  test('the tombstone write keeps the note after the zip is reclaimed', async () => {
    const dir = makeTmpDir();
    const note = 'the editor froze after I pasted a large table';
    const id = await seedReport(dir, 1, { state: 'sent', reference: 'OK-1', note });

    await runRetentionSweep(dir, createInFlightRegistry());

    // The zip that held the reporter's words is gone, so the sidecar is now the
    // only local copy. A tombstone that dropped it would leave the row that
    // most needs a title permanently unable to have one.
    const sidecar = await readReportSidecar(sidecarPathForId(dir, id));
    expect(sidecar?.zipDeleted).toBe(true);
    expect(sidecar?.note).toBe(note);
  });

  test('evicts the oldest unsent over the count cap but never the newest', async () => {
    const dir = makeTmpDir();
    const total = MAX_UNSENT_REPORT_COUNT + 2;
    const ids: string[] = [];
    for (let i = 1; i <= total; i += 1) ids.push(await seedReport(dir, i, { state: 'generated' }));

    await runRetentionSweep(dir, createInFlightRegistry());

    // The two oldest are evicted; the newest is always kept.
    expect(existsSync(zipPathForId(dir, nth(ids, 0)))).toBe(false);
    expect(existsSync(zipPathForId(dir, nth(ids, 1)))).toBe(false);
    expect(existsSync(zipPathForId(dir, nth(ids, -1)))).toBe(true);
    const remaining = (await listReports(dir)) as { ok: true; reports: unknown[] };
    expect(remaining.reports.length).toBe(MAX_UNSENT_REPORT_COUNT);
  });

  test('never evicts an uploading bundle even when it is the oldest', async () => {
    const dir = makeTmpDir();
    const total = MAX_UNSENT_REPORT_COUNT + 2;
    const ids: string[] = [];
    for (let i = 1; i <= total; i += 1) {
      ids.push(await seedReport(dir, i, { state: i === 1 ? 'uploading' : 'generated' }));
    }

    await runRetentionSweep(dir, createInFlightRegistry());

    // The oldest is `uploading` → skipped; the next two oldest are evicted instead.
    expect(existsSync(zipPathForId(dir, nth(ids, 0)))).toBe(true);
    expect(existsSync(zipPathForId(dir, nth(ids, 1)))).toBe(false);
    expect(existsSync(zipPathForId(dir, nth(ids, 2)))).toBe(false);
  });

  test('never evicts a bundle whose send is in flight', async () => {
    const dir = makeTmpDir();
    const total = MAX_UNSENT_REPORT_COUNT + 1;
    const ids: string[] = [];
    for (let i = 1; i <= total; i += 1) ids.push(await seedReport(dir, i, { state: 'generated' }));
    const inFlight = createInFlightRegistry();
    inFlight.add(nth(ids, 0)); // the oldest is mid-send

    await runRetentionSweep(dir, inFlight);

    expect(existsSync(zipPathForId(dir, nth(ids, 0)))).toBe(true);
    // The next oldest is evicted to satisfy the cap instead.
    expect(existsSync(zipPathForId(dir, nth(ids, 1)))).toBe(false);
  });

  test('evicts on the byte budget alone, with the count cap never exceeded', async () => {
    const dir = makeTmpDir();
    // Three bundles at 40% of the budget each: 120% of the byte cap, but only
    // 3 of the 10 allowed by the count cap. Eviction here can only be driven by
    // the byte condition — drop it and nothing is reclaimed.
    const chunk = Math.floor(MAX_UNSENT_REPORT_BYTES * 0.4);
    const ids: string[] = [];
    for (let i = 1; i <= 3; i += 1) ids.push(await seedSparseReport(dir, i, chunk));
    expect(ids.length).toBeLessThan(MAX_UNSENT_REPORT_COUNT);

    await runRetentionSweep(dir, createInFlightRegistry());

    // Evicting the oldest brings the total to 80% of the budget, so the sweep
    // stops there — the remaining two (including the newest) stay.
    expect(existsSync(zipPathForId(dir, nth(ids, 0)))).toBe(false);
    expect(existsSync(sidecarPathForId(dir, nth(ids, 0)))).toBe(false);
    expect(existsSync(zipPathForId(dir, nth(ids, 1)))).toBe(true);
    expect(existsSync(zipPathForId(dir, nth(ids, -1)))).toBe(true);
  });

  test('keeps the newest unsent bundle even when it alone busts the byte budget', async () => {
    const dir = makeTmpDir();
    const older = await seedSparseReport(dir, 1, 1024);
    const huge = await seedSparseReport(dir, 2, MAX_UNSENT_REPORT_BYTES * 2);

    await runRetentionSweep(dir, createInFlightRegistry());

    // The residual over-budget state is the intended invariant: never strand a
    // user with no bundle to retry, even when the only one left is oversized.
    expect(existsSync(zipPathForId(dir, older))).toBe(false);
    expect(existsSync(zipPathForId(dir, huge))).toBe(true);
  });

  test('reclaims an unreadable sidecar whose bundle is already gone', async () => {
    const dir = makeTmpDir();
    const orphanId = rid(1);
    // Sidecar file present but unparseable, with no zip beside it: it is
    // neither a sent tombstone nor an unsent bundle, so without an explicit
    // sweep it belongs to no cap and accumulates forever.
    writeFileSync(sidecarPathForId(dir, orphanId), 'id: [unterminated\n  : : :');
    const liveId = await seedReport(dir, 2, { state: 'generated' });

    await runRetentionSweep(dir, createInFlightRegistry());

    expect(existsSync(sidecarPathForId(dir, orphanId))).toBe(false);
    expect(existsSync(zipPathForId(dir, liveId))).toBe(true);
  });

  test('keeps a forward-compatible sidecar with an unrecognized state and no zip', async () => {
    const dir = makeTmpDir();
    const futureId = rid(1);
    // A newer app wrote a state this build normalizes to `unknown`. It PARSES,
    // so it is not the corrupt case — reclaiming it would defeat the open-enum
    // forward compatibility the schema exists for.
    await writeReportSidecar(
      dir,
      makeSidecar({
        id: futureId,
        createdAt: ridCreatedAt(1),
        state: 'paused' as ReportSidecar['state'],
        zipDeleted: true,
      }),
    );

    await runRetentionSweep(dir, createInFlightRegistry());

    expect(existsSync(sidecarPathForId(dir, futureId))).toBe(true);
  });

  test('bounds sent tombstones by their own count cap, oldest first', async () => {
    const dir = makeTmpDir();
    const total = MAX_SENT_TOMBSTONE_COUNT + 3;
    const ids: string[] = [];
    for (let i = 1; i <= total; i += 1) {
      const id = rid(i);
      ids.push(id);
      await writeReportSidecar(
        dir,
        makeSidecar({
          id,
          createdAt: ridCreatedAt(i),
          state: 'sent',
          reference: `OK-${i}`,
          zipDeleted: true,
        }),
      );
    }

    await runRetentionSweep(dir, createInFlightRegistry());

    // The three oldest tombstone sidecars are removed.
    expect(existsSync(sidecarPathForId(dir, nth(ids, 0)))).toBe(false);
    expect(existsSync(sidecarPathForId(dir, nth(ids, 2)))).toBe(false);
    expect(existsSync(sidecarPathForId(dir, nth(ids, -1)))).toBe(true);
  });
});

describe('reconcileStaleUploading', () => {
  test('demotes a stale uploading sidecar to upload-failed at boot', async () => {
    const dir = makeTmpDir();
    const staleId = await seedReport(dir, 1, {
      state: 'uploading',
      note: 'the editor froze after a paste',
    });
    const okId = await seedReport(dir, 2, { state: 'generated' });

    const reconciled = await reconcileStaleUploading(dir);
    expect(reconciled).toBe(1);

    const stale = await readReportSidecar(sidecarPathForId(dir, staleId));
    expect(stale?.state).toBe('upload-failed');
    expect(stale?.lastError?.reason).toBe('interrupted-by-restart');
    expect(stale?.note).toBe('the editor froze after a paste');
    // A non-uploading sidecar is untouched.
    expect((await readReportSidecar(sidecarPathForId(dir, okId)))?.state).toBe('generated');
  });
});

describe('legacy zip mtime ordering', () => {
  test('a sidecar-less zip sorts by its file mtime', async () => {
    const dir = makeTmpDir();
    const older = rid(1);
    const newer = rid(2);
    seedZip(dir, older);
    seedZip(dir, newer);
    utimesSync(
      join(dir, older),
      new Date('2026-07-15T18:30:01.000Z'),
      new Date('2026-07-15T18:30:01.000Z'),
    );
    utimesSync(
      join(dir, newer),
      new Date('2026-07-15T18:30:09.000Z'),
      new Date('2026-07-15T18:30:09.000Z'),
    );

    const result = await listReports(dir);
    if (!result.ok) throw new Error('expected ok');
    expect(result.reports.map((r) => r.id)).toEqual([newer, older]);
  });
});

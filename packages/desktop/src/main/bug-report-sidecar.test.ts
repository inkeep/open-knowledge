import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  truncateSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { ReportSidecar } from '@inkeep/open-knowledge-core';
import { afterEach, describe, expect, test } from 'vitest';
import {
  createBugReportSidecarStore,
  createInFlightRegistry,
  createSidecarScanWarnRegistry,
  deleteReport,
  listReports,
  MAX_REMEMBERED_SCAN_WARNINGS,
  readReportSidecar,
  reconcileStaleUploading,
  runRetentionSweep,
  sentMarkerPathForId,
  sidecarPathForId,
  writeReportSidecar,
  zipPathForId,
} from './bug-report-sidecar.ts';
import {
  MAX_SENT_TOMBSTONE_COUNT,
  MAX_UNSENT_REPORT_BYTES,
  MAX_UNSENT_REPORT_COUNT,
} from './ipc/bug-report.ts';

async function readSidecarValue(path: string) {
  const result = await readReportSidecar(path);
  return result.kind === 'ok' ? result.sidecar : null;
}

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

function nth<T>(arr: readonly T[], index: number): T {
  const value = arr.at(index);
  if (value === undefined) throw new Error(`no element at index ${index}`);
  return value;
}

function rid(seconds: number, counter?: number): string {
  const ss = String(seconds).padStart(2, '0');
  return `2026-07-15T18-30-${ss}-000Z-bugreport${counter ? `-${counter}` : ''}.zip`;
}

function ridCreatedAt(seconds: number): string {
  return `2026-07-15T18:30:${String(seconds).padStart(2, '0')}.000Z`;
}

function seedZip(dir: string, id: string, bytes = 128): void {
  const path = join(dir, id);
  writeFileSync(path, Buffer.alloc(bytes));
}

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

function makeWarnRecorder() {
  const warns: { data: unknown; message: string }[] = [];
  return {
    warns,
    logger: {
      warn: (data: unknown, message: string) => {
        warns.push({ data, message });
      },
    },
  };
}

function seedSentMarker(dir: string, id: string, reference: string, sentAt?: string): void {
  writeFileSync(
    sentMarkerPathForId(dir, id),
    `version: 1\nid: ${id}\nsentAt: ${sentAt ?? ridCreatedAt(1)}\nreference: ${reference}\n`,
  );
}

describe('writeReportSidecar / readReportSidecar', () => {
  test('round-trips a generated sidecar to disk as YAML next to the zip', async () => {
    const dir = makeTmpDir();
    const id = rid(1);
    await writeReportSidecar(dir, makeSidecar({ id, state: 'generated' }));

    expect(existsSync(sidecarPathForId(dir, id))).toBe(true);
    const raw = await readFile(sidecarPathForId(dir, id), 'utf-8');
    expect(raw).toContain('state: generated');

    const parsed = await readSidecarValue(sidecarPathForId(dir, id));
    expect(parsed?.id).toBe(id);
    expect(parsed?.state).toBe('generated');
    expect(parsed?.projectSlug).toBe('demo');
  });

  test('reading an absent sidecar reports `absent`, not a failure', async () => {
    const dir = makeTmpDir();
    expect(await readReportSidecar(sidecarPathForId(dir, rid(1)))).toEqual({ kind: 'absent' });
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

    expect((await readSidecarValue(sidecarPathForId(dir, id)))?.note).toBe(
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

    const sidecar = await readSidecarValue(sidecarPathForId(dir, id));
    expect(sidecar).not.toBeNull();
    expect(sidecar && 'note' in sidecar).toBe(false);
  });
});

const ALIAS_BOMB_YAML = [
  'a: &a ["x","x","x","x","x","x","x","x","x"]',
  'b: &b [*a,*a,*a,*a,*a,*a,*a,*a,*a]',
  'c: &c [*b,*b,*b,*b,*b,*b,*b,*b,*b]',
  'd: &d [*c,*c,*c,*c,*c,*c,*c,*c,*c]',
  'e: &e [*d,*d,*d,*d,*d,*d,*d,*d,*d]',
  'f: &f [*e,*e,*e,*e,*e,*e,*e,*e,*e]',
  'g: [*f,*f,*f,*f,*f,*f,*f,*f,*f]',
].join('\n');

describe('readReportSidecar — absent is not the same as unreadable', () => {
  test('a readable, valid sidecar reports `ok` with the parsed record', async () => {
    const dir = makeTmpDir();
    const id = rid(1);
    await writeReportSidecar(dir, makeSidecar({ id, state: 'generated' }));

    const read = await readReportSidecar(sidecarPathForId(dir, id));
    expect(read.kind).toBe('ok');
    expect(read.kind === 'ok' && read.sidecar.id).toBe(id);
  });

  test('a real IO error reports `unreadable`, and never throws', async () => {
    const dir = makeTmpDir();
    const id = rid(1);
    mkdirSync(sidecarPathForId(dir, id));

    const read = await readReportSidecar(sidecarPathForId(dir, id));
    expect(read.kind).toBe('unreadable');
    expect(read.kind === 'unreadable' && read.reason).toBe('io-error');
    expect(read.kind === 'unreadable' && read.err).toBeDefined();
  });

  test('malformed YAML reports `unreadable`, distinguishing it from absent', async () => {
    const dir = makeTmpDir();
    const id = rid(1);
    writeFileSync(sidecarPathForId(dir, id), 'state: [unclosed\n  bad: : :\n');

    const read = await readReportSidecar(sidecarPathForId(dir, id));
    expect(read.kind).toBe('unreadable');
    expect(read.kind === 'unreadable' && read.reason).toBe('parse-error');
  });

  test('valid YAML of the wrong shape reports `unreadable`', async () => {
    const dir = makeTmpDir();
    const id = rid(1);
    writeFileSync(sidecarPathForId(dir, id), 'version: 1\nnot: a sidecar\n');

    const read = await readReportSidecar(sidecarPathForId(dir, id));
    expect(read.kind).toBe('unreadable');
    expect(read.kind === 'unreadable' && read.reason).toBe('schema-invalid');
  });

  test('a YAML alias bomb reports `unreadable` rather than throwing', async () => {
    const dir = makeTmpDir();
    const id = rid(1);
    writeFileSync(sidecarPathForId(dir, id), ALIAS_BOMB_YAML);

    const read = await readReportSidecar(sidecarPathForId(dir, id));
    expect(read.kind).toBe('unreadable');
    expect(read.kind === 'unreadable' && read.reason).toBe('parse-error');
  });
});

describe('listReports — states and ordering', () => {
  test('returns rows newest-first with the right state, retryability and reference', async () => {
    const dir = makeTmpDir();
    await seedReport(dir, 1, { state: 'upload-failed', lastError: { reason: 'offline', at: 'x' } });
    await seedReport(dir, 3, { state: 'generated' });
    const sentId = rid(2);
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

describe('listReports — one bad file must never break the list', () => {
  test('an alias-bomb sidecar degrades its own row and leaves the rest listable', async () => {
    const dir = makeTmpDir();
    const goodId = await seedReport(dir, 1, { state: 'generated', note: 'a real report' });
    const bombId = rid(2);
    seedZip(dir, bombId);
    writeFileSync(sidecarPathForId(dir, bombId), ALIAS_BOMB_YAML);

    const result = await listReports(dir);

    expect(result.ok).toBe(true);
    const rows = result.ok ? result.reports : [];
    expect(rows.map((r) => r.id).sort()).toEqual([goodId, bombId].sort());
    expect(rows.find((r) => r.id === goodId)?.note).toBe('a real report');
    const bombRow = rows.find((r) => r.id === bombId);
    expect(bombRow?.state).toBe('unknown');
    expect(bombRow?.degraded).toBe(true);
  });

  test('retention still does its work with an alias-bomb sidecar present', async () => {
    const dir = makeTmpDir();
    const orphanId = rid(1);
    writeFileSync(sidecarPathForId(dir, orphanId), 'id: [unterminated\n  : : :');
    const liveId = await seedReport(dir, 2, { state: 'generated' });
    const bombId = rid(3);
    seedZip(dir, bombId);
    writeFileSync(sidecarPathForId(dir, bombId), ALIAS_BOMB_YAML);

    await runRetentionSweep(dir, createInFlightRegistry());

    expect(existsSync(sidecarPathForId(dir, orphanId))).toBe(false);
    expect(existsSync(zipPathForId(dir, liveId))).toBe(true);
    expect(existsSync(zipPathForId(dir, bombId))).toBe(true);
  });
});

describe('retention — a momentarily unreadable sidecar is not reclaimed', () => {
  test.skipIf(process.getuid?.() === 0 || process.platform === 'win32')(
    'a sent tombstone whose sidecar hits EACCES survives the orphan sweep',
    async () => {
      const dir = makeTmpDir();
      const id = rid(1);
      await writeReportSidecar(
        dir,
        makeSidecar({
          id,
          state: 'sent',
          reference: 'REF-TOMBSTONE',
          note: 'the editor froze after a paste',
          zipDeleted: true,
        }),
      );
      const path = sidecarPathForId(dir, id);
      chmodSync(path, 0o000);

      await runRetentionSweep(dir, createInFlightRegistry());

      const survived = existsSync(path);
      chmodSync(path, 0o644);
      expect(survived).toBe(true);
      const restored = await readSidecarValue(path);
      expect(restored?.reference).toBe('REF-TOMBSTONE');
      expect(restored?.note).toBe('the editor froze after a paste');
    },
  );
});

describe('send hooks — state transitions and in-flight lock', () => {
  test('onSendStart marks uploading and blocks a second concurrent send', async () => {
    const dir = makeTmpDir();
    const id = await seedReport(dir, 1, { state: 'generated' });
    const store = createBugReportSidecarStore({ dir });

    expect(await store.sendHooks.onSendStart(id)).toEqual({ proceed: true });
    expect((await readSidecarValue(sidecarPathForId(dir, id)))?.state).toBe('uploading');
    expect(await store.sendHooks.onSendStart(id)).toEqual({ proceed: false });
  });

  test('a synthesized sidecar claims no project, so the row can never be titled by one', async () => {
    const dir = makeTmpDir();
    const id = rid(1);
    seedZip(dir, id);
    const store = createBugReportSidecarStore({ dir });

    expect(await store.sendHooks.onSendStart(id)).toEqual({ proceed: true });

    const synthesized = await readSidecarValue(sidecarPathForId(dir, id));
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

    const sidecar = await readSidecarValue(sidecarPathForId(dir, id));
    expect(sidecar?.state).toBe('sent');
    expect(sidecar?.reference).toBe('OK-777');
    expect(sidecar?.zipDeleted).toBe(true);
    expect(sidecar?.attempts?.at(-1)).toMatchObject({ transport: 'upload', outcome: 'success' });
    expect(sidecar?.note).toBe('the editor froze after a paste');
    expect(existsSync(zipPathForId(dir, id))).toBe(false);
    expect(existsSync(sidecarPathForId(dir, id))).toBe(true);
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

    const sidecar = await readSidecarValue(sidecarPathForId(dir, id));
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

    const sidecar = await readSidecarValue(sidecarPathForId(dir, id));
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
    expect((await readSidecarValue(sidecarPathForId(dir, id)))?.zipDeleted).toBe(true);
  });

  test('the tombstone write keeps the note after the zip is reclaimed', async () => {
    const dir = makeTmpDir();
    const note = 'the editor froze after I pasted a large table';
    const id = await seedReport(dir, 1, { state: 'sent', reference: 'OK-1', note });

    await runRetentionSweep(dir, createInFlightRegistry());

    const sidecar = await readSidecarValue(sidecarPathForId(dir, id));
    expect(sidecar?.zipDeleted).toBe(true);
    expect(sidecar?.note).toBe(note);
  });

  test('evicts the oldest unsent over the count cap but never the newest', async () => {
    const dir = makeTmpDir();
    const total = MAX_UNSENT_REPORT_COUNT + 2;
    const ids: string[] = [];
    for (let i = 1; i <= total; i += 1) ids.push(await seedReport(dir, i, { state: 'generated' }));

    await runRetentionSweep(dir, createInFlightRegistry());

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
    inFlight.add(nth(ids, 0));

    await runRetentionSweep(dir, inFlight);

    expect(existsSync(zipPathForId(dir, nth(ids, 0)))).toBe(true);
    expect(existsSync(zipPathForId(dir, nth(ids, 1)))).toBe(false);
  });

  test('evicts on the byte budget alone, with the count cap never exceeded', async () => {
    const dir = makeTmpDir();
    const chunk = Math.floor(MAX_UNSENT_REPORT_BYTES * 0.4);
    const ids: string[] = [];
    for (let i = 1; i <= 3; i += 1) ids.push(await seedSparseReport(dir, i, chunk));
    expect(ids.length).toBeLessThan(MAX_UNSENT_REPORT_COUNT);

    await runRetentionSweep(dir, createInFlightRegistry());

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

    expect(existsSync(zipPathForId(dir, older))).toBe(false);
    expect(existsSync(zipPathForId(dir, huge))).toBe(true);
  });

  test('reclaims an unreadable sidecar whose bundle is already gone', async () => {
    const dir = makeTmpDir();
    const orphanId = rid(1);
    writeFileSync(sidecarPathForId(dir, orphanId), 'id: [unterminated\n  : : :');
    const liveId = await seedReport(dir, 2, { state: 'generated' });

    await runRetentionSweep(dir, createInFlightRegistry());

    expect(existsSync(sidecarPathForId(dir, orphanId))).toBe(false);
    expect(existsSync(zipPathForId(dir, liveId))).toBe(true);
  });

  test('keeps a forward-compatible sidecar with an unrecognized state and no zip', async () => {
    const dir = makeTmpDir();
    const futureId = rid(1);
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

    const stale = await readSidecarValue(sidecarPathForId(dir, staleId));
    expect(stale?.state).toBe('upload-failed');
    expect(stale?.lastError?.reason).toBe('interrupted-by-restart');
    expect(stale?.note).toBe('the editor froze after a paste');
    expect((await readSidecarValue(sidecarPathForId(dir, okId)))?.state).toBe('generated');
  });
});

describe('send hooks — an unreadable sidecar is preserved, not overwritten', () => {
  async function seedUnreadable(dir: string, note: string): Promise<string> {
    const id = await seedReport(dir, 1, { state: 'generated', note });
    writeFileSync(sidecarPathForId(dir, id), 'state: [unclosed\n  bad: : :\n');
    return id;
  }

  test('onSendStart still proceeds, and leaves the sidecar byte-identical', async () => {
    const dir = makeTmpDir();
    const id = await seedUnreadable(dir, 'the editor froze after a paste');
    const before = readFileSync(sidecarPathForId(dir, id));
    const { logger, warns } = makeWarnRecorder();
    const store = createBugReportSidecarStore({ dir, logger });

    expect(await store.sendHooks.onSendStart(id)).toEqual({ proceed: true });
    expect(readFileSync(sidecarPathForId(dir, id))).toEqual(before);
    expect(warns.some((w) => w.message.includes('sidecar unreadable'))).toBe(true);
  });

  test('onSendResult leaves the record alone, and the reference survives it', async () => {
    const dir = makeTmpDir();
    const id = await seedUnreadable(dir, 'sync hung on a large repo');
    const before = readFileSync(sidecarPathForId(dir, id));
    const { logger, warns } = makeWarnRecorder();
    const store = createBugReportSidecarStore({ dir, logger });

    await store.sendHooks.onSendResult(id, { kind: 'sent', reference: 'REF-PRESERVE' });

    expect(readFileSync(sidecarPathForId(dir, id))).toEqual(before);
    const skipped = warns.find((w) => w.message.includes('not written to the sidecar'));
    expect(skipped).toBeDefined();
    expect(JSON.stringify(skipped?.data)).toContain('REF-PRESERVE');
    expect(readFileSync(sentMarkerPathForId(dir, id), 'utf-8')).toContain('REF-PRESERVE');
    expect(existsSync(zipPathForId(dir, id))).toBe(false);
  });

  test('the in-flight lock is released even when the write is skipped', async () => {
    const dir = makeTmpDir();
    const id = await seedUnreadable(dir, 'a note behind a corrupt file');
    const store = createBugReportSidecarStore({ dir });

    expect(await store.sendHooks.onSendStart(id)).toEqual({ proceed: true });
    expect(await store.sendHooks.onSendStart(id)).toEqual({ proceed: false });

    await store.sendHooks.onSendResult(id, { kind: 'upload-failed', reason: 'offline' });

    expect(await store.sendHooks.onSendStart(id)).toEqual({ proceed: true });
  });

  test('an ABSENT sidecar still synthesizes, so a legacy zip is not stranded', async () => {
    const dir = makeTmpDir();
    const id = rid(1);
    seedZip(dir, id);
    const store = createBugReportSidecarStore({ dir });

    expect(await store.sendHooks.onSendStart(id)).toEqual({ proceed: true });
    expect((await readSidecarValue(sidecarPathForId(dir, id)))?.state).toBe('uploading');
  });

  test.skipIf(process.getuid?.() === 0 || process.platform === 'win32')(
    'a valid note survives an EACCES read rather than being erased',
    async () => {
      const dir = makeTmpDir();
      const note = 'crashed while renaming a folder';
      const id = await seedReport(dir, 1, { state: 'generated', note });
      const path = sidecarPathForId(dir, id);
      chmodSync(path, 0o000);
      const store = createBugReportSidecarStore({ dir });

      await store.sendHooks.onSendResult(id, { kind: 'sent', reference: 'REF-EACCES' });

      chmodSync(path, 0o644);
      expect((await readSidecarValue(path))?.note).toBe(note);
    },
  );
});

describe('send hooks — a confirmed send is recorded even when the sidecar is unreadable', () => {
  async function seedUnreadableWithZip(dir: string, note: string): Promise<string> {
    const id = await seedReport(dir, 1, { state: 'generated', note });
    writeFileSync(sidecarPathForId(dir, id), 'state: [unclosed\n  bad: : :\n');
    return id;
  }

  test('the row reads sent, keeps its reference, and stops offering Retry', async () => {
    const dir = makeTmpDir();
    const id = await seedUnreadableWithZip(dir, 'the editor froze after a paste');
    const store = createBugReportSidecarStore({ dir });

    await store.sendHooks.onSendResult(id, { kind: 'sent', reference: 'REF-LISTROW' });

    const result = await store.list();
    if (!result.ok) throw new Error('expected ok');
    const row = nth(result.reports, 0);
    expect(row.id).toBe(id);
    expect(row.state).toBe('sent');
    expect(row.retryable).toBe(false);
    expect(row.reference).toBe('REF-LISTROW');
    expect(row.degraded).toBe(true);
  });

  test('the marker is a NEW file — the sidecar stays byte-identical', async () => {
    const dir = makeTmpDir();
    const id = await seedUnreadableWithZip(dir, 'sync hung on a large repo');
    const before = readFileSync(sidecarPathForId(dir, id));
    const store = createBugReportSidecarStore({ dir });

    await store.sendHooks.onSendResult(id, { kind: 'sent', reference: 'REF-MARKER' });

    expect(readFileSync(sidecarPathForId(dir, id))).toEqual(before);
    expect(readFileSync(sentMarkerPathForId(dir, id), 'utf-8')).toContain('REF-MARKER');
  });

  test('no marker is left behind when the sidecar itself recorded the send', async () => {
    const dir = makeTmpDir();
    const id = await seedReport(dir, 1, { state: 'uploading', note: 'a readable record' });
    const store = createBugReportSidecarStore({ dir });

    await store.sendHooks.onSendResult(id, { kind: 'sent', reference: 'REF-NORMAL' });

    expect(existsSync(sentMarkerPathForId(dir, id))).toBe(false);
    expect((await readSidecarValue(sidecarPathForId(dir, id)))?.reference).toBe('REF-NORMAL');
  });

  test('a non-sent outcome is not marked — those stay retryable by design', async () => {
    const dir = makeTmpDir();
    const id = await seedUnreadableWithZip(dir, 'offline while sending');
    const store = createBugReportSidecarStore({ dir });

    await store.sendHooks.onSendResult(id, { kind: 'upload-failed', reason: 'offline' });

    expect(existsSync(sentMarkerPathForId(dir, id))).toBe(false);
    expect(existsSync(zipPathForId(dir, id))).toBe(true);
  });

  test('retention reclaims the zip of a confirmed send it could only mark', async () => {
    const dir = makeTmpDir();
    const id = await seedUnreadableWithZip(dir, 'a note behind a corrupt file');
    const store = createBugReportSidecarStore({ dir });

    await store.sendHooks.onSendResult(id, { kind: 'sent', reference: 'REF-RECLAIM' });

    expect(existsSync(zipPathForId(dir, id))).toBe(false);
    expect(existsSync(sidecarPathForId(dir, id))).toBe(true);
  });

  test('the report leaves the unsent pool, so cap eviction never unlinks its note', async () => {
    const dir = makeTmpDir();
    const sentId = await seedUnreadableWithZip(dir, 'crashed while renaming a folder');
    const store = createBugReportSidecarStore({ dir });
    await store.sendHooks.onSendResult(sentId, { kind: 'sent', reference: 'REF-CAP' });

    for (let i = 2; i <= MAX_UNSENT_REPORT_COUNT + 2; i += 1) {
      await seedReport(dir, i, { state: 'generated' });
    }
    await runRetentionSweep(dir, createInFlightRegistry());

    expect(existsSync(sidecarPathForId(dir, sentId))).toBe(true);
    expect(existsSync(sentMarkerPathForId(dir, sentId))).toBe(true);
    expect(existsSync(zipPathForId(dir, rid(2)))).toBe(false);
  });

  test('an unparseable marker still means sent — its existence is the record', async () => {
    const dir = makeTmpDir();
    const id = await seedReport(dir, 1, { state: 'generated' });
    writeFileSync(sentMarkerPathForId(dir, id), 'not: [yaml\n  : :');

    const result = await listReports(dir);
    if (!result.ok) throw new Error('expected ok');
    const row = nth(result.reports, 0);
    expect(row.state).toBe('sent');
    expect(row.retryable).toBe(false);
    expect(row.reference).toBeUndefined();
  });

  test.skipIf(process.getuid?.() === 0 || process.platform === 'win32')(
    'a readable sidecar whose write fails still reaches the marker, loudly',
    async () => {
      const dir = makeTmpDir();
      const id = await seedReport(dir, 1, { state: 'uploading', note: 'a readable record' });
      const before = readFileSync(sidecarPathForId(dir, id));
      const { logger, warns } = makeWarnRecorder();
      const store = createBugReportSidecarStore({ dir, logger });
      chmodSync(dir, 0o555);

      await store.sendHooks.onSendResult(id, { kind: 'sent', reference: 'REF-THROWN' });

      chmodSync(dir, 0o755);
      expect(warns.some((w) => w.message.includes('failed to write the send result sidecar'))).toBe(
        true,
      );
      expect(warns.some((w) => w.message.includes('not written to the sidecar'))).toBe(false);
      const markerFailed = warns.find((w) => w.message.includes('failed to write the sent marker'));
      expect(markerFailed).toBeDefined();
      expect(JSON.stringify(markerFailed?.data)).toContain('REF-THROWN');
      expect(readFileSync(sidecarPathForId(dir, id))).toEqual(before);
    },
  );

  test('a marked send keeps its corrupt sidecar out of the orphan sweep', async () => {
    const dir = makeTmpDir();
    const id = await seedUnreadableWithZip(dir, 'the note is in there as raw text');
    const store = createBugReportSidecarStore({ dir });

    await store.sendHooks.onSendResult(id, { kind: 'sent', reference: 'REF-ORPHAN' });
    await runRetentionSweep(dir, createInFlightRegistry());
    await runRetentionSweep(dir, createInFlightRegistry());

    expect(existsSync(zipPathForId(dir, id))).toBe(false);
    expect(existsSync(sidecarPathForId(dir, id))).toBe(true);
    expect(readFileSync(sidecarPathForId(dir, id), 'utf-8')).toContain('unclosed');
  });

  test('delete removes the marker along with the sidecar', async () => {
    const dir = makeTmpDir();
    const id = await seedUnreadableWithZip(dir, 'a note behind a corrupt file');
    const store = createBugReportSidecarStore({ dir });
    await store.sendHooks.onSendResult(id, { kind: 'sent', reference: 'REF-DELETE' });

    expect(await store.remove(id)).toEqual({ ok: true });
    expect(existsSync(sentMarkerPathForId(dir, id))).toBe(false);
    expect(existsSync(sidecarPathForId(dir, id))).toBe(false);
  });

  test('a delete racing the marker write is refused, not left to resurrect the report', async () => {
    const dir = makeTmpDir();
    const id = await seedUnreadableWithZip(dir, 'a note behind a corrupt file');
    const store = createBugReportSidecarStore({ dir });
    expect(await store.sendHooks.onSendStart(id)).toEqual({ proceed: true });

    const send = store.sendHooks.onSendResult(id, { kind: 'sent', reference: 'REF-RACE' });
    const removed = await store.remove(id);
    await send;

    expect(removed).toEqual({ ok: false, reason: 'in-flight' });
    expect(existsSync(sentMarkerPathForId(dir, id))).toBe(true);
  });

  test('the orphan sweep spares a corrupt sidecar whose marker does not parse either', async () => {
    const dir = makeTmpDir();
    const id = await seedUnreadableWithZip(dir, 'a note behind a corrupt file');
    writeFileSync(sentMarkerPathForId(dir, id), 'not: [yaml\n  : :');
    rmSync(zipPathForId(dir, id));

    await runRetentionSweep(dir, createInFlightRegistry());

    expect(existsSync(sidecarPathForId(dir, id))).toBe(true);
    expect(existsSync(sentMarkerPathForId(dir, id))).toBe(true);
  });

  test('boot reconciliation spares a report whose marker does not parse either', async () => {
    const dir = makeTmpDir();
    const id = await seedReport(dir, 1, { state: 'uploading', note: 'stuck mid-send' });
    writeFileSync(sentMarkerPathForId(dir, id), 'not: [yaml\n  : :');

    expect(await reconcileStaleUploading(dir)).toBe(0);
    expect((await readSidecarValue(sidecarPathForId(dir, id)))?.state).toBe('uploading');
  });

  test('a marker-only report lists as sent, sorted by its send time', async () => {
    const dir = makeTmpDir();
    const id = rid(1);
    seedSentMarker(dir, id, 'REF-ALONE-ROW', ridCreatedAt(1));

    const result = await listReports(dir);
    if (!result.ok) throw new Error('expected ok');
    const row = nth(result.reports, 0);
    expect(row.state).toBe('sent');
    expect(row.retryable).toBe(false);
    expect(row.reference).toBe('REF-ALONE-ROW');
    expect(row.createdAt).toBe(ridCreatedAt(1));
    expect(row.zipExists).toBe(false);
    expect(row.zipDeleted).toBe(true);
  });

  test('a marker alone is a deletable record, not a not-found', async () => {
    const dir = makeTmpDir();
    const id = rid(1);
    seedSentMarker(dir, id, 'REF-ALONE');

    expect(await deleteReport(dir, id, createInFlightRegistry())).toEqual({ ok: true });
    expect(existsSync(sentMarkerPathForId(dir, id))).toBe(false);
  });

  test('the tombstone cap bounds marker-only records, oldest first', async () => {
    const dir = makeTmpDir();
    const total = MAX_SENT_TOMBSTONE_COUNT + 3;
    const ids: string[] = [];
    for (let i = 1; i <= total; i += 1) {
      const id = rid(i);
      ids.push(id);
      seedSentMarker(dir, id, `OK-${i}`, ridCreatedAt(i));
    }

    await runRetentionSweep(dir, createInFlightRegistry());

    expect(existsSync(sentMarkerPathForId(dir, nth(ids, 0)))).toBe(false);
    expect(existsSync(sentMarkerPathForId(dir, nth(ids, 2)))).toBe(false);
    expect(existsSync(sentMarkerPathForId(dir, nth(ids, -1)))).toBe(true);
  });

  test('boot reconciliation does not demote a report the marker says sent', async () => {
    const dir = makeTmpDir();
    const id = await seedReport(dir, 1, { state: 'uploading', note: 'stuck mid-send' });
    seedSentMarker(dir, id, 'REF-BOOT');

    expect(await reconcileStaleUploading(dir)).toBe(0);
    expect((await readSidecarValue(sidecarPathForId(dir, id)))?.state).toBe('uploading');
  });

  test.skipIf(process.getuid?.() === 0 || process.platform === 'win32')(
    'the reporter note survives an EACCES send that the marker records',
    async () => {
      const dir = makeTmpDir();
      const note = 'crashed while renaming a folder';
      const id = await seedReport(dir, 1, { state: 'generated', note });
      const path = sidecarPathForId(dir, id);
      chmodSync(path, 0o000);
      const store = createBugReportSidecarStore({ dir });

      await store.sendHooks.onSendResult(id, { kind: 'sent', reference: 'REF-EACCES-MARK' });

      const marked = existsSync(sentMarkerPathForId(dir, id));
      chmodSync(path, 0o644);
      expect(marked).toBe(true);
      expect((await readSidecarValue(path))?.note).toBe(note);
    },
  );
});

describe('scanReports diagnostics — an unreadable sidecar warns once, not once per scan', () => {
  test('the first scan names the id and the reason, later scans stay quiet', async () => {
    const dir = makeTmpDir();
    const id = await seedReport(dir, 1, { state: 'generated', note: 'a note' });
    writeFileSync(sidecarPathForId(dir, id), 'state: [unclosed\n  bad: : :\n');
    const { logger, warns } = makeWarnRecorder();
    const store = createBugReportSidecarStore({ dir, logger });

    await store.list();
    const scanWarns = () =>
      warns.filter((w) => w.message.includes('sidecar unreadable during scan'));
    expect(scanWarns()).toHaveLength(1);
    expect(JSON.stringify(nth(scanWarns(), 0).data)).toContain('parse-error');
    expect(JSON.stringify(nth(scanWarns(), 0).data)).toContain(id);

    await store.list();
    await store.list();
    expect(scanWarns()).toHaveLength(1);
  });

  test('a sidecar that reads cleanly again re-arms the warning', async () => {
    const dir = makeTmpDir();
    const id = await seedReport(dir, 1, { state: 'generated' });
    const path = sidecarPathForId(dir, id);
    const healthy = readFileSync(path);
    writeFileSync(path, 'state: [unclosed\n  bad: : :\n');
    const { logger, warns } = makeWarnRecorder();
    const store = createBugReportSidecarStore({ dir, logger });
    const scanWarns = () =>
      warns.filter((w) => w.message.includes('sidecar unreadable during scan'));

    await store.list();
    expect(scanWarns()).toHaveLength(1);

    writeFileSync(path, healthy);
    await store.list();
    writeFileSync(path, 'state: [unclosed\n  bad: : :\n');
    await store.list();

    expect(scanWarns()).toHaveLength(2);
  });

  test('the registry re-arms per reason and per file kind, and is bounded', () => {
    const warned = createSidecarScanWarnRegistry();
    const id = rid(1);

    expect(warned.shouldWarn(id, 'sidecar', 'parse-error')).toBe(true);
    expect(warned.shouldWarn(id, 'sidecar', 'parse-error')).toBe(false);
    expect(warned.shouldWarn(id, 'sidecar', 'io-error')).toBe(true);
    expect(warned.shouldWarn(id, 'marker', 'unreadable')).toBe(true);
    warned.clear(id, 'sidecar');
    expect(warned.shouldWarn(id, 'sidecar', 'parse-error')).toBe(true);
    expect(warned.shouldWarn(id, 'marker', 'unreadable')).toBe(false);

    const other = createSidecarScanWarnRegistry();
    for (let i = 0; i <= MAX_REMEMBERED_SCAN_WARNINGS; i += 1) {
      other.shouldWarn(`${i}`, 'sidecar', 'parse-error');
    }
    expect(other.shouldWarn('0', 'sidecar', 'parse-error')).toBe(true);
  });

  test('an unreadable sent marker warns too, and says what was lost with it', async () => {
    const dir = makeTmpDir();
    const id = await seedReport(dir, 1, { state: 'generated' });
    writeFileSync(sentMarkerPathForId(dir, id), 'not: [yaml\n  : :');
    const { logger, warns } = makeWarnRecorder();
    const store = createBugReportSidecarStore({ dir, logger });

    await store.list();
    await store.list();

    const markerWarns = warns.filter((w) => w.message.includes('sent marker unreadable'));
    expect(markerWarns).toHaveLength(1);
    expect(JSON.stringify(nth(markerWarns, 0).data)).toContain(id);
  });

  test('each unreadable sidecar warns on its own, not just the first one seen', async () => {
    const dir = makeTmpDir();
    const first = await seedReport(dir, 1, { state: 'generated' });
    const second = await seedReport(dir, 2, { state: 'generated' });
    writeFileSync(sidecarPathForId(dir, first), 'state: [unclosed\n  : :');
    writeFileSync(sidecarPathForId(dir, second), 'state: [unclosed\n  : :');
    const { logger, warns } = makeWarnRecorder();
    const store = createBugReportSidecarStore({ dir, logger });

    await store.list();

    const ids = warns
      .filter((w) => w.message.includes('sidecar unreadable during scan'))
      .map((w) => JSON.stringify(w.data));
    expect(ids).toHaveLength(2);
    expect(ids.some((d) => d.includes(first))).toBe(true);
    expect(ids.some((d) => d.includes(second))).toBe(true);
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

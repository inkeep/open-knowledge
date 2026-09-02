import { readdir, readFile, realpath, stat, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import {
  isReportIdShape,
  normalizeReportSidecarState,
  type OkBugReportDeleteResult,
  type OkBugReportListResult,
  type OkBugReportListRow,
  REPORT_SENT_MARKER_SCHEMA_VERSION,
  REPORT_SENT_MARKER_SUFFIX,
  REPORT_SIDECAR_SCHEMA_VERSION,
  type ReportBundleLevel,
  type ReportSentMarker,
  ReportSentMarkerSchema,
  type ReportSidecar,
  ReportSidecarSchema,
  type ReportSidecarState,
} from '@inkeep/open-knowledge-core';
import { atomicWriteFile } from '@inkeep/open-knowledge-core/server';
import { type ParsedNode, parseDocument } from 'yaml';
import {
  type BugReportSendSidecarHooks,
  type GeneratedReportMeta,
  MAX_REPORT_ATTEMPTS,
  MAX_SENT_TOMBSTONE_COUNT,
  MAX_UNSENT_REPORT_BYTES,
  MAX_UNSENT_REPORT_COUNT,
  type SidecarSendOutcome,
} from './ipc/bug-report.ts';
import { isPathWithinProject } from './path-containment.ts';

export interface SidecarLogger {
  warn: (data: unknown, message: string) => void;
}

export interface InFlightRegistry {
  has(id: string): boolean;
  add(id: string): void;
  delete(id: string): void;
}

export function createInFlightRegistry(): InFlightRegistry {
  const ids = new Set<string>();
  return {
    has: (id) => ids.has(id),
    add: (id) => {
      ids.add(id);
    },
    delete: (id) => {
      ids.delete(id);
    },
  };
}

export const MAX_REMEMBERED_SCAN_WARNINGS = 256;

export interface SidecarScanWarnRegistry {
  shouldWarn(id: string, kind: 'sidecar' | 'marker', reason: string): boolean;
  clear(id: string, kind: 'sidecar' | 'marker'): void;
}

export function createSidecarScanWarnRegistry(): SidecarScanWarnRegistry {
  const seen = new Set<string>();
  const prefixFor = (id: string, kind: string): string => `${id}\u0000${kind}\u0000`;
  return {
    shouldWarn: (id, kind, reason) => {
      const key = `${prefixFor(id, kind)}${reason}`;
      if (seen.has(key)) return false;
      if (seen.size >= MAX_REMEMBERED_SCAN_WARNINGS) seen.clear();
      seen.add(key);
      return true;
    },
    clear: (id, kind) => {
      const prefix = prefixFor(id, kind);
      for (const key of seen) {
        if (key.startsWith(prefix)) seen.delete(key);
      }
    },
  };
}

export function sidecarPathForId(dir: string, id: string): string {
  return join(dir, id.replace(/\.zip$/, '.yaml'));
}

export function zipPathForId(dir: string, id: string): string {
  return join(dir, id);
}

export function sentMarkerPathForId(dir: string, id: string): string {
  return join(dir, id.replace(/\.zip$/, REPORT_SENT_MARKER_SUFFIX));
}

export async function writeReportSidecar(dir: string, sidecar: ReportSidecar): Promise<void> {
  const parsed = ReportSidecarSchema.safeParse(sidecar);
  if (!parsed.success) {
    throw new Error(
      `refusing to write invalid report sidecar: ${parsed.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ')}`,
    );
  }
  const doc = parseDocument('');
  doc.contents = doc.createNode(parsed.data) as ParsedNode;
  await atomicWriteFile(sidecarPathForId(dir, parsed.data.id), doc.toString());
}

async function writeSentMarker(
  dir: string,
  id: string,
  sentAt: string,
  reference: string,
): Promise<void> {
  const marker: Required<Pick<ReportSentMarker, 'version' | 'id' | 'sentAt' | 'reference'>> = {
    version: REPORT_SENT_MARKER_SCHEMA_VERSION,
    id,
    sentAt,
    reference,
  };
  const doc = parseDocument('');
  doc.contents = doc.createNode(marker) as ParsedNode;
  await atomicWriteFile(sentMarkerPathForId(dir, id), doc.toString());
}

async function readSentMarkerDetail(markerPath: string): Promise<ReportSentMarker | null> {
  try {
    const doc = parseDocument(await readFile(markerPath, 'utf-8'));
    if (doc.errors.length > 0) return null;
    const parsed = ReportSentMarkerSchema.safeParse(doc.toJSON());
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

type SidecarUnreadableReason = 'io-error' | 'parse-error' | 'schema-invalid';

export type SidecarReadResult =
  | { kind: 'ok'; sidecar: ReportSidecar }
  | { kind: 'absent' }
  | { kind: 'unreadable'; reason: SidecarUnreadableReason; err?: unknown };

export async function readReportSidecar(sidecarPath: string): Promise<SidecarReadResult> {
  let content: string;
  try {
    content = await readFile(sidecarPath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'absent' };
    return { kind: 'unreadable', reason: 'io-error', err };
  }
  let doc: ReturnType<typeof parseDocument>;
  try {
    doc = parseDocument(content);
  } catch (err) {
    return { kind: 'unreadable', reason: 'parse-error', err };
  }
  if (doc.errors.length > 0) {
    return { kind: 'unreadable', reason: 'parse-error', err: doc.errors[0] };
  }
  let value: unknown;
  try {
    value = doc.toJSON();
  } catch (err) {
    return { kind: 'unreadable', reason: 'parse-error', err };
  }
  const parsed = ReportSidecarSchema.safeParse(value);
  return parsed.success
    ? { kind: 'ok', sidecar: parsed.data }
    : { kind: 'unreadable', reason: 'schema-invalid', err: parsed.error };
}

interface ScannedReport {
  id: string;
  sidecar: ReportSidecar | null;
  sidecarRead: SidecarReadResult;
  sidecarPresent: boolean;
  sentMarkerPresent: boolean;
  sentMarker: ReportSentMarker | null;
  zipExists: boolean;
  zipBytes: number;
  zipMtime: string | null;
}

async function scanReports(
  dir: string,
  logger?: SidecarLogger,
  warned?: SidecarScanWarnRegistry,
): Promise<ScannedReport[]> {
  const entries = await readdir(dir).catch(() => [] as string[]);
  const ids = new Set<string>();
  const sidecarIds = new Set<string>();
  const markerIds = new Set<string>();
  for (const entry of entries) {
    if (entry.endsWith('.zip') && isReportIdShape(entry)) {
      ids.add(entry);
    } else if (entry.endsWith(REPORT_SENT_MARKER_SUFFIX)) {
      const id = `${entry.slice(0, -REPORT_SENT_MARKER_SUFFIX.length)}.zip`;
      if (isReportIdShape(id)) {
        ids.add(id);
        markerIds.add(id);
      }
    } else if (entry.endsWith('.yaml')) {
      const id = entry.replace(/\.yaml$/, '.zip');
      if (isReportIdShape(id)) {
        ids.add(id);
        sidecarIds.add(id);
      }
    }
  }
  return Promise.all(
    [...ids].map(async (id): Promise<ScannedReport> => {
      const zipStat = await stat(zipPathForId(dir, id)).catch(() => null);
      const sidecarPresent = sidecarIds.has(id);
      const read = sidecarPresent
        ? await readReportSidecar(sidecarPathForId(dir, id))
        : ({ kind: 'absent' } as const);
      if (read.kind === 'unreadable') {
        if (warned === undefined || warned.shouldWarn(id, 'sidecar', read.reason)) {
          logger?.warn(
            { id, reason: read.reason, err: read.err },
            'bug-report: sidecar unreadable during scan, row degraded',
          );
        }
      } else if (read.kind === 'ok') {
        warned?.clear(id, 'sidecar');
      }
      const sidecar = read.kind === 'ok' ? read.sidecar : null;
      const sentMarkerPresent = markerIds.has(id);
      const sentMarker = sentMarkerPresent
        ? await readSentMarkerDetail(sentMarkerPathForId(dir, id))
        : null;
      if (sentMarkerPresent && sentMarker === null) {
        if (warned === undefined || warned.shouldWarn(id, 'marker', 'unreadable')) {
          logger?.warn(
            { id },
            'bug-report: sent marker unreadable during scan, send recorded without its reference',
          );
        }
      } else if (sentMarker !== null) {
        warned?.clear(id, 'marker');
      }
      return {
        id,
        sidecar,
        sidecarRead: read,
        sidecarPresent,
        sentMarkerPresent,
        sentMarker,
        zipExists: zipStat !== null,
        zipBytes: zipStat?.size ?? sidecar?.zipBytes ?? 0,
        zipMtime: zipStat?.mtime.toISOString() ?? null,
      };
    }),
  );
}

function projectBundleLevel(raw: string | undefined): ReportBundleLevel | 'unknown' {
  return raw === 'standard' || raw === 'full' ? raw : 'unknown';
}

function toListRow(dir: string, scanned: ScannedReport): OkBugReportListRow {
  const s = scanned.sidecar;
  const state: ReportSidecarState = scanned.sentMarkerPresent
    ? 'sent'
    : s
      ? normalizeReportSidecarState(s.state)
      : scanned.sidecarPresent
        ? 'unknown'
        : scanned.zipExists
          ? 'generated'
          : 'unknown';
  const degraded = (scanned.sidecarPresent && s === null) || state === 'unknown';
  const projectSlug = s?.projectSlug ?? null;
  const reference = s?.reference ?? scanned.sentMarker?.reference;
  return {
    id: scanned.id,
    createdAt: s?.createdAt ?? scanned.zipMtime ?? scanned.sentMarker?.sentAt ?? '',
    bundleLevel: projectBundleLevel(s?.bundleLevel),
    state,
    zipBytes: scanned.zipBytes,
    zipDeleted: s?.zipDeleted ?? !scanned.zipExists,
    zipExists: scanned.zipExists,
    systemWide: s?.systemWide ?? projectSlug === null,
    projectSlug,
    ...(reference !== undefined ? { reference } : {}),
    ...(s?.lastError !== undefined ? { lastError: s.lastError } : {}),
    ...(s?.note !== undefined ? { note: s.note } : {}),
    attemptsCount: s?.attempts?.length ?? 0,
    zipPath: zipPathForId(dir, scanned.id),
    retryable: scanned.zipExists && state !== 'sent' && state !== 'uploading',
    degraded,
  };
}

export async function listReports(
  dir: string,
  logger?: SidecarLogger,
  warned?: SidecarScanWarnRegistry,
): Promise<OkBugReportListResult> {
  try {
    const scanned = await scanReports(dir, logger, warned);
    const reports = scanned
      .map((r) => toListRow(dir, r))
      .sort((a, b) => {
        if (a.createdAt === b.createdAt) return a.id < b.id ? 1 : -1;
        if (a.createdAt === '') return 1;
        if (b.createdAt === '') return -1;
        return a.createdAt < b.createdAt ? 1 : -1;
      });
    return { ok: true, reports };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

async function resolveContainedId(dir: string, id: string): Promise<string | null> {
  if (!isReportIdShape(id)) return null;
  const zipPath = zipPathForId(dir, id);
  if (!isPathWithinProject(zipPath, dir, process.platform)) return null;
  try {
    const canonicalRoot = await realpath(dir);
    const canonicalDir = await realpath(dirname(zipPath));
    if (!isPathWithinProject(join(canonicalDir, id), canonicalRoot, process.platform)) return null;
  } catch {
    return null;
  }
  return zipPath;
}

async function unlinkIfPresent(path: string): Promise<boolean> {
  try {
    await unlink(path);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT';
  }
}

export async function deleteReport(
  dir: string,
  id: string,
  inFlight: InFlightRegistry,
): Promise<OkBugReportDeleteResult> {
  const zipPath = await resolveContainedId(dir, id);
  if (zipPath === null) return { ok: false, reason: 'id-invalid' };
  if (inFlight.has(id)) return { ok: false, reason: 'in-flight' };
  const sidecarPath = sidecarPathForId(dir, id);
  const markerPath = sentMarkerPathForId(dir, id);
  const zipExisted = await stat(zipPath).then(
    () => true,
    () => false,
  );
  const sidecarExisted = await stat(sidecarPath).then(
    () => true,
    () => false,
  );
  const markerExisted = await stat(markerPath).then(
    () => true,
    () => false,
  );
  if (!zipExisted && !sidecarExisted && !markerExisted) return { ok: false, reason: 'not-found' };
  const zipOk = await unlinkIfPresent(zipPath);
  const sidecarOk = await unlinkIfPresent(sidecarPath);
  const markerOk = await unlinkIfPresent(markerPath);
  return zipOk && sidecarOk && markerOk ? { ok: true } : { ok: false, reason: 'io-error' };
}

async function synthesizeSidecar(dir: string, id: string): Promise<ReportSidecar> {
  const zipStat = await stat(zipPathForId(dir, id)).catch(() => null);
  return {
    version: REPORT_SIDECAR_SCHEMA_VERSION,
    id,
    createdAt: zipStat?.mtime.toISOString() ?? new Date().toISOString(),
    bundleLevel: 'standard',
    zipBytes: zipStat?.size ?? 0,
    state: 'generated',
    systemWide: true,
    projectSlug: null,
  };
}

async function readSidecarForTransition(
  dir: string,
  id: string,
  logger?: SidecarLogger,
): Promise<ReportSidecar | null> {
  const read = await readReportSidecar(sidecarPathForId(dir, id));
  if (read.kind === 'ok') return read.sidecar;
  if (read.kind === 'absent') return await synthesizeSidecar(dir, id);
  logger?.warn(
    { id, reason: read.reason, err: read.err },
    'bug-report: sidecar unreadable, preserving the existing record and skipping the update',
  );
  return null;
}

async function markUploading(
  dir: string,
  id: string,
  inFlight: InFlightRegistry,
  logger?: SidecarLogger,
): Promise<{ proceed: boolean }> {
  if (inFlight.has(id)) return { proceed: false };
  inFlight.add(id);
  try {
    const base = await readSidecarForTransition(dir, id, logger);
    if (base !== null) {
      await writeReportSidecar(dir, { ...base, state: 'uploading' });
    }
  } catch (err) {
    logger?.warn({ id, err }, 'bug-report: failed to mark report uploading');
  }
  return { proceed: true };
}

async function recordSendResult(
  dir: string,
  id: string,
  outcome: SidecarSendOutcome,
  inFlight: InFlightRegistry,
  logger?: SidecarLogger,
  warned?: SidecarScanWarnRegistry,
): Promise<void> {
  const at = new Date().toISOString();
  let recorded = false;
  try {
    const base = await readSidecarForTransition(dir, id, logger);
    if (base === null) {
      logger?.warn(
        { id, outcome },
        'bug-report: send outcome not written to the sidecar, it was unreadable',
      );
    } else {
      const attempt =
        outcome.kind === 'sent'
          ? { at, transport: 'upload', outcome: 'success', reference: outcome.reference }
          : outcome.kind === 'upload-failed'
            ? {
                at,
                transport: 'upload',
                outcome: 'failed',
                error: outcome.reason,
                ...(outcome.errorCode === undefined ? {} : { errorCode: outcome.errorCode }),
              }
            : { at, transport: 'email', outcome: 'success' };
      const attempts = [...(base.attempts ?? []), attempt].slice(-MAX_REPORT_ATTEMPTS);
      const { lastError: _priorError, reference: _priorRef, ...rest } = base;
      let next: ReportSidecar = { ...rest, attempts };
      if (outcome.kind === 'sent') {
        next = { ...next, state: 'sent', reference: outcome.reference };
      } else if (outcome.kind === 'upload-failed') {
        next = {
          ...next,
          state: 'upload-failed',
          lastError: {
            reason: outcome.reason,
            at,
            ...(outcome.errorCode === undefined ? {} : { errorCode: outcome.errorCode }),
          },
        };
      } else {
        next = { ...next, state: 'email-drafted' };
      }
      await writeReportSidecar(dir, next);
      recorded = true;
    }
  } catch (err) {
    logger?.warn({ id, err, outcome }, 'bug-report: failed to write the send result sidecar');
  } finally {
    if (outcome.kind === 'sent' && !recorded) {
      await writeSentMarker(dir, id, at, outcome.reference).catch((err: unknown) => {
        logger?.warn({ id, err, outcome }, 'bug-report: failed to write the sent marker');
      });
    }
    inFlight.delete(id);
  }
  await runRetentionSweep(dir, inFlight, logger, warned).catch((err: unknown) => {
    logger?.warn({ err }, 'bug-report: retention sweep failed unexpectedly');
  });
}

export async function reconcileStaleUploading(
  dir: string,
  logger?: SidecarLogger,
  warned?: SidecarScanWarnRegistry,
): Promise<number> {
  let reconciled = 0;
  try {
    const scanned = await scanReports(dir, logger, warned);
    const at = new Date().toISOString();
    for (const report of scanned) {
      if (report.sidecar === null) continue;
      if (normalizeReportSidecarState(report.sidecar.state) !== 'uploading') continue;
      if (report.sentMarkerPresent) continue;
      const next: ReportSidecar = {
        ...report.sidecar,
        state: 'upload-failed',
        lastError: { reason: 'interrupted-by-restart', at },
      };
      await writeReportSidecar(dir, next).then(
        () => {
          reconciled += 1;
        },
        (err: unknown) => {
          logger?.warn(
            { id: report.id, err },
            'bug-report: failed to reconcile stale uploading sidecar',
          );
        },
      );
    }
  } catch (err) {
    logger?.warn({ err }, 'bug-report: stale-uploading reconciliation scan failed');
  }
  return reconciled;
}

export async function runRetentionSweep(
  dir: string,
  inFlight: InFlightRegistry,
  logger?: SidecarLogger,
  warned?: SidecarScanWarnRegistry,
): Promise<void> {
  let scanned: ScannedReport[];
  try {
    scanned = await scanReports(dir, logger, warned);
  } catch (err) {
    logger?.warn({ err }, 'bug-report: retention scan failed');
    return;
  }

  const stateOf = (r: ScannedReport): ReportSidecarState =>
    r.sentMarkerPresent
      ? 'sent'
      : r.sidecar
        ? normalizeReportSidecarState(r.sidecar.state)
        : r.zipExists
          ? 'generated'
          : 'unknown';

  for (const r of scanned) {
    if (stateOf(r) !== 'sent' || !r.zipExists || inFlight.has(r.id)) continue;
    const removed = await unlinkIfPresent(zipPathForId(dir, r.id));
    if (!removed) continue;
    r.zipExists = false;
    if (r.sidecar) {
      await writeReportSidecar(dir, { ...r.sidecar, zipDeleted: true }).catch((err: unknown) => {
        logger?.warn({ id: r.id, err }, 'bug-report: failed to tombstone a sent report');
      });
    }
  }

  const sortByCreatedAtAsc = (a: ScannedReport, b: ScannedReport): number => {
    const at = a.sidecar?.createdAt ?? a.zipMtime ?? a.sentMarker?.sentAt ?? '';
    const bt = b.sidecar?.createdAt ?? b.zipMtime ?? b.sentMarker?.sentAt ?? '';
    return at < bt ? -1 : at > bt ? 1 : a.id < b.id ? -1 : 1;
  };

  const tombstones = scanned
    .filter((r) => stateOf(r) === 'sent' && !r.zipExists)
    .sort(sortByCreatedAtAsc);
  const tombstoneOverflow = Math.max(0, tombstones.length - MAX_SENT_TOMBSTONE_COUNT);
  for (const tombstone of tombstones.slice(0, tombstoneOverflow)) {
    await unlinkIfPresent(sidecarPathForId(dir, tombstone.id));
    await unlinkIfPresent(sentMarkerPathForId(dir, tombstone.id));
  }

  for (const r of scanned) {
    const durablyCorrupt =
      r.sidecarRead.kind === 'unreadable' && r.sidecarRead.reason !== 'io-error';
    if (durablyCorrupt && !r.zipExists && !r.sentMarkerPresent && !inFlight.has(r.id)) {
      await unlinkIfPresent(sidecarPathForId(dir, r.id));
      logger?.warn(
        {
          id: r.id,
          reason: r.sidecarRead.kind === 'unreadable' ? r.sidecarRead.reason : undefined,
        },
        'bug-report: reclaimed an unreadable sidecar with no bundle',
      );
    }
  }

  const unsent = scanned
    .filter((r) => r.zipExists && stateOf(r) !== 'sent')
    .sort(sortByCreatedAtAsc);
  let unsentCount = unsent.length;
  let unsentBytes = unsent.reduce((sum, r) => sum + r.zipBytes, 0);
  const newestUnsentId = unsent.at(-1)?.id ?? null;
  for (const r of unsent) {
    if (unsentCount <= MAX_UNSENT_REPORT_COUNT && unsentBytes <= MAX_UNSENT_REPORT_BYTES) break;
    if (r.id === newestUnsentId) continue;
    if (stateOf(r) === 'uploading' || inFlight.has(r.id)) continue;
    const zipRemoved = await unlinkIfPresent(zipPathForId(dir, r.id));
    if (!zipRemoved) continue;
    await unlinkIfPresent(sidecarPathForId(dir, r.id));
    unsentCount -= 1;
    unsentBytes -= r.zipBytes;
    logger?.warn(
      { id: r.id, zipBytes: r.zipBytes },
      'bug-report: evicted an over-budget unsent report',
    );
  }
}

export interface BugReportSidecarStore {
  recordGenerated(meta: GeneratedReportMeta): Promise<void>;
  sendHooks: BugReportSendSidecarHooks;
  list(): Promise<OkBugReportListResult>;
  remove(id: string): Promise<OkBugReportDeleteResult>;
  reconcileStaleUploading(): Promise<number>;
}

export function createBugReportSidecarStore(opts: {
  dir: string;
  logger?: SidecarLogger;
}): BugReportSidecarStore {
  const { dir, logger } = opts;
  const inFlight = createInFlightRegistry();
  const scanWarned = createSidecarScanWarnRegistry();
  return {
    async recordGenerated(meta) {
      const sidecar: ReportSidecar = {
        version: REPORT_SIDECAR_SCHEMA_VERSION,
        id: basename(meta.zipPath),
        createdAt: new Date().toISOString(),
        bundleLevel: meta.level,
        zipBytes: meta.zipBytes,
        state: 'generated',
        systemWide: meta.systemWide,
        projectSlug: meta.projectSlug,
        ...(meta.note !== undefined ? { note: meta.note } : {}),
      };
      try {
        await writeReportSidecar(dir, sidecar);
      } catch (err) {
        logger?.warn({ id: sidecar.id, err }, 'bug-report: failed to write generated sidecar');
      }
      await runRetentionSweep(dir, inFlight, logger, scanWarned).catch((err: unknown) => {
        logger?.warn({ err }, 'bug-report: retention sweep failed unexpectedly');
      });
    },
    sendHooks: {
      onSendStart: (id) => markUploading(dir, id, inFlight, logger),
      onSendResult: (id, outcome) =>
        recordSendResult(dir, id, outcome, inFlight, logger, scanWarned),
    },
    list: () => listReports(dir, logger, scanWarned),
    remove: (id) => deleteReport(dir, id, inFlight),
    reconcileStaleUploading: () => reconcileStaleUploading(dir, logger, scanWarned),
  };
}

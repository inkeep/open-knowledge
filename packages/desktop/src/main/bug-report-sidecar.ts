/**
 * Bug-report sidecar store — the durable, filesystem-as-truth record backing
 * the report retry list.
 *
 * One small YAML file per generated report lives next to its zip in
 * `~/.ok/bug-reports/`, same basename with a `.yaml` extension. It records the
 * report's last-known send state so the history list can show, retry, and clean
 * up prior reports across dialog close and app restart — the zip is the
 * payload, the sidecar is the record. There is no central index: the list is
 * derived by scanning the directory (mirrors the crash-ack / no-central-index
 * grain).
 *
 * This module owns the write/read/list/delete/retention/reconcile logic and the
 * process-local in-flight lock. It plugs into `handleBugReportCreate` (writes the
 * `generated` sidecar) and `handleBugReportSend` (records the `uploading` →
 * terminal transitions) through the hook seams those handlers expose, so the
 * state machine is exercised by the same unit tests that drive create/send.
 *
 * Reuses `atomic-yaml-write` (tmp + rename) and the `yaml` document API exactly
 * as `server/src/skill-state.ts` does — but a corrupt or absent sidecar
 * synthesizes a degraded row rather than dropping the file: one bad file must
 * never break the list, and a pre-feature zip with no sidecar must still appear.
 * Writes are atomic; a write failure never loses the newest unsent bundle. The
 * state machine is enforced by these writers, not by the schema.
 */

import { readdir, readFile, realpath, stat, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import {
  isReportIdShape,
  normalizeReportSidecarState,
  type OkBugReportDeleteResult,
  type OkBugReportListResult,
  type OkBugReportListRow,
  REPORT_SIDECAR_SCHEMA_VERSION,
  type ReportBundleLevel,
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

/** Minimal logger duck-type (matches pino `getLogger(name)` and ad-hoc shims). */
export interface SidecarLogger {
  warn: (data: unknown, message: string) => void;
}

/**
 * Process-local set of report ids whose send is currently in flight. A send
 * cannot outlive the process, so this in-memory structure is authoritative for
 * "is this report mid-send right now?": it blocks a second concurrent retry, a
 * delete, and a retention eviction of a report being uploaded. A
 * fresh registry per store instance keeps tests isolated.
 */
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

/** The sidecar path for a report id (`<base>-bugreport.zip` → `<base>-bugreport.yaml`). */
export function sidecarPathForId(dir: string, id: string): string {
  return join(dir, id.replace(/\.zip$/, '.yaml'));
}

/** The zip path for a report id. */
export function zipPathForId(dir: string, id: string): string {
  return join(dir, id);
}

/**
 * Serialize a validated sidecar to YAML and write it atomically. Mirrors
 * `skill-state`'s `parseDocument('')` + `createNode` + `toString()` (the raw
 * `atomicWriteFile` writes strings, not YAML — CORRECTION per the impl guide).
 * Validates before write so a malformed object never lands on disk. Throws on a
 * genuine write failure; callers decide whether to swallow (create is fail-soft)
 * or surface it.
 */
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

/**
 * Read + validate a sidecar. Returns `null` on ENOENT, YAML parse error, or
 * schema violation — the forgiving-read contract (the caller synthesizes a
 * degraded row). Only a genuine non-ENOENT IO error propagates.
 */
export async function readReportSidecar(sidecarPath: string): Promise<ReportSidecar | null> {
  let content: string;
  try {
    content = await readFile(sidecarPath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  const doc = parseDocument(content);
  if (doc.errors.length > 0) return null;
  const parsed = ReportSidecarSchema.safeParse(doc.toJSON());
  return parsed.success ? parsed.data : null;
}

interface ScannedReport {
  id: string;
  sidecar: ReportSidecar | null;
  /** A sidecar FILE was present (even if unreadable/corrupt). */
  sidecarPresent: boolean;
  zipExists: boolean;
  zipBytes: number;
  zipMtime: string | null;
}

/**
 * Scan the reports directory into a union of every report keyed by id: a zip
 * with or without a sidecar, and a tombstone sidecar whose zip is gone. Scoped
 * to the report basename shape so an unrelated file in the directory is ignored.
 */
async function scanReports(dir: string): Promise<ScannedReport[]> {
  const entries = await readdir(dir).catch(() => [] as string[]);
  const ids = new Set<string>();
  const sidecarIds = new Set<string>();
  for (const entry of entries) {
    if (entry.endsWith('.zip') && isReportIdShape(entry)) {
      ids.add(entry);
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
      const sidecar = sidecarPresent
        ? await readReportSidecar(sidecarPathForId(dir, id)).catch(() => null)
        : null;
      return {
        id,
        sidecar,
        sidecarPresent,
        zipExists: zipStat !== null,
        zipBytes: zipStat?.size ?? sidecar?.zipBytes ?? 0,
        zipMtime: zipStat?.mtime.toISOString() ?? null,
      };
    }),
  );
}

/** Normalize a raw `bundleLevel` to a known level or the `'unknown'` sentinel. */
function projectBundleLevel(raw: string | undefined): ReportBundleLevel | 'unknown' {
  return raw === 'standard' || raw === 'full' ? raw : 'unknown';
}

/** Project a scanned report to the renderer-facing list row. */
function toListRow(dir: string, scanned: ScannedReport): OkBugReportListRow {
  const s = scanned.sidecar;
  // A sidecar file that was present but unreadable can't be trusted as
  // `generated` — it renders as a degraded `unknown` row. A plain
  // sidecar-less legacy zip is a normal, retryable `generated` report.
  const state: ReportSidecarState = s
    ? normalizeReportSidecarState(s.state)
    : scanned.sidecarPresent
      ? 'unknown'
      : scanned.zipExists
        ? 'generated'
        : 'unknown';
  const degraded = (scanned.sidecarPresent && s === null) || state === 'unknown';
  const projectSlug = s?.projectSlug ?? null;
  return {
    id: scanned.id,
    createdAt: s?.createdAt ?? scanned.zipMtime ?? '',
    bundleLevel: projectBundleLevel(s?.bundleLevel),
    state,
    zipBytes: scanned.zipBytes,
    zipDeleted: s?.zipDeleted ?? !scanned.zipExists,
    zipExists: scanned.zipExists,
    systemWide: s?.systemWide ?? projectSlug === null,
    projectSlug,
    ...(s?.reference !== undefined ? { reference: s.reference } : {}),
    ...(s?.lastError !== undefined ? { lastError: s.lastError } : {}),
    attemptsCount: s?.attempts?.length ?? 0,
    zipPath: zipPathForId(dir, scanned.id),
    retryable: scanned.zipExists && state !== 'sent' && state !== 'uploading',
    degraded,
  };
}

/** List persisted reports, newest first. Never throws — a scan failure resolves to `{ ok: false }`. */
export async function listReports(dir: string): Promise<OkBugReportListResult> {
  try {
    const scanned = await scanReports(dir);
    const reports = scanned
      .map((r) => toListRow(dir, r))
      // Newest first by createdAt; empty timestamps (unreadable, no zip mtime)
      // sort last, tie-broken by id so the order is deterministic.
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

/**
 * Verify a renderer-supplied `id` is a report basename and resolves inside the
 * reports directory before any file op — a belt-and-suspenders gate. The
 * lexical containment check is the cheap pre-filter; the realpath check holds
 * against a symlinked report path, matching the send handler's order.
 */
async function resolveContainedId(dir: string, id: string): Promise<string | null> {
  if (!isReportIdShape(id)) return null;
  const zipPath = zipPathForId(dir, id);
  if (!isPathWithinProject(zipPath, dir, process.platform)) return null;
  try {
    const canonicalRoot = await realpath(dir);
    // The zip may be gone (a sent tombstone) — resolve the directory instead so
    // deleting a tombstone's sidecar still passes containment.
    const canonicalDir = await realpath(dirname(zipPath));
    if (!isPathWithinProject(join(canonicalDir, id), canonicalRoot, process.platform)) return null;
  } catch {
    return null;
  }
  return zipPath;
}

/** Best-effort unlink that ignores ENOENT; returns false only on a real removal failure. */
async function unlinkIfPresent(path: string): Promise<boolean> {
  try {
    await unlink(path);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT';
  }
}

/**
 * Delete a report's zip and sidecar by id. Containment + id-shape checked;
 * refused while the report's own send is in flight. `not-found` when neither file
 * exists; `io-error` when a removal fails.
 */
export async function deleteReport(
  dir: string,
  id: string,
  inFlight: InFlightRegistry,
): Promise<OkBugReportDeleteResult> {
  const zipPath = await resolveContainedId(dir, id);
  if (zipPath === null) return { ok: false, reason: 'id-invalid' };
  if (inFlight.has(id)) return { ok: false, reason: 'in-flight' };
  const sidecarPath = sidecarPathForId(dir, id);
  const zipExisted = await stat(zipPath).then(
    () => true,
    () => false,
  );
  const sidecarExisted = await stat(sidecarPath).then(
    () => true,
    () => false,
  );
  if (!zipExisted && !sidecarExisted) return { ok: false, reason: 'not-found' };
  const zipOk = await unlinkIfPresent(zipPath);
  const sidecarOk = await unlinkIfPresent(sidecarPath);
  return zipOk && sidecarOk ? { ok: true } : { ok: false, reason: 'io-error' };
}

/** Build a minimal `generated` sidecar for a report with no readable record (a retried legacy zip). */
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

/**
 * Mark a report `uploading` and acquire the in-flight lock (the `onSendStart`
 * hook). Returns `{ proceed: false }` when the report's send is already in
 * flight — the caller refuses the second concurrent retry. Fail-open: an
 * internal write error keeps the lock and still proceeds, so a transient
 * sidecar issue never blocks an actual send.
 */
async function markUploading(
  dir: string,
  id: string,
  inFlight: InFlightRegistry,
  logger?: SidecarLogger,
): Promise<{ proceed: boolean }> {
  if (inFlight.has(id)) return { proceed: false };
  inFlight.add(id);
  try {
    const base =
      (await readReportSidecar(sidecarPathForId(dir, id)).catch(() => null)) ??
      (await synthesizeSidecar(dir, id));
    await writeReportSidecar(dir, { ...base, state: 'uploading' });
  } catch (err) {
    logger?.warn({ id, err }, 'bug-report: failed to mark report uploading');
  }
  return { proceed: true };
}

/**
 * Record a send's terminal outcome (the `onSendResult` hook): write the
 * `sent`/`upload-failed`/`email-drafted` state, append a bounded attempt,
 * release the in-flight lock, and run retention (which reclaims the zip on a
 * confirmed send). Never throws.
 */
async function recordSendResult(
  dir: string,
  id: string,
  outcome: SidecarSendOutcome,
  inFlight: InFlightRegistry,
  logger?: SidecarLogger,
): Promise<void> {
  const at = new Date().toISOString();
  try {
    const base =
      (await readReportSidecar(sidecarPathForId(dir, id)).catch(() => null)) ??
      (await synthesizeSidecar(dir, id));
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
    // Rebuild without a stale lastError, then set the new terminal fields.
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
  } catch (err) {
    logger?.warn({ id, err }, 'bug-report: failed to record send result');
  } finally {
    inFlight.delete(id);
  }
  // Retention runs after the terminal write so a just-`sent` report's zip is
  // reclaimed and the caps re-enforced. The report is no longer in flight here.
  // The sweep logs its own per-file failures and is documented never to throw,
  // so anything caught here is a contract violation — log it rather than
  // discarding it, or a sweep that stops running becomes undiagnosable.
  await runRetentionSweep(dir, inFlight, logger).catch((err: unknown) => {
    logger?.warn({ err }, 'bug-report: retention sweep failed unexpectedly');
  });
}

/**
 * Startup reconciliation: a send cannot survive a restart, so any
 * sidecar still in `uploading` at boot is a poison row left by a crash or quit
 * mid-send — demote it to `upload-failed` so it becomes retryable and evictable
 * again. Runs before any send, so the in-flight set is empty. Never throws.
 */
export async function reconcileStaleUploading(
  dir: string,
  logger?: SidecarLogger,
): Promise<number> {
  let reconciled = 0;
  try {
    const scanned = await scanReports(dir);
    const at = new Date().toISOString();
    for (const report of scanned) {
      if (report.sidecar === null) continue;
      if (normalizeReportSidecarState(report.sidecar.state) !== 'uploading') continue;
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

/**
 * Hybrid retention sweep. Reclaims the zip on every confirmed send
 * (keeping the sidecar tombstone), then bounds the sent tombstones by count and
 * the UNSENT bundles by count + total size. Eviction never removes the newest
 * unsent bundle, an `uploading` bundle, or a bundle whose send is in flight, and
 * an unlink failure is skipped rather than aborting the sweep. Never throws.
 */
export async function runRetentionSweep(
  dir: string,
  inFlight: InFlightRegistry,
  logger?: SidecarLogger,
): Promise<void> {
  let scanned: ScannedReport[];
  try {
    scanned = await scanReports(dir);
  } catch (err) {
    logger?.warn({ err }, 'bug-report: retention scan failed');
    return;
  }

  const stateOf = (r: ScannedReport): ReportSidecarState =>
    r.sidecar
      ? normalizeReportSidecarState(r.sidecar.state)
      : r.zipExists
        ? 'generated'
        : 'unknown';

  // Drop the zip on a confirmed send; keep the sidecar as a tombstone.
  for (const r of scanned) {
    if (stateOf(r) === 'sent' && r.zipExists && r.sidecar && !inFlight.has(r.id)) {
      const removed = await unlinkIfPresent(zipPathForId(dir, r.id));
      if (removed) {
        r.zipExists = false;
        await writeReportSidecar(dir, { ...r.sidecar, zipDeleted: true }).catch((err: unknown) => {
          logger?.warn({ id: r.id, err }, 'bug-report: failed to tombstone a sent report');
        });
      }
    }
  }

  const sortByCreatedAtAsc = (a: ScannedReport, b: ScannedReport): number => {
    const at = a.sidecar?.createdAt ?? a.zipMtime ?? '';
    const bt = b.sidecar?.createdAt ?? b.zipMtime ?? '';
    return at < bt ? -1 : at > bt ? 1 : a.id < b.id ? -1 : 1;
  };

  // Sent-tombstone cap: oldest first, delete the sidecar (the zip is already gone).
  const tombstones = scanned
    .filter((r) => stateOf(r) === 'sent' && !r.zipExists)
    .sort(sortByCreatedAtAsc);
  const tombstoneOverflow = Math.max(0, tombstones.length - MAX_SENT_TOMBSTONE_COUNT);
  for (const tombstone of tombstones.slice(0, tombstoneOverflow)) {
    await unlinkIfPresent(sidecarPathForId(dir, tombstone.id));
  }

  // Orphan sweep: an unparseable sidecar whose zip is already gone belongs to
  // neither cap above (not `sent`, so not a tombstone; no zip, so not unsent)
  // and would otherwise accumulate forever. Keyed on a sidecar that is present
  // but FAILED TO PARSE — never on a normalized `'unknown'` state, since a
  // sidecar written by a newer app with a state this build doesn't recognize
  // still parses, and reclaiming it would make the open-enum forward
  // compatibility the schema exists for a lie.
  for (const r of scanned) {
    if (r.sidecarPresent && r.sidecar === null && !r.zipExists && !inFlight.has(r.id)) {
      await unlinkIfPresent(sidecarPathForId(dir, r.id));
      logger?.warn({ id: r.id }, 'bug-report: reclaimed an unreadable sidecar with no bundle');
    }
  }

  // Unsent-bundle caps (count + total size). A bundle is unsent when its zip is
  // present and it is not `sent`. Never evict the newest unsent, an `uploading`
  // bundle, or an in-flight one.
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

/** The report-sidecar surface desktop main wires into the bug-report dispatch handlers. */
export interface BugReportSidecarStore {
  /** `onReportGenerated` hook: persist the `generated` sidecar + run retention. */
  recordGenerated(meta: GeneratedReportMeta): Promise<void>;
  /** Send-path state hooks passed to `handleBugReportSend`. */
  sendHooks: BugReportSendSidecarHooks;
  /** List persisted reports (dispatch `list` arm). */
  list(): Promise<OkBugReportListResult>;
  /** Delete a report by id (dispatch `delete` arm). */
  remove(id: string): Promise<OkBugReportDeleteResult>;
  /** Demote any stale `uploading` sidecar to `upload-failed` (boot). */
  reconcileStaleUploading(): Promise<number>;
}

/**
 * Construct the report-sidecar store for a reports directory, with its own
 * process-local in-flight registry. One instance is wired into desktop main's
 * bug-report dispatch handlers.
 */
export function createBugReportSidecarStore(opts: {
  dir: string;
  logger?: SidecarLogger;
}): BugReportSidecarStore {
  const { dir, logger } = opts;
  const inFlight = createInFlightRegistry();
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
      };
      try {
        await writeReportSidecar(dir, sidecar);
      } catch (err) {
        logger?.warn({ id: sidecar.id, err }, 'bug-report: failed to write generated sidecar');
      }
      await runRetentionSweep(dir, inFlight, logger).catch((err: unknown) => {
        logger?.warn({ err }, 'bug-report: retention sweep failed unexpectedly');
      });
    },
    sendHooks: {
      onSendStart: (id) => markUploading(dir, id, inFlight, logger),
      onSendResult: (id, outcome) => recordSendResult(dir, id, outcome, inFlight, logger),
    },
    list: () => listReports(dir),
    remove: (id) => deleteReport(dir, id, inFlight),
    reconcileStaleUploading: () => reconcileStaleUploading(dir, logger),
  };
}

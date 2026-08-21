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
 *
 * Reading and writing are forgiving in *different* ways, and the difference is
 * load-bearing. The list tolerates an unreadable sidecar by degrading the row.
 * The send-path writers refuse to REWRITE one: only a genuinely absent record
 * is synthesized over, because since the note is persisted the file holds the
 * reporter's own prose, and a transient EACCES must not be allowed to erase it.
 * Retention is the deliberate exception — it still unlinks an unreadable
 * sidecar whose bundle is already gone, and one evicted by the unsent caps.
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
 * Why a sidecar could be read but not used — diagnostic only; all three
 * preserve. Deliberately not exported: it is reachable through
 * `SidecarReadResult`, and knip fails the drift gate on an export nothing
 * outside this module consumes.
 */
type SidecarUnreadableReason = 'io-error' | 'parse-error' | 'schema-invalid';

/**
 * The outcome of reading one sidecar. `absent` and `unreadable` are separate
 * arms on purpose: a missing file means this report has no record, an
 * unreadable one means we could not tell what its record says. Collapsing them
 * into a single nullish channel is what let a transient EACCES be mistaken for
 * "never had a sidecar" and overwritten.
 */
export type SidecarReadResult =
  | { kind: 'ok'; sidecar: ReportSidecar }
  | { kind: 'absent' }
  | { kind: 'unreadable'; reason: SidecarUnreadableReason; err?: unknown };

/**
 * Read + validate a sidecar. Never throws: every failure is a value, so no
 * caller has to wrap this in a `.catch` that flattens the distinction back out.
 */
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
    // Guarded for the same reason as `toJSON` below: the composer is recursive
    // descent, so deeply nested input can exhaust the stack and throw rather
    // than fill `doc.errors`. `scanReports` no longer has a `.catch`, so any
    // escape here would take the whole history list with it.
    doc = parseDocument(content);
  } catch (err) {
    return { kind: 'unreadable', reason: 'parse-error', err };
  }
  if (doc.errors.length > 0) {
    return { kind: 'unreadable', reason: 'parse-error', err: doc.errors[0] };
  }
  let value: unknown;
  try {
    // `toJSON` throws rather than filling `doc.errors` on an alias bomb
    // (`ReferenceError: Excessive alias count indicates a resource exhaustion
    // attack`). The never-throws contract has to cover that too: `scanReports`
    // no longer wraps this call, so one such file would otherwise reject its
    // `Promise.all` and fail the whole history list.
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
  /**
   * The full read outcome. Kept alongside the flattened `sidecar` so consumers
   * that must not treat a momentary IO failure as durable corruption (the
   * retention orphan sweep) can tell the two apart.
   */
  sidecarRead: SidecarReadResult;
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
      // The list stays forgiving: an unreadable sidecar renders as a degraded
      // `unknown` row rather than failing the scan. `sidecarPresent` is what
      // keeps it from being mistaken for a sidecar-less legacy zip.
      const read = sidecarPresent
        ? await readReportSidecar(sidecarPathForId(dir, id))
        : ({ kind: 'absent' } as const);
      const sidecar = read.kind === 'ok' ? read.sidecar : null;
      return {
        id,
        sidecar,
        sidecarRead: read,
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
    ...(s?.note !== undefined ? { note: s.note } : {}),
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

/** Build a minimal `generated` sidecar for a report with no record at all (a retried legacy zip). */
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
 * Resolve the record a state transition should be built on, or `null` when the
 * existing record must not be overwritten.
 *
 * `absent` is the only outcome it is safe to synthesize for: there is no record
 * to lose, which is exactly the sidecar-less legacy zip being retried for the
 * first time. An `unreadable` sidecar is a file we failed to read, not a report
 * without a record — and since the note is persisted it holds the reporter's
 * own prose, so synthesizing over it destroys the text the row is titled by and
 * a retry would have resent. A transient EACCES, EIO or Windows AV lock would
 * erase it permanently and silently, so the send proceeds and the file is left
 * exactly as it is.
 */
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
    const base = await readSidecarForTransition(dir, id, logger);
    // A skipped mark is not a blocked send: the in-flight registry, not the
    // sidecar, is what refuses a second concurrent retry, and leaving the prior
    // state also spares the row a poison `uploading` a crash could strand.
    if (base !== null) {
      await writeReportSidecar(dir, { ...base, state: 'uploading' });
    }
  } catch (err) {
    logger?.warn({ id, err }, 'bug-report: failed to mark report uploading');
  }
  return { proceed: true };
}

/**
 * Record a send's terminal outcome (the `onSendResult` hook): write the
 * `sent`/`upload-failed`/`email-drafted` state, append a bounded attempt,
 * release the in-flight lock, and run retention (which reclaims the zip on a
 * confirmed send). Never throws. The state write is SKIPPED when the existing
 * sidecar could not be read — the outcome is logged instead of overwriting a
 * record whose contents are unknown, so the report stays retryable.
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
    const base = await readSidecarForTransition(dir, id, logger);
    if (base === null) {
      // The outcome cannot be persisted without erasing a record we could
      // not read. Log it instead: a confirmed send's reference is the
      // reporter's only handle on the report with support, so losing it
      // silently is worse than the missed state write. The row keeps its
      // prior state, which leaves the report retryable rather than stranded.
      logger?.warn({ id, outcome }, 'bug-report: send outcome not recorded, sidecar unreadable');
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
    }
  } catch (err) {
    // `outcome` rides along for the same reason the `base === null` branch logs
    // it: on a `sent` whose write failed, this is the only surviving copy of
    // the reference.
    logger?.warn({ id, err, outcome }, 'bug-report: failed to record send result');
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
  //
  // `io-error` is excluded for the same reason the send-path writers preserve:
  // it means we could not READ the file, not that the file is junk. A sent
  // tombstone is exactly this shape (zip reclaimed, sidecar holding the state,
  // the reference and the reporter's note), so unlinking one that is merely
  // locked or momentarily unreadable would destroy the record outright — a
  // harder version of the overwrite this fix exists to prevent.
  for (const r of scanned) {
    const durablyCorrupt =
      r.sidecarRead.kind === 'unreadable' && r.sidecarRead.reason !== 'io-error';
    if (durablyCorrupt && !r.zipExists && !inFlight.has(r.id)) {
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
        ...(meta.note !== undefined ? { note: meta.note } : {}),
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

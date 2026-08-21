/**
 * IPC handler implementation for the in-app "Report a bug" flow.
 *
 * Single channel `ok:bug-report:dispatch` with discriminated args, following
 * the `ok:sharing:dispatch` precedent so the whole report-a-bug surface costs
 * one hand-rolled channel slot. The surface carries three operations:
 *   - `create` — build the redacted diagnostic zip via the CLI package's
 *     leveled `collectReportBundle` (no subprocess), scoped to the sender
 *     window's project or system-wide when the window has no project.
 *   - `send` — upload a previously created zip to the private intake
 *     endpoint; every failure degrades to a prefilled email fallback.
 *   - `crash-ack` — persist that the user answered (or dismissed) a
 *     crash-detected invitation so the same crash event never re-prompts.
 *
 * Project scoping: main resolves the sender window's project via the
 * window-manager context; the renderer never passes a project path.
 */

import { randomUUID } from 'node:crypto';
import { readFile, realpath, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import {
  type BundleLogger,
  collectReportBundle,
  defaultBugReportZipPath,
  type LanguageMetadata,
  redactContent,
} from '@inkeep/open-knowledge';
import {
  BUG_REPORT_SCREENSHOT_ZIP_NAME,
  isReportIdShape,
  type OkBugReportCrashAckResult,
  type OkBugReportCrashDumpAvailability,
  type OkBugReportCreateResult,
  type OkBugReportScreenshot,
  type OkBugReportSendMetadata,
  type OkBugReportSendResult,
  type ReportBundleLevel,
} from '@inkeep/open-knowledge-core';
import type { OkBugReportSendInput } from '@inkeep/open-knowledge-core/desktop-bridge';
import { type BugReportSendTrace, beginSendTrace } from '../bug-report-trace.ts';
import type { MinidumpReportLookup } from '../crash-detection.ts';
import { logIpcError } from '../ipc-log.ts';
import { isPathWithinProject } from '../path-containment.ts';
import type { UpdateChannel } from '../state-store.ts';

export interface OkBugReportCreateRequest {
  kind: 'create';
  level: ReportBundleLevel;
  /** Free-text user note bundled as `note.txt` (secret-scrubbed like every text entry). */
  note?: string;
  /**
   * Crash-invite opt-in: copy the newest un-acked crash minidump into the
   * bundle under `extra/`, raw. Minidumps carry process memory that text
   * redaction cannot scrub, so absence (the default) must always mean no
   * dump — only the dialog's explicit checkbox sets this.
   */
  includeCrashDump?: boolean;
  /**
   * Screenshot opt-in (default on in the dialog): stage the app screenshot
   * captured when the dialog opened into the bundle at `extra/screenshot.png`,
   * raw. The picture is unredactable, but the dialog previews it before send so
   * the user has already seen exactly what is included — absence still means no
   * screenshot, and the bytes are main-owned (never a renderer-supplied path).
   */
  includeScreenshot?: boolean;
}

interface OkBugReportCaptureScreenshotRequest {
  kind: 'capture-screenshot';
}

/** Read the persisted report history (newest first). */
interface OkBugReportListRequest {
  kind: 'list';
}

/** Remove a persisted report (zip + sidecar) by `id`, containment-checked. */
interface OkBugReportDeleteRequest {
  kind: 'delete';
  /** The report's timestamp-basename `id` (== zip basename). */
  id: string;
}

// `traceparent` is NOT redeclared here: it lives on `OkBugReportSendInput` in
// core, which is the shared wire contract both sides read.
export type OkBugReportSendRequest = OkBugReportSendInput & { kind: 'send' };

export interface OkBugReportCrashAckRequest {
  kind: 'crash-ack';
  /** `eventId` from the `ok:bug-report:crash-detected` push being answered. */
  eventId: string;
}

/**
 * Ask main whether it is holding a crash dump this report could carry.
 *
 * A crash-detected invitation already answers this on its own event, so only a
 * report the user opened themselves needs to ask. Without it that report can
 * never offer the dump — which is precisely the report filed moments after a
 * crash the user was never prompted about, and so the one where the dump
 * matters most.
 */
interface OkBugReportCrashDumpAvailabilityRequest {
  kind: 'crash-dump-availability';
}

/** Every operation the `ok:bug-report:dispatch` channel carries. */
export type OkBugReportRequest =
  | OkBugReportCreateRequest
  | OkBugReportSendRequest
  | OkBugReportCrashAckRequest
  | OkBugReportCaptureScreenshotRequest
  | OkBugReportCrashDumpAvailabilityRequest
  | OkBugReportListRequest
  | OkBugReportDeleteRequest;

/**
 * Host metadata handed to the bundle collector through its typed
 * `readDesktopEnv` seam. Never routed via `process.env`: the main process is
 * long-lived, and env mutations would leak `OK_DESKTOP_*` into every child
 * later spawned with `env: process.env` (e.g. a server respawn).
 */
interface BugReportDesktopMeta {
  /** App version (`app.getVersion()`). */
  version: string;
  /** Packaged build vs dev run (`app.isPackaged`). */
  packaged: boolean;
  /** Update channel implied by the build version (`channelFromVersion`). */
  channel: UpdateChannel;
}

export interface BugReportCreateDeps {
  /** Sender window's project root; `null` (Navigator, no project) degrades to a system-wide bundle. */
  projectDir: string | null;
  desktopMeta: BugReportDesktopMeta;
  /**
   * The interface language this report is being filed in, handed to the bundle
   * collector through its `readLanguage` seam.
   *
   * Injected rather than left to the collector's default for the same reason
   * `desktopMeta` is: that default resolves `'system'` against `LANG` /
   * `LC_ALL`, and a macOS app launched from Finder has neither — every report
   * from the packaged app would claim the fallback locale no matter what the
   * user was looking at. Main resolves against the platform language list
   * instead, and against the preference the renderer last pushed, so the
   * recorded language is the one on screen rather than the one on disk (the
   * config write is debounced and lands later).
   */
  readLanguage?: () => LanguageMetadata;
  /** Zip destination override; defaults to `~/.ok/bug-reports/<timestamp>-bugreport.zip`. */
  outputPath?: string;
  /** User-level logs directory override (standard-level test seam). */
  userLogsDir?: string;
  /**
   * Crash-detection lookup for the newest un-acked minidump (wired from
   * `CrashDetection.newestMinidumpForReport`). Only consulted when the renderer
   * opted in via `includeCrashDump` — the lookup walks the crash-dumps dir and
   * parses dump headers, so calling it on every report would charge an ordinary
   * bug report for a crash artifact it never wanted. Absent, or returning a null
   * path, simply omits the dump; the lookup's skip counts explain which.
   */
  newestMinidumpForReport?: () => MinidumpReportLookup;
  /**
   * Main-owned PNG bytes of the screenshot captured when the report dialog
   * opened, consulted only when the renderer opted in via `includeScreenshot`.
   * Returns `null` when no screenshot was captured for the sender window (capture
   * failed, or a non-desktop caller). The bytes are staged to a temp file the
   * handler owns and deletes — the renderer never supplies a path.
   */
  screenshotPngBytes?: () => Buffer | null;
  /**
   * Sink for the collector's warnings — most importantly an opted-in crash
   * dump that could not be staged, which must be traceable rather than a
   * silent omission from the bundle.
   */
  logger?: BundleLogger;
  /**
   * Drain `logger`'s buffer to disk. The desktop destination is asynchronous,
   * so a line emitted moments before the collector reads the log file can
   * still be in memory when those bytes are snapshotted — which would keep the
   * crash-dump record out of the very bundle it explains. Absent in tests,
   * where the logger is a synchronous in-memory recorder.
   */
  flushLogger?: () => void;
  /**
   * Persist the report's `generated` sidecar (and run the retention sweep)
   * after a bundle is written. Injected so the durable-record write is exercised
   * by the create tests against a temp bug-reports dir; a create context that
   * doesn't persist (or a sidecar write that throws) never changes the create
   * outcome — the zip is already on disk.
   */
  onReportGenerated?: (meta: GeneratedReportMeta) => Promise<void>;
}

/**
 * Ceiling on the free-text note the renderer may hand to `create`/`send`. A
 * genuine "what happened?" note is a sentence or two; this refuses an abusive
 * or compromised renderer stuffing megabytes of text through the typed IPC
 * boundary (the note is embedded in the zip and the mailto fallback).
 */
const MAX_NOTE_LENGTH = 32_768;

/** A note is valid when absent, or a string within the length ceiling. */
function isValidNote(note: unknown): boolean {
  return note === undefined || (typeof note === 'string' && note.length <= MAX_NOTE_LENGTH);
}

/**
 * `createHandler` casts renderer args without runtime enforcement, so the
 * payload is re-validated here before any filesystem work.
 */
function isCreateRequest(request: unknown): request is OkBugReportCreateRequest {
  if (typeof request !== 'object' || request === null) return false;
  const r = request as Record<string, unknown>;
  return (
    r.kind === 'create' &&
    (r.level === 'standard' || r.level === 'full') &&
    isValidNote(r.note) &&
    (r.includeCrashDump === undefined || typeof r.includeCrashDump === 'boolean') &&
    (r.includeScreenshot === undefined || typeof r.includeScreenshot === 'boolean')
  );
}

/**
 * Why a bundle did or did not carry a crash minidump. A bundle that arrives
 * without one is otherwise unexplainable after the fact: the reporter having
 * unchecked the box, no attachable dump existing, and a staging failure all
 * reach triage as the same empty `extra/`.
 *
 * Deliberately five values, not more. `foreign-only` and `unreadable-only`
 * would leave a mixed walk with no home, so what the ownership walk rejected
 * rides as two counts instead. `read-failed` and `disappeared` collapse into
 * `stage-failed` because neither collector distinguishes them: the standard
 * level catches every read error in one branch and the full level only tests
 * for existence, so both surface identically as an entry that never appeared.
 */
type MinidumpAttachReason =
  /** The dump was opted into and is in the bundle. */
  | 'attached'
  /** The checkbox was shown and the reporter unchecked it. */
  | 'declined'
  /** No checkbox was shown, so no dump was ever in play. */
  | 'not-offered'
  /** Opted in, but the lookup found no dump this app can prove it owns. */
  | 'none-available'
  /** Opted in with a dump on hand, but it never reached the bundle. */
  | 'stage-failed';

/** No lookup ran, so nothing was found and nothing was skipped. */
const NO_MINIDUMP_LOOKUP: MinidumpReportLookup = {
  path: null,
  foreignSkipped: 0,
  unknownSkipped: 0,
};

/** The one intent whose outcome only the finished bundle can settle. */
export interface StagingMinidumpIntent {
  reason: 'staging';
  /** Zip entry the dump will occupy if the collector places it. */
  zipEntry: string;
}

/**
 * What is knowable about the crash dump before the bundle is built. Three of
 * the five outcomes are already final here — they turn on the opt-in and the
 * lookup alone — and `staging` covers the one that still depends on whether
 * the collector managed to place the file. `Exclude` rather than a re-listed
 * union so a sixth reason cannot be added without deciding which side of
 * collection settles it.
 */
export type MinidumpIntent =
  | { reason: Exclude<MinidumpAttachReason, 'attached' | 'stage-failed'> }
  | StagingMinidumpIntent;

/**
 * Decide everything about the crash dump that does not require a finished
 * bundle. Owns the zip entry name too, so the name the dump is looked for
 * under is by construction the name it was staged under.
 */
export function resolveMinidumpIntent(input: {
  /** The renderer's opt-in, tri-state: unchecked, checked, or never offered. */
  requested: boolean | undefined;
  /** Absolute path the lookup found, or null when it found nothing attachable. */
  minidumpPath: string | null;
}): MinidumpIntent {
  if (input.requested === undefined) return { reason: 'not-offered' };
  if (input.requested === false) return { reason: 'declined' };
  if (input.minidumpPath === null) return { reason: 'none-available' };
  return { reason: 'staging', zipEntry: `extra/${basename(input.minidumpPath)}` };
}

/**
 * Settle a staged dump against the bundle's own inventory rather than against
 * the intent to stage, so a dump the collector silently dropped cannot report
 * as attached.
 *
 * The boolean is fully determined by the reason, so the return type pairs them
 * rather than leaving `{ attached: true, reason: 'stage-failed' }` expressible
 * — the same discriminated encoding `MinidumpIntent` uses.
 */
export function resolveMinidumpAttachment(
  intent: StagingMinidumpIntent,
  /** The bundle's captured entry names. */
  bundledFiles: readonly string[],
): { attached: true; reason: 'attached' } | { attached: false; reason: 'stage-failed' } {
  // Match the exact entry: `extra/` is shared with the opted-in screenshot, so
  // a prefix test reports a dump whenever a screenshot rode along.
  if (bundledFiles.includes(intent.zipEntry)) return { attached: true, reason: 'attached' };
  return { attached: false, reason: 'stage-failed' };
}

/**
 * Emit one crash-dump decision record. Observing the report must never be able
 * to fail a report that otherwise succeeded, so a logger that throws is
 * swallowed here — the same fail-soft posture as the sidecar write.
 */
function recordMinidumpDecision(
  logger: BundleLogger | undefined,
  level: 'info' | 'warn',
  payload: Record<string, unknown>,
  message: string,
): void {
  try {
    if (level === 'warn') logger?.warn(payload, message);
    else logger?.info(payload, message);
  } catch {
    // The logger is the thing that failed; there is nowhere left to report it.
  }
}

/**
 * Build the redacted bug-report bundle for the `create` operation. Never
 * throws — every failure mode maps to the discriminated `{ok: false}` result
 * so the report dialog can render its failure state.
 */
export async function handleBugReportCreate(
  deps: BugReportCreateDeps,
  request: OkBugReportCreateRequest,
): Promise<OkBugReportCreateResult> {
  if (!isCreateRequest(request)) {
    logIpcError({
      event: 'ipc.error',
      channel: 'ok:bug-report:dispatch',
      reason: 'invalid-request',
      handler: 'handleBugReportCreate',
    });
    return { ok: false, error: 'invalid-request' };
  }
  const minidumpLookup =
    request.includeCrashDump === true
      ? (deps.newestMinidumpForReport?.() ?? NO_MINIDUMP_LOOKUP)
      : NO_MINIDUMP_LOOKUP;
  const minidumpPath = minidumpLookup.path;
  const intent = resolveMinidumpIntent({
    requested: request.includeCrashDump,
    minidumpPath,
  });
  const screenshotBytes =
    request.includeScreenshot === true ? (deps.screenshotPngBytes?.() ?? null) : null;

  // Both raw artifacts ride the same byte-for-byte `extra/` seam the collector
  // never scrubs. The minidump comes in by path; the screenshot bytes are
  // main-owned in-memory, so stage them to a temp file the `finally` deletes —
  // a picture of the user's screen must not linger in tmp once it is zipped.
  const extraFiles: { sourcePath: string; zipName?: string }[] = [];
  if (minidumpPath !== null) extraFiles.push({ sourcePath: minidumpPath });

  // Size is read here, not after collection, so it describes the dump as it
  // was when the decision was taken.
  const dumpSizeBytes =
    minidumpPath === null
      ? undefined
      : await stat(minidumpPath)
          .then((s) => s.size)
          .catch(() => undefined);
  // Deliberately says nothing about WHICH dump: a minidump is unredactable
  // process memory and its filename is a per-crash identifier, so the record
  // carries a size at most.
  const decisionFacts = {
    event: 'bug-report.minidump-decision',
    requested: request.includeCrashDump === true,
    ...(request.includeCrashDump === true
      ? {
          minidumpAvailable: minidumpPath !== null,
          // Counts ride the opted-in branch only, so they never appear on a
          // report where no dump was ever in play — a zero there would read as
          // "we walked the crash database and found it clean".
          foreignDumpsIgnored: minidumpLookup.foreignSkipped,
          unreadableDumpsSkipped: minidumpLookup.unknownSkipped,
        }
      : {}),
    ...(dumpSizeBytes !== undefined ? { sizeBytes: dumpSizeBytes } : {}),
  };

  // Written BEFORE the bundle is collected, because the collector snapshots
  // the log file's bytes as it runs: a line emitted afterwards can only reach
  // triage in some later report, which is the undiagnosable shape this record
  // exists to remove. Every terminal reason is already settled here, so a
  // bundle carrying only this line still explains itself; `staging` is the one
  // reason left open, and then the bundle's own `extra/` is the answer.
  recordMinidumpDecision(
    deps.logger,
    'info',
    { ...decisionFacts, phase: 'intent', reason: intent.reason },
    'bug-report: crash-dump decision recorded before collection',
  );
  try {
    deps.flushLogger?.();
  } catch {
    // A failed drain costs the line its place in this bundle, nothing more.
  }

  let screenshotTmpPath: string | null = null;
  try {
    if (screenshotBytes !== null) {
      screenshotTmpPath = join(tmpdir(), `ok-bugreport-screenshot-${randomUUID()}.png`);
      // Owner-only: the file is a picture of the user's screen sitting in a
      // world-readable tmp dir until the collector zips it, so keep it off
      // other local accounts (matches the subsystem's sensitive-sidecar mode).
      await writeFile(screenshotTmpPath, screenshotBytes, { mode: 0o600 });
      extraFiles.push({ sourcePath: screenshotTmpPath, zipName: BUG_REPORT_SCREENSHOT_ZIP_NAME });
    }
    const outputPath = deps.outputPath ?? defaultBugReportZipPath();
    const { zipPath, summary } = await collectReportBundle({
      level: request.level,
      projectDir: deps.projectDir ?? undefined,
      note: request.note,
      // The in-app surface always redacts; only the CLI exposes an opt-out.
      redact: true,
      outputPath,
      // A sidecar lives next to its zip, so the ledger to collect is the one in
      // the directory this report is being written into. That is the real
      // reports dir in production and the fixture dir under test, without a
      // second seam that could disagree with where the report actually lands.
      bugReportsDir: dirname(outputPath),
      userLogsDir: deps.userLogsDir,
      extraFiles: extraFiles.length === 0 ? undefined : extraFiles,
      logger: deps.logger,
      readDesktopEnv: () => ({
        electronVersion: deps.desktopMeta.version,
        packaged: deps.desktopMeta.packaged,
        channel: deps.desktopMeta.channel,
      }),
      readLanguage: deps.readLanguage,
    });
    const { size: zipSizeBytes } = await stat(zipPath);
    // Persist the durable `generated` record next to the zip. A failure here
    // must never lose the report (the zip is written) — the writer is fail-soft
    // and the call is guarded, so create still succeeds if the sidecar can't be
    // written.
    if (deps.onReportGenerated) {
      await deps
        .onReportGenerated({
          zipPath,
          zipBytes: zipSizeBytes,
          level: request.level,
          systemWide: summary.systemWide,
          projectSlug: summary.projectSlug,
        })
        .catch((err: unknown) => {
          deps.logger?.warn(
            { zipPath, err },
            'bug-report: failed to persist report sidecar on generate',
          );
        });
    }
    // Only a dump that was actually on hand has anything left to settle; the
    // other reasons were final before collection and said so. This line lands
    // in the NEXT report's logs, never this bundle — for this one, the pairing
    // is the intent line above plus whether `extra/` holds the dump.
    if (intent.reason === 'staging') {
      const { attached, reason } = resolveMinidumpAttachment(intent, summary.files);
      recordMinidumpDecision(
        deps.logger,
        attached ? 'info' : 'warn',
        { ...decisionFacts, phase: 'outcome', attached, reason },
        attached
          ? 'bug-report: opted-in crash dump reached the bundle'
          : 'bug-report: opted-in crash dump did not reach the bundle',
      );
    }
    return { ok: true, zipPath, zipSizeBytes, summary };
  } catch (err) {
    // Environmental failure at the fs boundary (unwritable destination, disk
    // full, unreadable project artifacts) — the producer can't enforce these
    // preconditions, and the channel's contract is a discriminated result.
    logIpcError({
      event: 'ipc.error',
      channel: 'ok:bug-report:dispatch',
      reason: 'bundle-failed',
      handler: 'handleBugReportCreate',
      cause: err,
    });
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    if (screenshotTmpPath !== null) {
      // A failed unlink leaves a screenshot of the user's screen in tmp, so
      // make it traceable rather than silent — but never let cleanup failure
      // change the create outcome.
      await unlink(screenshotTmpPath).catch((err: unknown) => {
        deps.logger?.warn(
          { screenshotTmpPath, err },
          'bug-report: failed to remove temp screenshot file',
        );
      });
    }
  }
}

/**
 * Minimal shape of an Electron `NativeImage` the capture handler needs, so its
 * store/listener lifecycle and zero-byte handling are unit-testable without an
 * Electron stub. `main/index.ts` passes the real `NativeImage` (structurally
 * compatible); tests pass a fake.
 */
export interface CapturableImage {
  toPNG(): Buffer;
  getSize(): { width: number; height: number };
  resize(options: { width: number }): CapturableImage;
  toDataURL(): string;
}

/** Store entry: the full-resolution PNG plus the `destroyed`-listener that reaps it. */
export interface BugReportScreenshotEntry {
  png: Buffer;
  cleanup: () => void;
}

export interface CaptureScreenshotDeps {
  /** Main-owned per-window store, keyed by `webContents.id`. */
  store: Map<number, BugReportScreenshotEntry>;
  /** Sender `webContents.id` — this window's store key. */
  senderId: number;
  /** Wraps `win.webContents.capturePage()`. May reject; the handler degrades to null. */
  capturePage: () => Promise<CapturableImage>;
  /** Max preview width (logical px); wider captures downscale for the data-URL. */
  previewWidth: number;
  /** Registers the one-shot `destroyed` reaper (wraps `sender.once('destroyed', cb)`). */
  registerCleanup: (cleanup: () => void) => void;
  /** Removes a previously-registered reaper (wraps `sender.removeListener('destroyed', cb)`). */
  unregisterCleanup: (cleanup: () => void) => void;
  logger?: BundleLogger;
}

/**
 * Capture the sender window for the `capture-screenshot` operation: hold the
 * full-resolution PNG in main (keyed by window) and return the renderer a
 * downscaled data-URL preview. Never throws — a failed or empty capture
 * resolves to `null` so the dialog simply omits the screenshot option.
 *
 * Re-capture on the same window replaces the prior entry AND unregisters its
 * `destroyed` reaper first, so repeated dialog opens can't accumulate
 * MaxListeners-worth of listeners on one `WebContents`.
 */
export async function handleBugReportCaptureScreenshot(
  deps: CaptureScreenshotDeps,
): Promise<OkBugReportScreenshot | null> {
  const dropExisting = () => {
    const existing = deps.store.get(deps.senderId);
    if (existing !== undefined) {
      deps.unregisterCleanup(existing.cleanup);
      deps.store.delete(deps.senderId);
    }
  };
  try {
    const image = await deps.capturePage();
    const png = image.toPNG();
    // A zero-byte capture (offscreen, or not yet painted) is not a usable
    // screenshot — omit the option rather than offer an empty picture.
    if (png.length === 0) {
      dropExisting();
      return null;
    }
    // Replace any prior capture for this window, dropping its stale reaper.
    dropExisting();
    const cleanup = () => {
      deps.store.delete(deps.senderId);
    };
    deps.store.set(deps.senderId, { png, cleanup });
    deps.registerCleanup(cleanup);
    const { width, height } = image.getSize();
    // The renderer only needs a legible thumbnail; downscale wide captures to
    // keep the data-URL small (the full-resolution bytes go in the bundle).
    const preview = width > deps.previewWidth ? image.resize({ width: deps.previewWidth }) : image;
    return { dataUrl: preview.toDataURL(), width, height };
  } catch (err) {
    dropExisting();
    deps.logger?.warn(
      { err },
      'bug-report: screenshot capture failed; dialog will omit the screenshot option',
    );
    return null;
  }
}

const SUPPORT_EMAIL = 'support@inkeep.com';

/**
 * Production intake origin used by every build when `OK_BUG_REPORT_INTAKE_URL`
 * is unset — the apex routes `/api/bug-report` to the private intake (see the
 * desktop README's bug-report table). Mirrors how the auto-updater
 * (`proxyFeed.base`) and share-handoff (`PROD_BASE`) hardcode `openknowledge.ai`
 * as the shipped default rather than relying on a runtime env var a
 * GUI-launched app never receives.
 */
export const DEFAULT_BUG_REPORT_INTAKE_URL = 'https://openknowledge.ai';

/**
 * Resolve the intake base URL for the `send` wiring. An explicit
 * `OK_BUG_REPORT_INTAKE_URL` always wins; otherwise EVERY build — packaged or an
 * unpackaged dev run — falls back to the production origin, so a report filed
 * from a dev build uploads rather than stranding its bundle on disk. Send is
 * always an explicit user action, and automated tests exercise the handler with
 * an explicit `intakeBaseUrl` (or a stub env), so nothing uploads to production
 * without a person clicking Send. An empty / whitespace env value is treated as
 * unset. To keep a dev machine off the production intake, point the env at a
 * local stub.
 */
export function resolveBugReportIntakeUrl(args: { envUrl: string | undefined }): string {
  const trimmed = args.envUrl?.trim();
  return trimmed !== undefined && trimmed !== '' ? trimmed : DEFAULT_BUG_REPORT_INTAKE_URL;
}

export interface BugReportSendDeps {
  /**
   * Intake endpoint origin (e.g. `https://openknowledge.ai`). Wired from
   * `resolveBugReportIntakeUrl`, which always yields the env override or the
   * production default — so in production this is never absent. It stays
   * optional because the handler's email-draft path (`reason: 'email-draft'`, no
   * network attempted) is still reachable by a direct caller/test passing
   * `undefined`; the dialog renders that as the email flow, not a failure.
   */
  intakeBaseUrl: string | undefined;
  /** App version (`app.getVersion()`), stamped into the report metadata by main. */
  appVersion: string;
  /** Human-readable OS line (e.g. `darwin 25.4.0`), stamped by main. */
  platform: string;
  /**
   * Containment root for the renderer-supplied `zipPath` — the bug-reports
   * directory `create` writes into (main-derived, never renderer-influenced).
   * `send` both reads and transmits the file off-device, so it gets the same
   * renderer-path bound every sibling filesystem-touching channel enforces
   * (`showItemInFolder` allowedRoots, `spawnCursor`, `trashItem`).
   */
  bugReportsRoot: string;
  /** Transport-timeout overrides (test seam; defaults 30s mint/complete, 120s PUT). */
  timeouts?: Partial<BugReportUploadTimeouts>;
  /**
   * Sidecar-state hooks that record the `uploading` → `sent`/`upload-failed`/
   * `email-drafted` transition, append an attempt, and honor the in-flight lock.
   * Fires for BOTH the first dialog send and a later list retry (same handler).
   * Absent leaves the send behavior unchanged (unit tests that only exercise the
   * transport omit it).
   */
  sidecar?: BugReportSendSidecarHooks;
  /**
   * Main-owned PNG bytes of the screenshot captured when the report dialog
   * opened, uploaded as its own Linear asset so the ticket embeds it inline.
   * Returns null when nothing was captured, when the reporter opted out, or on a
   * list retry in a later session. Absent (or null) simply means the ticket files
   * without the inline image.
   */
  screenshotPngBytes?: () => Buffer | null;
}

/**
 * Per-step ceilings so a hung intake or storage endpoint cannot park the IPC
 * handler (and the in-memory zip bytes) forever — the dialog's Cancel only
 * abandons the renderer-side wait, never the main-side socket. The PUT gets
 * the long ceiling because it carries the whole bundle.
 */
interface BugReportUploadTimeouts {
  mintMs: number;
  putMs: number;
  completeMs: number;
}

const MINT_TIMEOUT_MS = 30_000;
const PUT_TIMEOUT_MS = 120_000;
const COMPLETE_TIMEOUT_MS = 30_000;

// The screenshot upload gets its own, much tighter ceilings rather than
// inheriting the bundle's. The bundle's 120s PUT allowance exists for a
// multi-megabyte zip on a bad connection; the screenshot is one PNG of one
// screen, and it is best-effort. Reusing 120s would mean a hung screenshot
// upload silently delays the user's report by two minutes to add a nicety, which
// inverts the priority. Give up quickly instead and file the report.
const SCREENSHOT_MINT_TIMEOUT_MS = 10_000;
const SCREENSHOT_PUT_TIMEOUT_MS = 20_000;

/**
 * Ceiling on the zip size `send` will buffer into main-process memory for the
 * PUT. Real bundles sit in the tens of MB (the log/span sinks are size-capped)
 * plus an optional minidump; 256 MiB refuses a pathological zip before the
 * read can exhaust the process, degrading to the email fallback instead.
 */
export const MAX_UPLOAD_ZIP_BYTES = 256 * 1024 * 1024;

/**
 * Hybrid retention caps for `~/.ok/bug-reports/`, co-located with the upload
 * ceiling because they bound the same on-disk report set. On a confirmed send
 * the zip is dropped (the sidecar tombstone stays); the remaining UNSENT
 * bundles are then bounded by a count cap and a total-size budget, and the
 * sent tombstones by their own count cap. Eviction never removes the newest
 * unsent bundle or a bundle whose send is in flight. Fixed constants
 * for v1 — `config.yml` exposure is Future Work.
 */
export const MAX_UNSENT_REPORT_COUNT = 10;
export const MAX_UNSENT_REPORT_BYTES = 1024 * 1024 * 1024;
export const MAX_SENT_TOMBSTONE_COUNT = 25;

/** Cap on the sidecar's per-report `attempts` history (newest kept). */
export const MAX_REPORT_ATTEMPTS = 10;

/**
 * Facts a successful `create` hands to the sidecar writer so it can persist the
 * report's initial `generated` record (and reconstruct a later retry's send
 * metadata without a second capture). Keyed to the returned `zipPath`, whose
 * basename becomes the report `id`.
 */
export interface GeneratedReportMeta {
  zipPath: string;
  zipBytes: number;
  level: ReportBundleLevel;
  systemWide: boolean;
  projectSlug: string | null;
}

/**
 * Terminal outcome of a send attempt, handed to the sidecar writer so it can
 * record the state transition and append an attempt. `email-drafted` is the
 * designed no-intake path (nothing uploaded), distinct from `upload-failed`.
 */
export type SidecarSendOutcome =
  | { kind: 'sent'; reference: string }
  | { kind: 'upload-failed'; reason: string; errorCode?: string }
  | { kind: 'email-drafted' };

/**
 * Sidecar-state hooks injected into `send` so the durable record tracks each
 * transition and the in-flight lock is honored — implemented by desktop main's
 * bug-report sidecar store, or a recording double in tests. `onSendStart` marks
 * the report `uploading` and acquires the in-flight lock, returning
 * `{ proceed: false }` when this report's send is already in flight (a second
 * concurrent retry). `onSendResult` records the terminal state, appends an
 * attempt, releases the lock, and runs retention. Only the actual-upload branch
 * calls `onSendStart`; every terminal branch (including email-draft) calls
 * `onSendResult`.
 */
export interface BugReportSendSidecarHooks {
  onSendStart(id: string): Promise<{ proceed: boolean }>;
  onSendResult(id: string, outcome: SidecarSendOutcome): Promise<void>;
}

/**
 * Admit a report-transport URL — the intake base or a minted upload URL —
 * only when transport-safe: `https:` anywhere, or plain `http:` strictly on
 * loopback hosts (local stubs and dev). Anything else would ship the report
 * bytes — possibly a memory-carrying minidump — in cleartext to a MITM-able
 * endpoint.
 *
 * Transport encryption is ALL this gate enforces. Any `https:` destination
 * passes, loopback / link-local / RFC-1918 literals included — there is no
 * internal-host (SSRF-style) filtering here, and none is claimed: the intake
 * base is operator config and the minted URL comes from that operator's
 * service, so destination trust rests with the config, not this parser.
 */
export function parseTransportSafeUrl(raw: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol === 'https:') return url;
  const loopback =
    url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  return url.protocol === 'http:' && loopback ? url : null;
}

function isSendRequest(request: unknown): request is OkBugReportSendRequest {
  if (typeof request !== 'object' || request === null) return false;
  const r = request as Record<string, unknown>;
  if (r.kind !== 'send' || typeof r.zipPath !== 'string') return false;
  if (r.includeScreenshot !== undefined && typeof r.includeScreenshot !== 'boolean') return false;
  if (r.traceparent !== undefined && typeof r.traceparent !== 'string') return false;
  if (typeof r.metadata !== 'object' || r.metadata === null) return false;
  const m = r.metadata as Record<string, unknown>;
  return (
    (m.level === 'standard' || m.level === 'full') &&
    typeof m.systemWide === 'boolean' &&
    (m.projectSlug === null || typeof m.projectSlug === 'string') &&
    isValidNote(m.note)
  );
}

/**
 * Prefilled draft to the support inbox: the note plus the system summary,
 * with the zip path so the user knows which file to attach — the draft never
 * inlines bundle contents. Total over partial input so the degenerate
 * invalid-request path still yields a working mailto.
 */
function buildBugReportMailto(args: {
  appVersion: string;
  platform: string;
  metadata?: OkBugReportSendMetadata;
  zipPath?: string;
}): string {
  const subject = `OpenKnowledge bug report (v${args.appVersion})`;
  const lines: string[] = [];
  if (args.metadata?.note) lines.push(args.metadata.note, '');
  if (args.zipPath) lines.push('Please attach the report file saved at:', args.zipPath, '');
  lines.push(`App version: ${args.appVersion}`, `Platform: ${args.platform}`);
  if (args.metadata) {
    const project =
      args.metadata.projectSlug ??
      (args.metadata.systemWide ? 'none (system-wide report)' : '(unnamed project)');
    lines.push(`Project: ${project}`, `Detail level: ${args.metadata.level}`);
  }
  const body = lines.join('\n');
  return `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

/** Metadata JSON as it crosses to the intake endpoint — renderer summary + host facts. */
interface BugReportWireMetadata extends OkBugReportSendMetadata {
  appVersion: string;
  platform: string;
}

interface BugReportMintResponse {
  uploadUrl: string;
  assetUrl: string;
  /** Signed-upload headers the PUT must carry verbatim. */
  headers: Record<string, string>;
}

/** Cross-network response bodies are untrusted bytes — re-parse before use. */
function parseMintResponse(payload: unknown): BugReportMintResponse | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const p = payload as Record<string, unknown>;
  if (typeof p.uploadUrl !== 'string' || typeof p.assetUrl !== 'string') return null;
  if (typeof p.headers !== 'object' || p.headers === null) return null;
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(p.headers)) {
    if (typeof value !== 'string') return null;
    headers[key] = value;
  }
  return { uploadUrl: p.uploadUrl, assetUrl: p.assetUrl, headers };
}

function parseCompletionReference(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const reference = (payload as Record<string, unknown>).reference;
  return typeof reference === 'string' && reference !== '' ? reference : null;
}

type BugReportUploadOutcome =
  | { ok: true; reference: string }
  | {
      ok: false;
      reason: string;
      cause?: unknown;
      /** Bounded transport facts for the log line — see `describeTransportFailure`. */
      details?: Readonly<Record<string, string | number | boolean>>;
    };

/** Transport steps inside a send, in the order `uploadBugReport` runs them. */
type BugReportSendStep = 'mint' | 'upload' | 'complete';

/**
 * Pull the transport errno out of a caught `fetch` rejection.
 *
 * undici reports every transport failure as the same opaque
 * `TypeError: fetch failed` and hangs the error that actually names the
 * problem — `ENOTFOUND`, `ECONNREFUSED`, `ECONNRESET`, `CERT_HAS_EXPIRED` —
 * one level down in `cause`. Reading `err.code` off the caught value
 * therefore yields nothing on precisely the failures worth triaging, which is
 * why this walks the chain instead of inspecting the top error.
 *
 * Depth- and cycle-bounded: `Error.cause` chains can be self-referential, and
 * an unguarded walk would stack-overflow inside a catch block whose whole job
 * is to keep the send's failure reportable (the hazard `normalizeCause` in
 * `ipc-log.ts` guards for the same reason).
 */
function transportErrorCode(err: unknown): string | undefined {
  const seen = new Set<unknown>();
  let cursor: unknown = err;
  for (let depth = 0; depth < 5 && cursor !== null && cursor !== undefined; depth += 1) {
    if (seen.has(cursor)) return undefined;
    seen.add(cursor);
    const code = (cursor as { code?: unknown }).code;
    if (typeof code === 'string' && code !== '') return code;
    cursor = (cursor as { cause?: unknown }).cause;
  }
  return undefined;
}

/** Origin host of a target, or undefined when it will not parse. */
function hostOf(target: URL | string | undefined): string | undefined {
  if (target === undefined) return undefined;
  try {
    return (typeof target === 'string' ? new URL(target) : target).host;
  } catch {
    return undefined;
  }
}

/**
 * Bounded facts about a failed transport step, for the structured log line.
 *
 * A failed send used to reach the log as the bare token `network-error`, which
 * cannot distinguish this machine's DNS being broken from the intake being
 * down from a TLS clock skew — so a report about a failed report was not
 * answerable from the bundle it shipped with. These are the four fields that
 * separate those cases.
 *
 * Every value is bounded by construction because this line is collected into
 * user-submitted diagnostic bundles. `host` is the ORIGIN HOST ONLY and that
 * restriction is load-bearing, not stylistic: the upload step targets a signed
 * URL whose path and query carry the signature, so logging the full URL would
 * write a live upload credential into a bundle the user hands to support.
 */
function describeTransportFailure(
  step: BugReportSendStep,
  target: URL | string | undefined,
  extras: { err?: unknown; status?: number } = {},
): Record<string, string | number | boolean> {
  const details: Record<string, string | number | boolean> = { step };
  const host = hostOf(target);
  if (host !== undefined) details.host = host;
  if (extras.status !== undefined) details.status = extras.status;
  if (extras.err instanceof Error) details.errName = extras.err.name;
  const code = transportErrorCode(extras.err);
  if (code !== undefined) details.errCode = code;
  return details;
}

/**
 * Trace a skipped screenshot and return null in one expression. Every exit from
 * `uploadScreenshotAsset` is a non-failure (the report still files), but it must
 * leave a trace: a screenshot that silently vanishes is indistinguishable from
 * one that was never requested, which is how the server-side predecessor stayed
 * broken unnoticed.
 */
function logScreenshotSkip(reason: string, cause?: unknown): null {
  logIpcError({
    event: 'ipc.error',
    channel: 'ok:bug-report:dispatch',
    reason: `screenshot-upload-skipped: ${reason}`,
    handler: 'uploadScreenshotAsset',
    ...(cause === undefined ? {} : { cause }),
  });
  return null;
}

/**
 * Mint + PUT the screenshot PNG as its own Linear asset and return the asset URL
 * for the ticket description to embed inline. Returns null on ANY failure and
 * never throws — the caller must be able to file the report regardless.
 *
 * Kept separate from the bundle upload so its failures cannot be confused with
 * the bundle's: a rejected screenshot mint must not surface as `mint-rejected`
 * and abandon a report whose bundle already landed.
 */
async function uploadScreenshotAsset(
  base: URL,
  screenshotBytes: Uint8Array,
  metadata: BugReportWireMetadata,
  timeouts?: Partial<BugReportUploadTimeouts>,
): Promise<string | null> {
  try {
    const mintRes = await fetch(new URL('/api/bug-report', base), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        filename: BUG_REPORT_SCREENSHOT_ZIP_NAME,
        sizeBytes: screenshotBytes.byteLength,
        contentType: 'image/png',
        metadata,
      }),
      redirect: 'manual',
      signal: AbortSignal.timeout(timeouts?.mintMs ?? SCREENSHOT_MINT_TIMEOUT_MS),
    });
    // A 400 here is the expected answer from an intake deployed before it learned
    // the image content type, so this is a normal outcome, not an error path.
    if (!mintRes.ok) return logScreenshotSkip(`mint responded ${mintRes.status}`);
    const mint = parseMintResponse(await mintRes.json().catch(() => null));
    if (mint === null) return logScreenshotSkip('mint response malformed');
    // Same transport gate the bundle's minted URL gets: a misconfigured or
    // compromised intake must not be able to downgrade this PUT to cleartext.
    if (parseTransportSafeUrl(mint.uploadUrl) === null) {
      return logScreenshotSkip('mint named a non-https upload URL');
    }

    // Re-pack into a plain ArrayBuffer-backed view: fetch's BodyInit typing
    // rejects the ArrayBufferLike backing a Buffer carries, same trap the bundle
    // PUT documents above.
    const body = new Uint8Array(screenshotBytes.byteLength);
    body.set(screenshotBytes);
    const putRes = await fetch(mint.uploadUrl, {
      method: 'PUT',
      headers: { 'content-type': 'image/png', ...mint.headers },
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(timeouts?.putMs ?? SCREENSHOT_PUT_TIMEOUT_MS),
    });
    if (
      putRes.type === 'opaqueredirect' ||
      putRes.status === 0 ||
      (putRes.status >= 300 && putRes.status < 400)
    ) {
      return logScreenshotSkip('upload redirected');
    }
    if (!putRes.ok) return logScreenshotSkip(`upload responded ${putRes.status}`);
    return mint.assetUrl;
  } catch (err) {
    // Offline, timeout, DNS — the bundle has already landed by this point, so the
    // only correct move is to carry on and file the report without the inline
    // image. Still traced: a silently dropped screenshot with no log line is the
    // exact failure mode that hid this feature being broken for two weeks.
    return logScreenshotSkip('transport error', err);
  }
}

/**
 * Two-step client upload (mint → direct PUT → completion), keeping the zip
 * bytes out of the intake function body: the endpoint mints a short-lived
 * signed upload URL, the client PUTs the bytes straight to storage with the
 * signed headers verbatim, then the completion call files the report and
 * returns its reference. The completion POST only fires after a successful
 * PUT — an accepted report always has its bundle attached.
 */
async function uploadBugReport(
  baseUrl: string,
  zipPath: string,
  metadata: BugReportWireMetadata,
  timeouts?: Partial<BugReportUploadTimeouts>,
  screenshotBytes?: Uint8Array | null,
  sendTrace?: BugReportSendTrace,
): Promise<BugReportUploadOutcome> {
  const base = parseTransportSafeUrl(baseUrl);
  if (base === null) {
    // The rejected value is operator config, never a user secret — logging
    // it is what makes a misconfigured intake diagnosable.
    return { ok: false, reason: 'intake-url-rejected', cause: `rejected intake URL: ${baseUrl}` };
  }
  // Re-packed as a plain Uint8Array — fetch's BodyInit typing rejects
  // Buffer's ArrayBufferLike backing.
  let zipBytes: Uint8Array<ArrayBuffer>;
  try {
    const { size } = await stat(zipPath);
    if (size > MAX_UPLOAD_ZIP_BYTES) {
      return {
        ok: false,
        reason: 'zip-oversize',
        cause: `zip is ${size} bytes (ceiling ${MAX_UPLOAD_ZIP_BYTES})`,
      };
    }
    const raw = await readFile(zipPath);
    zipBytes = new Uint8Array(raw.byteLength);
    zipBytes.set(raw);
  } catch (err) {
    return { ok: false, reason: 'zip-unreadable', cause: err };
  }
  let step: BugReportSendStep = 'mint';
  // The host the CURRENT step is talking to. Tracked separately from `base`
  // because the upload step moves to the minted signed URL, which routinely
  // lives on a different origin (an object store) than the intake — so a
  // failure that named `base` would point triage at the wrong service.
  const mintUrl = new URL('/api/bug-report', base);
  let stepTarget: URL | string = mintUrl;
  // Each step's span is closed right after its fetch settles, before the
  // status checks below — a rejected mint/upload/complete still shows how long
  // it took, which is the number you want when triaging a slow intake.
  let stepStartedAt = Date.now();
  try {
    const mintRes = await fetch(mintUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        filename: basename(zipPath),
        sizeBytes: zipBytes.byteLength,
        contentType: 'application/zip',
        metadata,
      }),
      redirect: 'manual',
      signal: AbortSignal.timeout(timeouts?.mintMs ?? MINT_TIMEOUT_MS),
    });
    // Closed the instant the fetch settles, BEFORE the status checks below,
    // matching upload and complete. Recording it after them would skip the
    // span on exactly the mint failures it exists to time.
    sendTrace?.phase(
      'mint',
      { 'http.response.status_code': mintRes.status },
      stepStartedAt,
      Date.now(),
    );
    if (!mintRes.ok)
      return {
        ok: false,
        reason: `mint-rejected: ${mintRes.status}`,
        details: describeTransportFailure(step, stepTarget, { status: mintRes.status }),
      };
    const mint = parseMintResponse(await mintRes.json().catch(() => null));
    if (mint === null)
      return {
        ok: false,
        reason: 'mint-malformed',
        details: describeTransportFailure(step, stepTarget, { status: mintRes.status }),
      };
    // The minted URL is the channel that carries the actual bundle bytes, so
    // it gets the same transport gate as the operator-configured base — a
    // misconfigured or compromised intake must not be able to downgrade the
    // PUT to cleartext. Encryption only: the gate does not restrict which
    // https host the mint may name.
    if (parseTransportSafeUrl(mint.uploadUrl) === null) {
      return {
        ok: false,
        reason: 'upload-url-rejected',
        cause: `rejected upload URL: ${mint.uploadUrl}`,
        // `stepTarget` is still the mint URL here: the minted one was refused,
        // so naming its host would point triage at a URL we declined to trust.
        details: describeTransportFailure(step, stepTarget, { status: mintRes.status }),
      };
    }

    step = 'upload';
    stepTarget = mint.uploadUrl;
    stepStartedAt = Date.now();
    const putRes = await fetch(mint.uploadUrl, {
      method: 'PUT',
      // Minted values win over the baseline content-type when they overlap —
      // the signed-URL contract requires its headers untransformed.
      headers: { 'content-type': 'application/zip', ...mint.headers },
      body: zipBytes,
      // Never chase a redirect with the signed request: following would
      // replay the signed headers and the bundle bytes to a location the
      // mint response didn't name.
      redirect: 'manual',
      signal: AbortSignal.timeout(timeouts?.putMs ?? PUT_TIMEOUT_MS),
    });
    sendTrace?.phase(
      'upload',
      { 'http.response.status_code': putRes.status },
      stepStartedAt,
      Date.now(),
    );

    // `redirect: 'manual'` surfaces the un-followed redirect either as the
    // raw 3xx or as an opaque-redirect response (status 0), depending on
    // runtime — classify both apart from an ordinary status rejection.
    if (
      putRes.type === 'opaqueredirect' ||
      putRes.status === 0 ||
      (putRes.status >= 300 && putRes.status < 400)
    ) {
      return {
        ok: false,
        reason: 'upload-redirected',
        details: describeTransportFailure(step, stepTarget, { status: putRes.status }),
      };
    }
    if (!putRes.ok)
      return {
        ok: false,
        reason: `upload-rejected: ${putRes.status}`,
        details: describeTransportFailure(step, stepTarget, { status: putRes.status }),
      };

    // Upload the screenshot as its own Linear asset so the ticket can embed it
    // inline. Deliberately client-side: the intake cannot read the bytes back out
    // of the bundle it just received, because Linear serves uploaded assets
    // behind authentication and the workspace API key does not authorize the raw
    // asset URL. Only this process, which holds the PNG before it zips it, can
    // supply them.
    //
    // Strictly best-effort and strictly after the bundle PUT: every failure path
    // yields null and the report files exactly as it does today. A screenshot is
    // never worth losing a report over.
    const screenshotAssetUrl =
      screenshotBytes === undefined || screenshotBytes === null
        ? null
        : await uploadScreenshotAsset(base, screenshotBytes, metadata, timeouts);

    step = 'complete';
    stepTarget = new URL('/api/bug-report/complete', base);
    stepStartedAt = Date.now();
    const completeRes = await fetch(stepTarget, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(
        // Omit the key entirely rather than sending null: the intake treats the
        // field as optional, and an older deployment that has not learned it yet
        // strips unknown keys instead of rejecting the body.
        screenshotAssetUrl === null
          ? { assetUrl: mint.assetUrl, metadata }
          : { assetUrl: mint.assetUrl, screenshotAssetUrl, metadata },
      ),
      redirect: 'manual',
      signal: AbortSignal.timeout(timeouts?.completeMs ?? COMPLETE_TIMEOUT_MS),
    });
    sendTrace?.phase(
      'complete',
      { 'http.response.status_code': completeRes.status },
      stepStartedAt,
      Date.now(),
    );
    if (!completeRes.ok)
      return {
        ok: false,
        reason: `complete-rejected: ${completeRes.status}`,
        details: describeTransportFailure(step, stepTarget, { status: completeRes.status }),
      };
    const reference = parseCompletionReference(await completeRes.json().catch(() => null));
    if (reference === null)
      return {
        ok: false,
        reason: 'complete-malformed',
        details: describeTransportFailure(step, stepTarget, { status: completeRes.status }),
      };
    return { ok: true, reference };
  } catch (err) {
    // Offline, DNS failure, refused connection — or a timeout ceiling firing
    // on a hung endpoint. `AbortError` is classified as a timeout alongside
    // `TimeoutError` because runtimes disagree on which name an
    // `AbortSignal.timeout()` abort carries; the flip side is that no
    // user-cancel AbortController may be wired to these fetches without
    // first splitting cancel out of this classification.
    //
    // Both branches name their leg, because the send is three requests across
    // two different hosts and "the intake is unreachable" and "the storage
    // bucket is unreachable" are different investigations with different
    // owners. The leg also rides `details`, but only the reason survives into
    // the durable per-report ledger and the history row, and the ledger is
    // what a reporter still has after the logs have rotated.
    const timedOut =
      err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return {
      ok: false,
      reason: `${step}-${timedOut ? 'timeout' : 'network-error'}`,
      cause: err,
      details: describeTransportFailure(step, stepTarget, { err }),
    };
  }
}

/**
 * Run a sidecar bookkeeping hook without letting it decide the send's outcome.
 *
 * Each hook catches internally and is documented never to throw, so a rejection
 * crossing back here is a contract violation rather than an expected path — but
 * swallowing it silently would be worse than the failure it hides. The
 * post-upload call is the sharp case: an escaped rejection there would skip the
 * `{ ok: true }` return, leave the in-flight lock held, and refuse every later
 * retry for the process lifetime. Bookkeeping must never cost the user a send
 * that already succeeded.
 */
async function runSidecarHook(hook: Promise<unknown> | undefined): Promise<void> {
  if (hook === undefined) return;
  try {
    await hook;
  } catch (err) {
    logIpcError({
      event: 'ipc.error',
      channel: 'ok:bug-report:dispatch',
      reason: 'sidecar-hook-error',
      handler: 'handleBugReportSend',
      cause: err,
    });
  }
}

/**
 * Upload the reviewed zip for the `send` operation. Never throws — every
 * non-success maps to the discriminated `{ok: false}` result whose fallback
 * mailto the dialog offers instead, with `reason: 'email-draft'` reserved for
 * the designed no-intake path (no network attempted, not a failure).
 */
export async function handleBugReportSend(
  deps: BugReportSendDeps,
  request: OkBugReportSendRequest,
): Promise<OkBugReportSendResult> {
  const hostFacts = { appVersion: deps.appVersion, platform: deps.platform };
  if (!isSendRequest(request)) {
    logIpcError({
      event: 'ipc.error',
      channel: 'ok:bug-report:dispatch',
      reason: 'invalid-request',
      handler: 'handleBugReportSend',
    });
    return {
      ok: false,
      reason: 'send-failed',
      fallback: { mailtoUrl: buildBugReportMailto(hostFacts) },
    };
  }
  // Basename shape is the same belt-and-suspenders gate `delete` applies via
  // `resolveContainedId`. Containment below is what actually holds, but
  // requiring the report-id shape on every renderer-id-driven file operation
  // keeps the invariant uniform across `send` and `delete` rather than leaving
  // `send` the one path where an arbitrary basename inside the directory is
  // admitted.
  if (!isReportIdShape(basename(request.zipPath))) {
    logIpcError({
      event: 'ipc.error',
      channel: 'ok:bug-report:dispatch',
      reason: 'zip-path-shape',
      handler: 'handleBugReportSend',
    });
    return {
      ok: false,
      reason: 'send-failed',
      fallback: { mailtoUrl: buildBugReportMailto(hostFacts) },
    };
  }
  // A compromised renderer must not be able to steer main into reading (and
  // uploading) arbitrary user-readable files: only zips inside the
  // main-owned bug-reports directory — the sole place `create` writes — may
  // leave the machine. Refused paths get the generic fallback so the
  // untrusted path is not echoed back into the email draft. The lexical
  // check is a cheap pre-filter; the canonical (realpath) check below is
  // what holds, because a symlink planted inside the root passes lexically
  // and the OS follows it at read time (same order as `trashItem`).
  if (!isPathWithinProject(request.zipPath, deps.bugReportsRoot, process.platform)) {
    logIpcError({
      event: 'ipc.error',
      channel: 'ok:bug-report:dispatch',
      reason: 'zip-path-escape',
      handler: 'handleBugReportSend',
    });
    return {
      ok: false,
      reason: 'send-failed',
      fallback: { mailtoUrl: buildBugReportMailto(hostFacts) },
    };
  }
  let canonicalZipPath: string;
  try {
    // The root canonicalizes alongside the zip so a symlinked ancestor of
    // the root itself (macOS `/var` → `/private/var`) can't read as escape.
    const canonicalRoot = await realpath(deps.bugReportsRoot);
    canonicalZipPath = await realpath(request.zipPath);
    if (!isPathWithinProject(canonicalZipPath, canonicalRoot, process.platform)) {
      logIpcError({
        event: 'ipc.error',
        channel: 'ok:bug-report:dispatch',
        reason: 'zip-path-escape',
        handler: 'handleBugReportSend',
      });
      return {
        ok: false,
        reason: 'send-failed',
        fallback: { mailtoUrl: buildBugReportMailto(hostFacts) },
      };
    }
  } catch (err) {
    // Realpath failure means the zip (or the root) is gone from disk — the
    // draft still helps, but there is no file to read or upload.
    logIpcError({
      event: 'ipc.error',
      channel: 'ok:bug-report:dispatch',
      reason: 'zip-unresolvable',
      handler: 'handleBugReportSend',
      cause: err,
    });
    return {
      ok: false,
      reason: 'send-failed',
      fallback: { mailtoUrl: buildBugReportMailto(hostFacts) },
    };
  }
  // The compose UI promises automatic secret redaction. The note inside the
  // zip is scrubbed by the bundle collector; these are the two copies that
  // travel OUTSIDE the zip (upload metadata JSON, mailto body), so they get
  // the same scrub. Only the note — the zipPath line must stay verbatim so
  // the user can find the file to attach.
  const scrubbedNote =
    request.metadata.note === undefined ? undefined : redactContent(request.metadata.note).redacted;
  const metadata: OkBugReportSendMetadata = {
    level: request.metadata.level,
    systemWide: request.metadata.systemWide,
    projectSlug: request.metadata.projectSlug,
    ...(scrubbedNote !== undefined ? { note: scrubbedNote } : {}),
  };
  const fallback = {
    mailtoUrl: buildBugReportMailto({
      ...hostFacts,
      metadata,
      zipPath: request.zipPath,
    }),
  };
  // The report id is the zip's basename — the sidecar key the state transitions
  // are recorded under, for both the first dialog send and a later list retry.
  const reportId = basename(request.zipPath);
  // One trace per send, opened before the first terminal branch so every
  // outcome below closes it exactly once. Concurrency safety lives in
  // `beginSendTrace`: the span roots at ROOT_CONTEXT, never the ambient async
  // context, so simultaneous sends cannot nest inside one another.
  const sendTrace = beginSendTrace(
    { 'ok.bug_report.include_screenshot': request.includeScreenshot === true },
    request.traceparent,
  );
  if (!deps.intakeBaseUrl) {
    // The designed default, not an error: no intake endpoint means the email
    // draft is the transport and no network request was ever attempted. The
    // distinct reason lets the dialog render an email flow, never a failure
    // screen. Still logged for observability of which path sends take.
    logIpcError({
      event: 'ipc.error',
      channel: 'ok:bug-report:dispatch',
      reason: 'intake-unconfigured',
      handler: 'handleBugReportSend',
    });
    await runSidecarHook(deps.sidecar?.onSendResult(reportId, { kind: 'email-drafted' }));
    sendTrace.end('email-drafted');
    return { ok: false, reason: 'email-draft', fallback };
  }
  if (deps.sidecar) {
    // Mark the report `uploading` and take the in-flight lock. A second retry
    // arriving while this send is in flight is refused here rather than
    // uploading the same bundle twice; the owning send records the terminal
    // state when it finishes.
    // A hook that rejects here leaves the lock state unknown. Proceed rather
    // than refuse: the user asked to send, and silently blocking every send on
    // a bookkeeping fault is a worse failure than the double-upload this gate
    // exists to prevent (which needs a genuinely concurrent retry to occur).
    let gate: { proceed: boolean } = { proceed: true };
    try {
      gate = await deps.sidecar.onSendStart(reportId);
    } catch (err) {
      logIpcError({
        event: 'ipc.error',
        channel: 'ok:bug-report:dispatch',
        reason: 'sidecar-hook-error',
        handler: 'handleBugReportSend',
        cause: err,
      });
    }
    if (!gate.proceed) {
      logIpcError({
        event: 'ipc.error',
        channel: 'ok:bug-report:dispatch',
        reason: 'send-in-flight',
        handler: 'handleBugReportSend',
      });
      sendTrace.end('send-in-flight');
      return { ok: false, reason: 'send-in-flight', fallback };
    }
  }
  // Consent gate first, bytes second. main holds the capture for this window
  // regardless of what the reporter chose, so reading it without checking
  // `includeScreenshot` would upload a screenshot the reporter declined. The flag
  // reflects the bundle's own inventory, so it is the same decision the reporter
  // reviewed. Absent (a list retry, or an older renderer) means no upload.
  const screenshotBytes =
    request.includeScreenshot === true ? (deps.screenshotPngBytes?.() ?? null) : null;
  if (request.includeScreenshot === true && screenshotBytes === null) {
    // Consent was given and the capture is gone — a list retry in a later session
    // is the ordinary cause. Distinct from consent being withheld, and traced for
    // the same reason every other skip is: a screenshot that vanishes silently is
    // indistinguishable from one that was never asked for.
    logScreenshotSkip('capture unavailable at send time');
  }

  const wireMetadata: BugReportWireMetadata = { ...metadata, ...hostFacts };
  const outcome = await uploadBugReport(
    deps.intakeBaseUrl,
    canonicalZipPath,
    wireMetadata,
    deps.timeouts,
    screenshotBytes,
    sendTrace,
  );
  if (outcome.ok) {
    await runSidecarHook(
      deps.sidecar?.onSendResult(reportId, { kind: 'sent', reference: outcome.reference }),
    );
    sendTrace.end('sent');
    return { ok: true, reference: outcome.reference };
  }
  logIpcError({
    event: 'ipc.error',
    channel: 'ok:bug-report:dispatch',
    reason: outcome.reason,
    handler: 'handleBugReportSend',
    cause: outcome.cause,
    // The bounded half reaches the pino file, which ships inside diagnostic
    // bundles — this is what makes a failed send answerable from a later
    // report rather than only from a terminal someone happened to be tailing.
    ...(outcome.details === undefined ? {} : { details: outcome.details }),
  });
  await runSidecarHook(
    deps.sidecar?.onSendResult(reportId, {
      kind: 'upload-failed',
      reason: outcome.reason,
      // The errno, and only the errno: the ledger outlives the log, so it is
      // worth carrying, and it is bounded enough to sit in a file the reporter
      // can read and forwards to support. The message and stack are not.
      ...(typeof outcome.details?.errCode === 'string'
        ? { errorCode: outcome.details.errCode }
        : {}),
    }),
  );
  sendTrace.end('upload-failed');
  return { ok: false, reason: 'send-failed', fallback };
}

export interface BugReportCrashAckDeps {
  /** Crash-detection persistence — records the id so the event never re-prompts. */
  ackCrashEvent(eventId: string): void;
}

function isCrashAckRequest(request: unknown): request is OkBugReportCrashAckRequest {
  if (typeof request !== 'object' || request === null) return false;
  const r = request as Record<string, unknown>;
  return r.kind === 'crash-ack' && typeof r.eventId === 'string' && r.eventId !== '';
}

/**
 * Acknowledge a crash-detected invitation for the `crash-ack` operation.
 * Malformed renderer input must never touch the acknowledgment store — the
 * validator gates the only mutation.
 */
export function handleBugReportCrashAck(
  deps: BugReportCrashAckDeps,
  request: OkBugReportCrashAckRequest,
): OkBugReportCrashAckResult {
  if (!isCrashAckRequest(request)) {
    logIpcError({
      event: 'ipc.error',
      channel: 'ok:bug-report:dispatch',
      reason: 'invalid-request',
      handler: 'handleBugReportCrashAck',
    });
    return { ok: false, error: 'invalid-request' };
  }
  deps.ackCrashEvent(request.eventId);
  return { ok: true };
}

/**
 * Answer the `crash-dump-availability` probe for a manually-opened report.
 *
 * Runs the same ownership walk `create` would, so a "yes" here means the very
 * dump a later opt-in will attach — the checkbox cannot appear over a dump
 * that turns out to be foreign or unreadable. A lookup that is absent (no
 * crash detection wired) answers "no" rather than throwing: the probe governs
 * whether an option is offered, and a failure to answer must lose the option,
 * never the report.
 */
export function handleBugReportCrashDumpAvailability(deps: {
  newestMinidumpForReport?: () => MinidumpReportLookup;
  logger?: BundleLogger;
}): OkBugReportCrashDumpAvailability {
  try {
    return { available: (deps.newestMinidumpForReport?.() ?? NO_MINIDUMP_LOOKUP).path !== null };
  } catch (err) {
    // A walk that keeps throwing presents to the reporter as "no dump on
    // disk", which is the exact symptom the probe exists to end, so the
    // failure has to be distinguishable from a genuinely empty crash database.
    recordMinidumpDecision(
      deps.logger,
      'warn',
      { event: 'bug-report.crash-dump-availability-failed', err },
      'crash-dump availability lookup failed; offering no dump',
    );
    return { available: false };
  }
}

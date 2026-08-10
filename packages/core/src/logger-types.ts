import type { ReportSidecarState } from './bug-report-sidecar/schema.ts';

export type Loggable =
  | string
  | number
  | boolean
  | null
  | undefined
  | Loggable[]
  | { [key: string]: Loggable };

export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug';

export const LOG_LEVELS = [
  'fatal',
  'error',
  'warn',
  'info',
  'debug',
] as const satisfies readonly LogLevel[];

export interface SerializedError {
  readonly name: string;
  readonly message: string;
  readonly stack?: string;
  readonly code?: string;
  readonly cause?: SerializedError | SerializedErrorTruncation;
}

export interface SerializedErrorTruncation {
  readonly name: 'SerializedError.CauseDepthExceeded' | 'SerializedError.CauseCycle';
  readonly message: string;
}

export type ClassifiedPath = string & { readonly __brand: 'ClassifiedPath' };

export interface LogPayload {
  readonly [key: string]: Loggable;
}

export interface BundleRedaction {
  readonly file: string;
  readonly lineCount: number;
  readonly patterns: string[];
}

export interface BundleManifest {
  readonly generatedAt: string;
  readonly disciplineVersion: string;
  readonly projectSlug: string | null;
  readonly files: string[];
  readonly redactions: BundleRedaction[];
  readonly sysinfo: Record<string, Loggable>;
}

/**
 * Detail level for a bug-report bundle: `standard` is the `ok bug-report`
 * content set (logs + lock/spawn-error + local sink logs + sysinfo); `full`
 * is the diagnose superset (adds telemetry, server state, runtime metadata),
 * availability-gated by what exists at capture time.
 *
 * Lives in core (not the CLI package that implements the capture) so the
 * dedicated desktop-bridge leaf and the CLI implementation can share the type
 * without making the renderer depend on the CLI package.
 */
export type ReportBundleLevel = 'standard' | 'full';

/** Summary of a collected bug-report bundle, mirroring its bundled manifest. */
export interface ReportBundleSummary {
  level: ReportBundleLevel;
  /** True when no project was in scope — the bundle carries user-level logs + sysinfo only. */
  systemWide: boolean;
  projectSlug: string | null;
  /** Zip entry names of the captured content files (mirrors the bundled manifest inventory). */
  files: string[];
  /** Per-file secret-scrub audit (empty when redaction was off or nothing matched). */
  redactions: BundleRedaction[];
  /** Total lines scrubbed across all files. */
  redactedLineCount: number;
  generatedAt: string;
}

/**
 * Zip name of the opted-in app screenshot inside a bug-report bundle, and its
 * full entry path once the bundle collector prefixes every `extraFiles` entry
 * with `extra/`. Named here so main (which stages the screenshot) and the
 * renderer (which must tell a screenshot apart from the raw crash dump in the
 * review card's `summary.files` inventory) agree on the exact string.
 */
export const BUG_REPORT_SCREENSHOT_ZIP_NAME = 'screenshot.png';
export const BUG_REPORT_SCREENSHOT_ZIP_ENTRY = `extra/${BUG_REPORT_SCREENSHOT_ZIP_NAME}`;

/**
 * A captured picture of the app window handed to the renderer for the report
 * dialog's include-a-screenshot preview. `dataUrl` is a downscaled PNG for the
 * `<img>` preview only; the full-resolution bytes stay in main and are staged
 * into the bundle only when the user keeps the screenshot checked. `width` /
 * `height` are the capture's logical (DIP) dimensions, so the preview can hold
 * the real aspect ratio without a layout shift.
 */
export interface OkBugReportScreenshot {
  dataUrl: string;
  width: number;
  height: number;
}

/**
 * Result of the desktop `ok:bug-report:dispatch` create operation. Never
 * thrown across the IPC boundary — every failure mode is discriminated so the
 * report dialog can render its failure state.
 */
export type OkBugReportCreateResult =
  | {
      ok: true;
      zipPath: string;
      /**
       * On-disk size of the produced zip. Carried on the result rather than
       * the summary because the summary mirrors the bundled manifest, which
       * cannot know the final size of the archive that contains it.
       */
      zipSizeBytes: number;
      summary: ReportBundleSummary;
    }
  | { ok: false; error: string };

/**
 * Report metadata the renderer supplies with a send operation — the user's
 * note plus the system summary the preceding create yielded. Main enriches
 * it with host facts (app version, platform) before it reaches the intake
 * wire or the fallback email body; the renderer never sources those.
 */
export interface OkBugReportSendMetadata {
  level: ReportBundleLevel;
  /** True when the bundle was system-wide (no project open at capture). */
  systemWide: boolean;
  projectSlug: string | null;
  note?: string;
}

/**
 * Why a send operation resolved to the email fallback instead of an upload
 * reference. `email-draft` is the designed default, not a failure: no intake
 * endpoint is configured, no network request was made, and the prefilled
 * draft IS the transport — the dialog shows an email flow, not an error.
 * `send-failed` covers real failures: a configured upload that was attempted
 * and refused (offline, timeout, rejection at any step), or a request the
 * handler refused outright (malformed payload, zip outside the bug-reports
 * root).
 */
export type OkBugReportSendFallbackReason = 'email-draft' | 'send-failed';

/**
 * Result of the desktop `ok:bug-report:dispatch` send operation. Success
 * carries the intake service's report reference. Everything else resolves to
 * the email fallback — a prefilled mailto the dialog offers in place of the
 * upload — with `reason` discriminating the designed no-intake email path
 * from a genuine send failure. Never thrown across the IPC boundary.
 */
export type OkBugReportSendResult =
  | { ok: true; reference: string }
  | { ok: false; reason: OkBugReportSendFallbackReason; fallback: { mailtoUrl: string } };

/**
 * A crash signal detected by desktop main, pushed to the renderer over the
 * `ok:bug-report:crash-detected` event channel as an invitation to file a
 * report — never an automatic send. `eventId` keys the acknowledgment
 * round-trip: the renderer acks over `ok:bug-report:dispatch`
 * (`kind: 'crash-ack'`) and main persists the id so one crash event never
 * prompts twice, across restarts included.
 *
 * Lives in core for the same reason as the sibling bug-report types: the
 * desktop-bridge leaf and the capture implementation must share one type.
 *
 * `minidumpAvailable` is main's authoritative answer (only main can stat the
 * crash-dumps dir) to "is there a crash minidump to include for this event?".
 * The report dialog renders the crash-dump opt-in only when it is true — an
 * invite with no dump (e.g. a dirty shutdown that left none) offers no dead
 * checkbox. Advisory for UI gating only: the actual attach still re-checks the
 * dump on disk at bundle time, so a dump that vanished by then is simply
 * omitted.
 */
export type OkBugReportCrashDetectedEvent =
  | {
      eventId: string;
      kind: 'render-process-gone';
      context: { reason: string; exitCode?: number };
      minidumpAvailable: boolean;
    }
  | {
      eventId: string;
      kind: 'child-process-gone';
      context: { reason: string; processType: string; name?: string; exitCode?: number };
      minidumpAvailable: boolean;
    }
  | {
      eventId: string;
      /** Boot-time detection: the previous session left a dirty-shutdown sentinel or fresh minidumps. */
      kind: 'boot';
      context: { dirtyShutdown: boolean; newMinidumps: number };
      minidumpAvailable: boolean;
      /**
       * App version of the session that CRASHED, which is not the version now
       * running whenever an auto-update landed between the crash and this
       * launch. Absent when neither the crashed session's sentinel nor the
       * minidump's own annotations name one — an unknown version is reported
       * as unknown rather than approximated by the running one.
       *
       * Only the boot variant carries it. The two runtime variants are raised
       * by the very session that crashed, so their crashed version is the
       * running version by construction and a field would be pure restatement.
       */
      crashedAppVersion?: string;
    };

/**
 * Result of the desktop `ok:bug-report:dispatch` crash-ack operation. Never
 * thrown across the IPC boundary; the only failure mode is a malformed
 * renderer payload.
 */
export type OkBugReportCrashAckResult = { ok: true } | { ok: false; error: string };

/**
 * Whether main is holding a crash dump a report opened right now could carry.
 *
 * Deliberately a bare boolean: which dump, when it was written, and how big it
 * is are all per-crash identifiers, and the renderer only needs to decide
 * whether to render the opt-in.
 */
export interface OkBugReportCrashDumpAvailability {
  available: boolean;
}

/**
 * One row in the persisted bug-report history, projected from a report sidecar
 * plus main-derived facts. `state` is the OPEN sidecar state (`'unknown'` for a
 * degraded/legacy/corrupt row). `zipPath` is main-derived (never renderer
 * influenced) and re-validated for containment before any retry/reveal; the
 * renderer passes it straight back to `send` / reveal without composing a path.
 *
 * `systemWide` / `projectSlug` are carried so a retry reconstructs the exact
 * `OkBugReportSendMetadata` without a second capture. `retryable` is
 * `true` only when the report is neither `sent` nor mid-`uploading` and its zip
 * is still on disk. `degraded` is `true` for a synthesized row (no sidecar, a
 * corrupt sidecar, or an unknown state) so the list can render it plainly
 * instead of failing.
 */
export interface OkBugReportListRow {
  id: string;
  createdAt: string;
  bundleLevel: ReportBundleLevel | 'unknown';
  /**
   * Derived from the sidecar's single-source state list, so a state added to
   * `REPORT_SIDECAR_STATES` propagates here instead of silently drifting.
   */
  state: ReportSidecarState;
  zipBytes: number;
  zipDeleted: boolean;
  zipExists: boolean;
  systemWide: boolean;
  projectSlug: string | null;
  /**
   * State-coupled: present only when `state === 'sent'`. Not modelled as a
   * discriminated union because `state` is an OPEN enum — enumerating arms
   * here would reintroduce the drift that deriving `state` removes.
   */
  reference?: string;
  /** State-coupled: present only when `state === 'upload-failed'`. */
  lastError?: { reason: string; at: string };
  attemptsCount: number;
  note?: string;
  /** Main-derived absolute zip path; re-validated for containment on use. */
  zipPath: string;
  retryable: boolean;
  degraded: boolean;
}

/**
 * Result of the desktop `ok:bug-report:dispatch` list operation — the persisted
 * report history, newest first. Never thrown across the IPC boundary; a scan
 * failure resolves to `{ ok: false }` so the list renders an error state.
 */
export type OkBugReportListResult =
  | { ok: true; reports: OkBugReportListRow[] }
  | { ok: false; reason: string };

/**
 * Result of the desktop `ok:bug-report:dispatch` delete operation. Removes a
 * report's zip and sidecar by `id` after a containment + id-shape check. Never
 * thrown across the IPC boundary.
 *   - `id-invalid`  — the id failed the timestamp-basename shape / containment gate.
 *   - `in-flight`   — the report's own send is currently in progress in this process.
 *   - `not-found`   — no zip and no sidecar for the id.
 *   - `io-error`    — a filesystem removal failed.
 */
export type OkBugReportDeleteResult =
  | { ok: true }
  | { ok: false; reason: 'id-invalid' | 'in-flight' | 'not-found' | 'io-error' };

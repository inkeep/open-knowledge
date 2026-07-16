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
 * desktop bridge contract's three per-package copies can all name the same
 * type — the app renderer and core cannot depend on the CLI package.
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
 * desktop bridge contract's per-package copies must all name one type.
 */
export type OkBugReportCrashDetectedEvent =
  | {
      eventId: string;
      kind: 'render-process-gone';
      context: { reason: string; exitCode?: number };
    }
  | {
      eventId: string;
      kind: 'child-process-gone';
      context: { reason: string; processType: string; name?: string; exitCode?: number };
    }
  | {
      eventId: string;
      /** Boot-time detection: the previous session left a dirty-shutdown sentinel or fresh minidumps. */
      kind: 'boot';
      context: { dirtyShutdown: boolean; newMinidumps: number };
    };

/**
 * Result of the desktop `ok:bug-report:dispatch` crash-ack operation. Never
 * thrown across the IPC boundary; the only failure mode is a malformed
 * renderer payload.
 */
export type OkBugReportCrashAckResult = { ok: true } | { ok: false; error: string };

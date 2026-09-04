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

export type ReportBundleLevel = 'standard' | 'full';

export interface ReportBundleSummary {
  level: ReportBundleLevel;
  systemWide: boolean;
  projectSlug: string | null;
  files: string[];
  redactions: BundleRedaction[];
  redactedLineCount: number;
  generatedAt: string;
}

export const BUG_REPORT_SCREENSHOT_ZIP_NAME = 'screenshot.png';
export const BUG_REPORT_SCREENSHOT_ZIP_ENTRY = `extra/${BUG_REPORT_SCREENSHOT_ZIP_NAME}`;

export interface OkBugReportScreenshot {
  dataUrl: string;
  width: number;
  height: number;
}

export type OkBugReportCreateResult =
  | {
      ok: true;
      zipPath: string;
      zipSizeBytes: number;
      summary: ReportBundleSummary;
    }
  | { ok: false; error: string };

export interface OkBugReportSendMetadata {
  level: ReportBundleLevel;
  systemWide: boolean;
  projectSlug: string | null;
  note?: string;
}

export type OkBugReportSendFallbackReason = 'email-draft' | 'send-failed' | 'send-in-flight';

export type OkBugReportSendResult =
  | { ok: true; reference: string }
  | { ok: false; reason: OkBugReportSendFallbackReason; fallback: { mailtoUrl: string } };

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
      kind: 'boot';
      context: { dirtyShutdown: boolean; newMinidumps: number };
      minidumpAvailable: boolean;
      crashedAppVersion?: string;
    };

export type OkBugReportCrashAckResult = { ok: true } | { ok: false; error: string };

export interface OkBugReportCrashDumpAvailability {
  available: boolean;
}

export interface OkBugReportListRow {
  id: string;
  createdAt: string;
  bundleLevel: ReportBundleLevel | 'unknown';
  state: ReportSidecarState;
  zipBytes: number;
  zipDeleted: boolean;
  zipExists: boolean;
  systemWide: boolean;
  projectSlug: string | null;
  reference?: string;
  lastError?: { reason: string; at: string };
  attemptsCount: number;
  note?: string;
  zipPath: string;
  retryable: boolean;
  degraded: boolean;
}

export type OkBugReportListResult =
  | { ok: true; reports: OkBugReportListRow[] }
  | { ok: false; reason: string };

export type OkBugReportDeleteResult =
  | { ok: true }
  | { ok: false; reason: 'id-invalid' | 'in-flight' | 'not-found' | 'io-error' };

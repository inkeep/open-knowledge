import { z } from 'zod';

export const REPORT_SIDECAR_SCHEMA_VERSION = 1;

export const REPORT_SIDECAR_BUNDLE_DIR = 'state/bug-reports';

export const REPORT_SIDECAR_STATES = [
  'generated',
  'uploading',
  'sent',
  'upload-failed',
  'email-drafted',
] as const;

export type ReportSidecarKnownState = (typeof REPORT_SIDECAR_STATES)[number];

export type ReportSidecarState = ReportSidecarKnownState | 'unknown';

export function isKnownReportSidecarState(value: string): value is ReportSidecarKnownState {
  return (REPORT_SIDECAR_STATES as readonly string[]).includes(value);
}

export const REPORT_ID_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-bugreport(?:-\d+)?\.zip$/;

export function isReportIdShape(id: string): boolean {
  return REPORT_ID_PATTERN.test(id);
}

export function normalizeReportSidecarState(value: string): ReportSidecarState {
  return isKnownReportSidecarState(value) ? value : 'unknown';
}

const AttemptSchema = z.looseObject({
  at: z.string(),
  transport: z.string(),
  outcome: z.string(),
  reference: z.string().optional(),
  error: z.string().optional(),
  errorCode: z.string().optional(),
});

export type ReportSidecarAttempt = z.infer<typeof AttemptSchema>;

const LastErrorSchema = z.looseObject({
  reason: z.string(),
  at: z.string(),
  errorCode: z.string().optional(),
});

export const ReportSidecarSchema = z.looseObject({
  version: z.number().int().catch(REPORT_SIDECAR_SCHEMA_VERSION),
  id: z.string(),
  createdAt: z.string(),
  bundleLevel: z.string(),
  zipBytes: z.number().int().nonnegative().catch(0),
  zipDeleted: z.boolean().optional(),
  state: z.string(),
  systemWide: z.boolean().optional(),
  projectSlug: z.string().nullable().optional(),
  reference: z.string().optional(),
  lastError: LastErrorSchema.optional(),
  attempts: z.array(AttemptSchema).optional(),
  note: z.string().optional(),
});

export type ReportSidecar = z.infer<typeof ReportSidecarSchema>;

export const REPORT_SENT_MARKER_SUFFIX = '.sent.yaml';

export const REPORT_SENT_MARKER_SCHEMA_VERSION = 1;

export const ReportSentMarkerSchema = z.looseObject({
  version: z.number().int().catch(REPORT_SENT_MARKER_SCHEMA_VERSION),
  id: z.string().optional(),
  sentAt: z.string().optional(),
  reference: z.string().optional(),
});

export type ReportSentMarker = z.infer<typeof ReportSentMarkerSchema>;

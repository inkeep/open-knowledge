/**
 * Zod schema for a bug-report sidecar — one small YAML file per generated
 * report, written next to its zip in `~/.ok/bug-reports/` (same basename,
 * `.yaml`). It records the report's last-known send state so the history list
 * can show, retry, and clean up prior reports across dialog close and app
 * restart. The zip is the payload; the sidecar is the durable record.
 *
 * Boundary class: a machine-written, machine-read, durable on-disk format that
 * must evolve gracefully. The pressures (per typescript-api-design):
 *   - additive evolution — a `version` field, an OPEN `state`, all new fields
 *     optional, so a newer app's sidecar never crashes an older app and vice
 *     versa;
 *   - one schema is the single source of truth for both the type and the
 *     validator;
 *   - forgiving reads — a pre-feature zip has no sidecar, and a corrupt or
 *     newer sidecar must degrade to a placeholder row, never break the list.
 *
 * The state machine is enforced by the WRITER (desktop main), not by this
 * schema: `state` is a plain string here so an unknown value read from a newer
 * app normalizes to `'unknown'` rather than rejecting the file (an anti-pattern
 * "closed response enum" would). `version` is `.catch`-guarded for the same
 * reason — a malformed version never rejects the whole file.
 *
 * Reuses the same YAML-write + Zod idioms as `skill-state/schema.ts`, but its
 * reader synthesizes a degraded row on parse failure instead of dropping the
 * file.
 */

import { z } from 'zod';

/**
 * Schema major version. Bump only on a breaking shape change, paired with a
 * one-shot migrator; additive changes (new optional fields, new `state` values)
 * stay at v1 and read best-effort on older apps.
 */
export const REPORT_SIDECAR_SCHEMA_VERSION = 1;

/**
 * Where sidecars land inside a diagnostic bundle, at every bundle level.
 *
 * Shared rather than spelled at each staging site because the two bundle
 * assemblers (the standard zip builder and the full-level staging collector)
 * are independent code paths, and a triager reading a bundle should not have to
 * know which one produced it to know where to look.
 *
 * The sidecars are staged; the zips beside them are not. A bundle must not
 * contain other bundles.
 */
export const REPORT_SIDECAR_BUNDLE_DIR = 'state/bug-reports';

/**
 * Known report lifecycle states. Read as an OPEN enum: an unrecognized value
 * (a newer app wrote a state this build doesn't know) normalizes to `'unknown'`
 * rather than rejecting the sidecar. Transitions:
 *   generated → uploading → sent (+reference) | upload-failed (+lastError) | email-drafted
 * A retry moves a non-`sent` report back to `uploading` and on to a terminal
 * state again.
 */
export const REPORT_SIDECAR_STATES = [
  'generated',
  'uploading',
  'sent',
  'upload-failed',
  'email-drafted',
] as const;

export type ReportSidecarKnownState = (typeof REPORT_SIDECAR_STATES)[number];

/** The known states plus the `'unknown'` sentinel a read may normalize to. */
export type ReportSidecarState = ReportSidecarKnownState | 'unknown';

/** Whether `value` is one of the writer's known states. */
export function isKnownReportSidecarState(value: string): value is ReportSidecarKnownState {
  return (REPORT_SIDECAR_STATES as readonly string[]).includes(value);
}

/**
 * The timestamp-basename shape a report `id` must match — the zip basename
 * `defaultBugReportZipPath` produces (`<iso-with-dashes>-bugreport[.-N].zip`).
 * A renderer-supplied `id` is checked against this BEFORE any file operation,
 * a belt-and-suspenders complement to the bug-reports-dir containment check:
 * it admits no path separators or parent tokens, so a matching id is always a
 * single basename inside the reports directory.
 */
export const REPORT_ID_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-bugreport(?:-\d+)?\.zip$/;

/** Whether `id` matches the report timestamp-basename shape. */
export function isReportIdShape(id: string): boolean {
  return REPORT_ID_PATTERN.test(id);
}

/**
 * Normalize a raw `state` string to a known state or the `'unknown'` sentinel.
 * A newer app can write a state this build predates; the list renders it as a
 * degraded "unknown" row instead of crashing.
 */
export function normalizeReportSidecarState(value: string): ReportSidecarState {
  return isKnownReportSidecarState(value) ? value : 'unknown';
}

/**
 * One send attempt in the bounded `attempts` history. `transport` / `outcome`
 * are open strings (forward-compat) even though the writer only emits the
 * documented values.
 */
const AttemptSchema = z.looseObject({
  /** ISO-8601 timestamp of the attempt. */
  at: z.string(),
  /** `'upload'` (network) or `'email'` (the no-intake draft path). */
  transport: z.string(),
  /** `'success'` or `'failed'`. */
  outcome: z.string(),
  /** Intake reference when the attempt succeeded via upload. */
  reference: z.string().optional(),
  /** Short failure reason when the attempt failed. */
  error: z.string().optional(),
  /**
   * The errno behind the failure, when the transport reported one. Bounded by
   * the platform's errno table, so it is safe to persist into a file that ships
   * inside a diagnostic bundle — unlike the error's message, which carries the
   * host or path it failed on.
   */
  errorCode: z.string().optional(),
});

export type ReportSidecarAttempt = z.infer<typeof AttemptSchema>;

const LastErrorSchema = z.looseObject({
  reason: z.string(),
  at: z.string(),
  /** The errno behind the failure, when the transport reported one. */
  errorCode: z.string().optional(),
});

/**
 * The sidecar document. `looseObject` everywhere so a newer app's extra keys
 * pass through untouched on an older reader. `version` and `zipBytes` are
 * `.catch`-guarded so a malformed numeric field degrades to a default rather
 * than rejecting the whole file. `id` and `createdAt` are required — a sidecar
 * missing them fails validation and the reader synthesizes a degraded row from
 * the filename instead.
 */
export const ReportSidecarSchema = z.looseObject({
  version: z.number().int().catch(REPORT_SIDECAR_SCHEMA_VERSION),
  /** Stable key: the report's zip basename (also the sidecar's basename). */
  id: z.string(),
  /** ISO-8601 generation time. */
  createdAt: z.string(),
  /** `'standard' | 'full'` — open string so a future level still reads. */
  bundleLevel: z.string(),
  /** On-disk zip size at generation, for the list and retention budgeting. */
  zipBytes: z.number().int().nonnegative().catch(0),
  /** True once retention reclaimed the zip on a confirmed send (a tombstone). */
  zipDeleted: z.boolean().optional(),
  /** Last-known state — OPEN (see `normalizeReportSidecarState`). */
  state: z.string(),
  /** True when no project was open at capture (bundle was system-wide). Send-metadata reconstruction for retry. */
  systemWide: z.boolean().optional(),
  /** Project slug at capture, `null` for system-wide. Send-metadata reconstruction for retry. */
  projectSlug: z.string().nullable().optional(),
  /** Intake reference — present when `state === 'sent'`. */
  reference: z.string().optional(),
  /** Present when `state === 'upload-failed'`. */
  lastError: LastErrorSchema.optional(),
  /** Bounded attempt history (capped by the writer). */
  attempts: z.array(AttemptSchema).optional(),
  /** Short redacted note carried for list context. */
  note: z.string().optional(),
});

export type ReportSidecar = z.infer<typeof ReportSidecarSchema>;

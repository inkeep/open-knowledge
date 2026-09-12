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
  BUG_REPORT_ATTACHMENT_CONTENT_TYPES,
  BUG_REPORT_ATTACHMENT_EXTENSIONS,
  BUG_REPORT_ATTACHMENTS_ZIP_DIR,
  BUG_REPORT_CONTACT_EMAIL_MAX_LENGTH,
  BUG_REPORT_SCREENSHOT_ZIP_NAME,
  clampToCodeUnits,
  isBlankNoteContent,
  isReportIdShape,
  MAX_BUG_REPORT_ATTACHMENTS,
  MAX_BUG_REPORT_ATTACHMENTS_TOTAL_BYTES,
  type OkBugReportCrashAckResult,
  type OkBugReportCrashDumpAvailability,
  type OkBugReportCreateResult,
  type OkBugReportScreenshot,
  type OkBugReportSendMetadata,
  type OkBugReportSendResult,
  type OkImageAttachmentContentType,
  type ReportBundleLevel,
} from '@inkeep/open-knowledge-core';
import type {
  OkBugReportAttachmentInput,
  OkBugReportSendInput,
} from '@inkeep/open-knowledge-core/desktop-bridge';
import { type BugReportSendTrace, beginSendTrace } from '../bug-report-trace.ts';
import type { MinidumpReportLookup } from '../crash-detection.ts';
import { logIpcError } from '../ipc-log.ts';
import {
  readMinidumpAccessibilityMode,
  readMinidumpDisplayLockState,
} from '../minidump-ownership.ts';
import { isPathWithinProject } from '../path-containment.ts';
import type { UpdateChannel } from '../state-store.ts';

export interface OkBugReportCreateRequest {
  kind: 'create';
  level: ReportBundleLevel;
  note?: string;
  includeCrashDump?: boolean;
  includeScreenshot?: boolean;
  attachments?: OkBugReportAttachmentInput[];
}

interface OkBugReportCaptureScreenshotRequest {
  kind: 'capture-screenshot';
}

interface OkBugReportListRequest {
  kind: 'list';
}

interface OkBugReportDeleteRequest {
  kind: 'delete';
  id: string;
}

export type OkBugReportSendRequest = OkBugReportSendInput & { kind: 'send' };

export interface OkBugReportCrashAckRequest {
  kind: 'crash-ack';
  eventId: string;
}

interface OkBugReportCrashDumpAvailabilityRequest {
  kind: 'crash-dump-availability';
}

export interface OkAssetUploadRequestMessage {
  kind: 'upload-image';
  contentType: OkImageAttachmentContentType;
  bytes: Uint8Array;
  filename: string;
}

export type OkBugReportRequest =
  | OkBugReportCreateRequest
  | OkAssetUploadRequestMessage
  | OkBugReportSendRequest
  | OkBugReportCrashAckRequest
  | OkBugReportCaptureScreenshotRequest
  | OkBugReportCrashDumpAvailabilityRequest
  | OkBugReportListRequest
  | OkBugReportDeleteRequest;

interface BugReportDesktopMeta {
  version: string;
  packaged: boolean;
  channel: UpdateChannel;
}

export interface BugReportCreateDeps {
  projectDir: string | null;
  desktopMeta: BugReportDesktopMeta;
  readLanguage?: () => LanguageMetadata;
  outputPath?: string;
  userLogsDir?: string;
  newestMinidumpForReport?: () => MinidumpReportLookup;
  screenshotPngBytes?: () => Buffer | null;
  logger?: BundleLogger;
  flushLogger?: () => void;
  onReportGenerated?: (meta: GeneratedReportMeta) => Promise<void>;
  onScreenshotStaged?: (reportId: string, png: Buffer) => void;
  onAttachmentsStaged?: (reportId: string, attachments: readonly StagedAttachment[]) => void;
}

export interface StagedAttachment {
  contentType: OkImageAttachmentContentType;
  bytes: Buffer;
}

const MAX_NOTE_LENGTH = 32_768;

function isValidNote(note: unknown): boolean {
  return note === undefined || (typeof note === 'string' && note.length <= MAX_NOTE_LENGTH);
}

function scrubNoteForSidecar(note: string | undefined): string | undefined {
  if (note === undefined || isBlankNoteContent(note)) return undefined;
  return clampToCodeUnits(redactContent(note).redacted, MAX_NOTE_LENGTH);
}

export function isValidAttachmentContentType(
  value: unknown,
): value is OkImageAttachmentContentType {
  return (
    typeof value === 'string' &&
    (BUG_REPORT_ATTACHMENT_CONTENT_TYPES as readonly string[]).includes(value)
  );
}

function isAttachmentBytes(value: unknown): value is Uint8Array {
  return value instanceof Uint8Array;
}

function isValidAttachments(value: unknown): value is OkBugReportAttachmentInput[] | undefined {
  if (value === undefined) return true;
  if (!Array.isArray(value) || value.length > MAX_BUG_REPORT_ATTACHMENTS) return false;
  let total = 0;
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) return false;
    const e = entry as Record<string, unknown>;
    if (!isValidAttachmentContentType(e.contentType) || !isAttachmentBytes(e.bytes)) return false;
    total += e.bytes.byteLength;
  }
  return total <= MAX_BUG_REPORT_ATTACHMENTS_TOTAL_BYTES;
}

function isCreateRequest(request: unknown): request is OkBugReportCreateRequest {
  if (typeof request !== 'object' || request === null) return false;
  const r = request as Record<string, unknown>;
  return (
    r.kind === 'create' &&
    (r.level === 'standard' || r.level === 'full') &&
    isValidNote(r.note) &&
    (r.includeCrashDump === undefined || typeof r.includeCrashDump === 'boolean') &&
    (r.includeScreenshot === undefined || typeof r.includeScreenshot === 'boolean') &&
    isValidAttachments(r.attachments)
  );
}

type MinidumpAttachReason =
  | 'attached'
  | 'declined'
  | 'not-offered'
  | 'none-available'
  | 'stage-failed';

const NO_MINIDUMP_LOOKUP: MinidumpReportLookup = {
  path: null,
  foreignSkipped: 0,
  unknownSkipped: 0,
};

export interface StagingMinidumpIntent {
  reason: 'staging';
  zipEntry: string;
}

export type MinidumpIntent =
  | { reason: Exclude<MinidumpAttachReason, 'attached' | 'stage-failed'> }
  | StagingMinidumpIntent;

export function resolveMinidumpIntent(input: {
  requested: boolean | undefined;
  minidumpPath: string | null;
}): MinidumpIntent {
  if (input.requested === undefined) return { reason: 'not-offered' };
  if (input.requested === false) return { reason: 'declined' };
  if (input.minidumpPath === null) return { reason: 'none-available' };
  return { reason: 'staging', zipEntry: `extra/${basename(input.minidumpPath)}` };
}

export function resolveMinidumpAttachment(
  intent: StagingMinidumpIntent,
  bundledFiles: readonly string[],
): { attached: true; reason: 'attached' } | { attached: false; reason: 'stage-failed' } {
  if (bundledFiles.includes(intent.zipEntry)) return { attached: true, reason: 'attached' };
  return { attached: false, reason: 'stage-failed' };
}

function recordMinidumpDecision(
  logger: BundleLogger | undefined,
  level: 'info' | 'warn',
  payload: Record<string, unknown>,
  message: string,
): void {
  try {
    if (level === 'warn') logger?.warn(payload, message);
    else logger?.info(payload, message);
  } catch {}
}

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

  const extraFiles: { sourcePath: string; zipName?: string }[] = [];
  if (minidumpPath !== null) extraFiles.push({ sourcePath: minidumpPath });

  const dumpSizeBytes =
    minidumpPath === null
      ? undefined
      : await stat(minidumpPath)
          .then((s) => s.size)
          .catch(() => undefined);
  const dumpAccessibilityMode =
    minidumpPath === null ? null : readMinidumpAccessibilityMode(minidumpPath);
  const dumpDisplayLock = minidumpPath === null ? null : readMinidumpDisplayLockState(minidumpPath);

  const decisionFacts = {
    event: 'bug-report.minidump-decision',
    requested: request.includeCrashDump === true,
    ...(request.includeCrashDump === true
      ? {
          minidumpAvailable: minidumpPath !== null,
          foreignDumpsIgnored: minidumpLookup.foreignSkipped,
          unreadableDumpsSkipped: minidumpLookup.unknownSkipped,
        }
      : {}),
    ...(dumpSizeBytes !== undefined ? { sizeBytes: dumpSizeBytes } : {}),
    ...(dumpAccessibilityMode === null
      ? {}
      : {
          accessibilityMode: dumpAccessibilityMode.mode,
          accessibilityModeParseFailed: dumpAccessibilityMode.parseFailed,
        }),
    ...(dumpDisplayLock === null
      ? {}
      : {
          displayLock: dumpDisplayLock.state,
          displayLockParseFailed: dumpDisplayLock.parseFailed,
        }),
  };

  recordMinidumpDecision(
    deps.logger,
    'info',
    { ...decisionFacts, phase: 'intent', reason: intent.reason },
    'bug-report: crash-dump decision recorded before collection',
  );
  try {
    deps.flushLogger?.();
  } catch {}

  const stagedAttachments: StagedAttachment[] = (request.attachments ?? []).map((attachment) => ({
    contentType: attachment.contentType,
    bytes: Buffer.from(
      attachment.bytes.buffer,
      attachment.bytes.byteOffset,
      attachment.bytes.byteLength,
    ),
  }));

  let screenshotTmpPath: string | null = null;
  const attachmentTmpPaths: string[] = [];
  try {
    if (screenshotBytes !== null) {
      screenshotTmpPath = join(tmpdir(), `ok-bugreport-screenshot-${randomUUID()}.png`);
      await writeFile(screenshotTmpPath, screenshotBytes, { mode: 0o600 });
      extraFiles.push({ sourcePath: screenshotTmpPath, zipName: BUG_REPORT_SCREENSHOT_ZIP_NAME });
    }
    for (const [index, attachment] of stagedAttachments.entries()) {
      const extension = BUG_REPORT_ATTACHMENT_EXTENSIONS[attachment.contentType];
      const tmpPath = join(tmpdir(), `ok-bugreport-attachment-${randomUUID()}.${extension}`);
      await writeFile(tmpPath, attachment.bytes, { mode: 0o600 });
      attachmentTmpPaths.push(tmpPath);
      extraFiles.push({
        sourcePath: tmpPath,
        zipName: `${BUG_REPORT_ATTACHMENTS_ZIP_DIR}/${index + 1}.${extension}`,
      });
    }
    const outputPath = deps.outputPath ?? defaultBugReportZipPath();
    const { zipPath, summary } = await collectReportBundle({
      level: request.level,
      projectDir: deps.projectDir ?? undefined,
      note: request.note,
      redact: true,
      outputPath,
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
    if (screenshotBytes !== null) {
      try {
        deps.onScreenshotStaged?.(basename(zipPath), screenshotBytes);
      } catch (err) {
        try {
          deps.logger?.warn({ zipPath, err }, 'bug-report: failed to retain screenshot for send');
        } catch {}
      }
    }
    if (stagedAttachments.length > 0) {
      try {
        deps.onAttachmentsStaged?.(basename(zipPath), stagedAttachments);
      } catch (err) {
        try {
          deps.logger?.warn({ zipPath, err }, 'bug-report: failed to retain attachments for send');
        } catch {}
      }
    }
    if (deps.onReportGenerated) {
      const persist = deps.onReportGenerated;
      await Promise.resolve()
        .then(() => {
          const sidecarNote = scrubNoteForSidecar(request.note);
          return persist({
            zipPath,
            zipBytes: zipSizeBytes,
            level: request.level,
            systemWide: summary.systemWide,
            projectSlug: summary.projectSlug,
            ...(sidecarNote !== undefined ? { note: sidecarNote } : {}),
          });
        })
        .catch((err: unknown) => {
          deps.logger?.warn(
            { zipPath, err },
            'bug-report: failed to persist report sidecar on generate',
          );
        });
    }
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
      await unlink(screenshotTmpPath).catch((err: unknown) => {
        deps.logger?.warn(
          { screenshotTmpPath, err },
          'bug-report: failed to remove temp screenshot file',
        );
      });
    }
    for (const attachmentTmpPath of attachmentTmpPaths) {
      await unlink(attachmentTmpPath).catch((err: unknown) => {
        deps.logger?.warn(
          { attachmentTmpPath, err },
          'bug-report: failed to remove temp attachment file',
        );
      });
    }
  }
}

export interface CapturableImage {
  toPNG(): Buffer;
  getSize(): { width: number; height: number };
  resize(options: { width: number }): CapturableImage;
  toDataURL(): string;
}

export interface BugReportScreenshotEntry {
  png: Buffer;
  cleanup: () => void;
}

export interface CaptureScreenshotDeps {
  store: Map<number, BugReportScreenshotEntry>;
  senderId: number;
  capturePage: () => Promise<CapturableImage>;
  previewWidth: number;
  registerCleanup: (cleanup: () => void) => void;
  unregisterCleanup: (cleanup: () => void) => void;
  logger?: BundleLogger;
}

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
    if (png.length === 0) {
      dropExisting();
      return null;
    }
    dropExisting();
    const cleanup = () => {
      deps.store.delete(deps.senderId);
    };
    deps.store.set(deps.senderId, { png, cleanup });
    deps.registerCleanup(cleanup);
    const { width, height } = image.getSize();
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

const MAX_PENDING_REPORT_SCREENSHOTS = 4;

export interface BugReportScreenshotHold {
  remember(reportId: string, png: Buffer, owner: number): void;
  rememberAttachments(
    reportId: string,
    attachments: readonly StagedAttachment[],
    owner: number,
  ): void;
  read(reportId: string): Buffer | null;
  readAttachments(reportId: string): readonly StagedAttachment[];
  forget(reportId: string): void;
  forgetOwner(owner: number): void;
}

export interface BugReportScreenshotHoldOptions {
  maxReports?: number;
  onEvict?: (reportId: string) => void;
}

export function createBugReportScreenshotHold(
  options: BugReportScreenshotHoldOptions = {},
): BugReportScreenshotHold {
  const maxReports = options.maxReports ?? MAX_PENDING_REPORT_SCREENSHOTS;
  const byReport = new Map<
    string,
    { png: Buffer | null; attachments: readonly StagedAttachment[]; owner: number }
  >();

  function upsert(
    reportId: string,
    owner: number,
    patch: Partial<{ png: Buffer | null; attachments: readonly StagedAttachment[] }>,
  ): void {
    const previous = byReport.get(reportId);
    byReport.delete(reportId);
    byReport.set(reportId, {
      png: patch.png ?? previous?.png ?? null,
      attachments: patch.attachments ?? previous?.attachments ?? [],
      owner,
    });
    while (byReport.size > maxReports) {
      const oldest = byReport.keys().next();
      if (oldest.done === true) break;
      byReport.delete(oldest.value);
      options.onEvict?.(oldest.value);
    }
  }

  return {
    remember(reportId, png, owner) {
      upsert(reportId, owner, { png });
    },
    rememberAttachments(reportId, attachments, owner) {
      upsert(reportId, owner, { attachments });
    },
    read(reportId) {
      return byReport.get(reportId)?.png ?? null;
    },
    readAttachments(reportId) {
      return byReport.get(reportId)?.attachments ?? [];
    },
    forget(reportId) {
      byReport.delete(reportId);
    },
    forgetOwner(owner) {
      for (const [reportId, entry] of byReport) {
        if (entry.owner === owner) byReport.delete(reportId);
      }
    },
  };
}

const SUPPORT_EMAIL = 'support@inkeep.com';

export const DEFAULT_BUG_REPORT_INTAKE_URL = 'https://openknowledge.ai';

export function resolveBugReportIntakeUrl(args: { envUrl: string | undefined }): string {
  const trimmed = args.envUrl?.trim();
  return trimmed !== undefined && trimmed !== '' ? trimmed : DEFAULT_BUG_REPORT_INTAKE_URL;
}

export interface BugReportSendDeps {
  intakeBaseUrl: string | undefined;
  appVersion: string;
  platform: string;
  bugReportsRoot: string;
  timeouts?: Partial<BugReportUploadTimeouts>;
  sidecar?: BugReportSendSidecarHooks;
  screenshotPngBytes?: (reportId: string) => Buffer | null;
  attachmentBytes?: (reportId: string) => readonly StagedAttachment[];
}

interface BugReportUploadTimeouts {
  mintMs: number;
  putMs: number;
  completeMs: number;
}

const MINT_TIMEOUT_MS = 30_000;
const PUT_TIMEOUT_MS = 120_000;
const COMPLETE_TIMEOUT_MS = 30_000;

const SCREENSHOT_MINT_TIMEOUT_MS = 10_000;
const SCREENSHOT_PUT_TIMEOUT_MS = 20_000;

export const MAX_UPLOAD_ZIP_BYTES = 256 * 1024 * 1024;

export const MAX_UNSENT_REPORT_COUNT = 10;
export const MAX_UNSENT_REPORT_BYTES = 1024 * 1024 * 1024;
export const MAX_SENT_TOMBSTONE_COUNT = 25;

export const MAX_REPORT_ATTEMPTS = 10;

export interface GeneratedReportMeta {
  zipPath: string;
  zipBytes: number;
  level: ReportBundleLevel;
  systemWide: boolean;
  projectSlug: string | null;
  note?: string;
}

export type SidecarSendOutcome =
  | { kind: 'sent'; reference: string }
  | { kind: 'upload-failed'; reason: string; errorCode?: string }
  | { kind: 'email-drafted' };

export interface BugReportSendSidecarHooks {
  onSendStart(id: string): Promise<{ proceed: boolean }>;
  onSendResult(id: string, outcome: SidecarSendOutcome): Promise<void>;
}

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

function isValidContactEmail(email: unknown): boolean {
  return (
    email === undefined ||
    (typeof email === 'string' &&
      email.length > 0 &&
      email.length <= BUG_REPORT_CONTACT_EMAIL_MAX_LENGTH)
  );
}

function isSendRequest(request: unknown): request is OkBugReportSendRequest {
  if (typeof request !== 'object' || request === null) return false;
  const r = request as Record<string, unknown>;
  if (r.kind !== 'send' || typeof r.zipPath !== 'string') return false;
  if (r.includeScreenshot !== undefined && typeof r.includeScreenshot !== 'boolean') return false;
  if (r.includeAttachments !== undefined && typeof r.includeAttachments !== 'boolean') return false;
  if (r.traceparent !== undefined && typeof r.traceparent !== 'string') return false;
  if (typeof r.metadata !== 'object' || r.metadata === null) return false;
  const m = r.metadata as Record<string, unknown>;
  return (
    (m.level === 'standard' || m.level === 'full') &&
    typeof m.systemWide === 'boolean' &&
    (m.projectSlug === null || typeof m.projectSlug === 'string') &&
    isValidNote(m.note) &&
    isValidContactEmail(m.email)
  );
}

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

interface BugReportWireMetadata extends OkBugReportSendMetadata {
  appVersion: string;
  platform: string;
}

interface BugReportMintResponse {
  uploadUrl: string;
  assetUrl: string;
  headers: Record<string, string>;
}

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
      details?: Readonly<Record<string, string | number | boolean>>;
    };

type BugReportSendStep = 'mint' | 'upload' | 'complete';

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

function hostOf(target: URL | string | undefined): string | undefined {
  if (target === undefined) return undefined;
  try {
    return (typeof target === 'string' ? new URL(target) : target).host;
  } catch {
    return undefined;
  }
}

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

function logImageUploadSkip(handler: string, prefix: string) {
  return (reason: string, cause?: unknown): null => {
    logIpcError({
      event: 'ipc.error',
      channel: 'ok:bug-report:dispatch',
      reason: `${prefix}: ${reason}`,
      handler,
      ...(cause === undefined ? {} : { cause }),
    });
    return null;
  };
}

const logScreenshotSkip = logImageUploadSkip('uploadScreenshotAsset', 'screenshot-upload-skipped');
const logAttachmentSkip = logImageUploadSkip('uploadImageAsset', 'attachment-upload-skipped');

export interface ImageAssetUpload {
  bytes: Uint8Array;
  contentType: OkImageAttachmentContentType;
  filename: string;
}

interface ImageMintEndpoint {
  url: URL;
  body: Record<string, unknown>;
}

async function uploadImageAsset(
  mintEndpoint: (image: ImageAssetUpload) => ImageMintEndpoint,
  image: ImageAssetUpload,
  skip: (reason: string, cause?: unknown) => null,
  timeouts?: Partial<BugReportUploadTimeouts>,
): Promise<string | null> {
  try {
    const endpoint = mintEndpoint(image);
    const mintRes = await fetch(endpoint.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(endpoint.body),
      redirect: 'manual',
      signal: AbortSignal.timeout(timeouts?.mintMs ?? SCREENSHOT_MINT_TIMEOUT_MS),
    });
    if (!mintRes.ok) return skip(`mint responded ${mintRes.status}`);
    const mint = parseMintResponse(await mintRes.json().catch(() => null));
    if (mint === null) return skip('mint response malformed');
    if (parseTransportSafeUrl(mint.uploadUrl) === null) {
      return skip('mint named a non-https upload URL');
    }

    const body = new Uint8Array(image.bytes.byteLength);
    body.set(image.bytes);
    const putRes = await fetch(mint.uploadUrl, {
      method: 'PUT',
      headers: { 'content-type': image.contentType, ...mint.headers },
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(timeouts?.putMs ?? SCREENSHOT_PUT_TIMEOUT_MS),
    });
    if (
      putRes.type === 'opaqueredirect' ||
      putRes.status === 0 ||
      (putRes.status >= 300 && putRes.status < 400)
    ) {
      return skip('upload redirected');
    }
    if (!putRes.ok) return skip(`upload responded ${putRes.status}`);
    return mint.assetUrl;
  } catch (err) {
    return skip('transport error', err);
  }
}

function bugReportMintEndpoint(base: URL, metadata: BugReportWireMetadata) {
  return (image: ImageAssetUpload): ImageMintEndpoint => ({
    url: new URL('/api/bug-report', base),
    body: {
      filename: image.filename,
      sizeBytes: image.bytes.byteLength,
      contentType: image.contentType,
      metadata,
    },
  });
}

function feedbackAttachmentMintEndpoint(base: URL) {
  return (image: ImageAssetUpload): ImageMintEndpoint => ({
    url: new URL('/api/feedback/attachment', base),
    body: {
      filename: image.filename,
      sizeBytes: image.bytes.byteLength,
      contentType: image.contentType,
    },
  });
}

export async function uploadFeedbackImageAsset(
  base: URL,
  image: ImageAssetUpload,
  timeouts?: Partial<BugReportUploadTimeouts>,
): Promise<string | null> {
  return uploadImageAsset(
    feedbackAttachmentMintEndpoint(base),
    image,
    logImageUploadSkip('handleAssetUpload', 'feedback-image-upload-skipped'),
    timeouts,
  );
}

async function uploadBugReport(
  baseUrl: string,
  zipPath: string,
  metadata: BugReportWireMetadata,
  timeouts?: Partial<BugReportUploadTimeouts>,
  screenshotBytes?: Uint8Array | null,
  sendTrace?: BugReportSendTrace,
  attachments: readonly StagedAttachment[] = [],
): Promise<BugReportUploadOutcome> {
  const base = parseTransportSafeUrl(baseUrl);
  if (base === null) {
    return { ok: false, reason: 'intake-url-rejected', cause: `rejected intake URL: ${baseUrl}` };
  }
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
  const mintUrl = new URL('/api/bug-report', base);
  let stepTarget: URL | string = mintUrl;
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
    if (parseTransportSafeUrl(mint.uploadUrl) === null) {
      return {
        ok: false,
        reason: 'upload-url-rejected',
        cause: `rejected upload URL: ${mint.uploadUrl}`,
        details: describeTransportFailure(step, stepTarget, { status: mintRes.status }),
      };
    }

    step = 'upload';
    stepTarget = mint.uploadUrl;
    stepStartedAt = Date.now();
    const putRes = await fetch(mint.uploadUrl, {
      method: 'PUT',
      headers: { 'content-type': 'application/zip', ...mint.headers },
      body: zipBytes,
      redirect: 'manual',
      signal: AbortSignal.timeout(timeouts?.putMs ?? PUT_TIMEOUT_MS),
    });
    sendTrace?.phase(
      'upload',
      { 'http.response.status_code': putRes.status },
      stepStartedAt,
      Date.now(),
    );

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

    const mintEndpoint = bugReportMintEndpoint(base, metadata);
    const screenshotAssetUrl =
      screenshotBytes === undefined || screenshotBytes === null
        ? null
        : await uploadImageAsset(
            mintEndpoint,
            {
              bytes: screenshotBytes,
              contentType: 'image/png',
              filename: BUG_REPORT_SCREENSHOT_ZIP_NAME,
            },
            logScreenshotSkip,
            timeouts,
          );

    const attachmentAssetUrls: string[] = [];
    for (const [index, attachment] of attachments.entries()) {
      const extension = BUG_REPORT_ATTACHMENT_EXTENSIONS[attachment.contentType];
      const assetUrl = await uploadImageAsset(
        mintEndpoint,
        {
          bytes: attachment.bytes,
          contentType: attachment.contentType,
          filename: `attachment-${index + 1}.${extension}`,
        },
        logAttachmentSkip,
        timeouts,
      );
      if (assetUrl !== null) attachmentAssetUrls.push(assetUrl);
    }

    step = 'complete';
    stepTarget = new URL('/api/bug-report/complete', base);
    stepStartedAt = Date.now();
    const completeRes = await fetch(stepTarget, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        assetUrl: mint.assetUrl,
        ...(screenshotAssetUrl === null ? {} : { screenshotAssetUrl }),
        ...(attachmentAssetUrls.length === 0 ? {} : { attachmentAssetUrls }),
        metadata,
      }),
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
  const scrubbedNote =
    request.metadata.note === undefined ? undefined : redactContent(request.metadata.note).redacted;
  const metadata: OkBugReportSendMetadata = {
    level: request.metadata.level,
    systemWide: request.metadata.systemWide,
    projectSlug: request.metadata.projectSlug,
    ...(scrubbedNote !== undefined ? { note: scrubbedNote } : {}),
    ...(request.metadata.email !== undefined ? { email: request.metadata.email } : {}),
  };
  const fallback = {
    mailtoUrl: buildBugReportMailto({
      ...hostFacts,
      metadata,
      zipPath: request.zipPath,
    }),
  };
  const reportId = basename(request.zipPath);
  const sendTrace = beginSendTrace(
    { 'ok.bug_report.include_screenshot': request.includeScreenshot === true },
    request.traceparent,
  );
  if (!deps.intakeBaseUrl) {
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
  const screenshotBytes =
    request.includeScreenshot === true ? (deps.screenshotPngBytes?.(reportId) ?? null) : null;
  if (request.includeScreenshot === true && screenshotBytes === null) {
    logScreenshotSkip('capture unavailable at send time');
  }
  const attachments =
    request.includeAttachments === true ? (deps.attachmentBytes?.(reportId) ?? []) : [];
  if (request.includeAttachments === true && attachments.length === 0) {
    logAttachmentSkip('attachments unavailable at send time');
  }

  const wireMetadata: BugReportWireMetadata = { ...metadata, ...hostFacts };
  const outcome = await uploadBugReport(
    deps.intakeBaseUrl,
    canonicalZipPath,
    wireMetadata,
    deps.timeouts,
    screenshotBytes,
    sendTrace,
    attachments,
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
    ...(outcome.details === undefined ? {} : { details: outcome.details }),
  });
  await runSidecarHook(
    deps.sidecar?.onSendResult(reportId, {
      kind: 'upload-failed',
      reason: outcome.reason,
      ...(typeof outcome.details?.errCode === 'string'
        ? { errorCode: outcome.details.errCode }
        : {}),
    }),
  );
  sendTrace.end('upload-failed');
  return { ok: false, reason: 'send-failed', fallback };
}

export interface BugReportCrashAckDeps {
  ackCrashEvent(eventId: string): void;
}

function isCrashAckRequest(request: unknown): request is OkBugReportCrashAckRequest {
  if (typeof request !== 'object' || request === null) return false;
  const r = request as Record<string, unknown>;
  return r.kind === 'crash-ack' && typeof r.eventId === 'string' && r.eventId !== '';
}

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

export function handleBugReportCrashDumpAvailability(deps: {
  newestMinidumpForReport?: () => MinidumpReportLookup;
  logger?: BundleLogger;
}): OkBugReportCrashDumpAvailability {
  try {
    return { available: (deps.newestMinidumpForReport?.() ?? NO_MINIDUMP_LOOKUP).path !== null };
  } catch (err) {
    recordMinidumpDecision(
      deps.logger,
      'warn',
      { event: 'bug-report.crash-dump-availability-failed', err },
      'crash-dump availability lookup failed; offering no dump',
    );
    return { available: false };
  }
}

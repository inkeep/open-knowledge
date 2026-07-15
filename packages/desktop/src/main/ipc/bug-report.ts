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

import { readFile, realpath, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import {
  type BundleLogger,
  collectReportBundle,
  defaultBugReportZipPath,
  redactContent,
} from '@inkeep/open-knowledge';
import type {
  OkBugReportCrashAckResult,
  OkBugReportCreateResult,
  OkBugReportSendMetadata,
  OkBugReportSendResult,
  ReportBundleLevel,
} from '@inkeep/open-knowledge-core';
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
}

export interface OkBugReportSendRequest {
  kind: 'send';
  /** Zip produced by a prior `create` — the exact file the user reviewed is what uploads. */
  zipPath: string;
  metadata: OkBugReportSendMetadata;
}

export interface OkBugReportCrashAckRequest {
  kind: 'crash-ack';
  /** `eventId` from the `ok:bug-report:crash-detected` push being answered. */
  eventId: string;
}

/** Every operation the `ok:bug-report:dispatch` channel carries. */
export type OkBugReportRequest =
  | OkBugReportCreateRequest
  | OkBugReportSendRequest
  | OkBugReportCrashAckRequest;

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
  /** Zip destination override; defaults to `~/.ok/bug-reports/<timestamp>-bugreport.zip`. */
  outputPath?: string;
  /** User-level logs directory override (standard-level test seam). */
  userLogsDir?: string;
  /**
   * Crash-detection lookup for the newest un-acked minidump (wired from
   * `CrashDetection.newestMinidumpPath`). Only consulted when the renderer
   * opted in via `includeCrashDump`; absent or returning null simply omits
   * the dump.
   */
  newestMinidumpPath?: () => string | null;
  /**
   * Sink for the collector's warnings — most importantly an opted-in crash
   * dump that could not be staged, which must be traceable rather than a
   * silent omission from the bundle.
   */
  logger?: BundleLogger;
}

/**
 * `createHandler` casts renderer args without runtime enforcement, so the
 * payload is re-validated here before any filesystem work.
 */
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

function isCreateRequest(request: unknown): request is OkBugReportCreateRequest {
  if (typeof request !== 'object' || request === null) return false;
  const r = request as Record<string, unknown>;
  return (
    r.kind === 'create' &&
    (r.level === 'standard' || r.level === 'full') &&
    isValidNote(r.note) &&
    (r.includeCrashDump === undefined || typeof r.includeCrashDump === 'boolean')
  );
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
  const minidumpPath =
    request.includeCrashDump === true ? (deps.newestMinidumpPath?.() ?? null) : null;
  try {
    const { zipPath, summary } = await collectReportBundle({
      level: request.level,
      projectDir: deps.projectDir ?? undefined,
      note: request.note,
      // The in-app surface always redacts; only the CLI exposes an opt-out.
      redact: true,
      outputPath: deps.outputPath ?? defaultBugReportZipPath(),
      userLogsDir: deps.userLogsDir,
      extraFiles: minidumpPath === null ? undefined : [{ sourcePath: minidumpPath }],
      logger: deps.logger,
      readDesktopEnv: () => ({
        electronVersion: deps.desktopMeta.version,
        packaged: deps.desktopMeta.packaged,
        channel: deps.desktopMeta.channel,
      }),
    });
    const { size: zipSizeBytes } = await stat(zipPath);
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
  }
}

const SUPPORT_EMAIL = 'support@inkeep.com';

export interface BugReportSendDeps {
  /**
   * Intake endpoint origin (e.g. `https://openknowledge.ai`), from
   * `OK_BUG_REPORT_INTAKE_URL`. Absent means the endpoint is not deployed or
   * not configured — the designed default: send makes no network attempt and
   * resolves to the email fallback with `reason: 'email-draft'`, which the
   * dialog renders as the email flow rather than a failure.
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

/**
 * Ceiling on the zip size `send` will buffer into main-process memory for the
 * PUT. Real bundles sit in the tens of MB (the log/span sinks are size-capped)
 * plus an optional minidump; 256 MiB refuses a pathological zip before the
 * read can exhaust the process, degrading to the email fallback instead.
 */
export const MAX_UPLOAD_ZIP_BYTES = 256 * 1024 * 1024;

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
  | { ok: false; reason: string; cause?: unknown };

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
  let step: 'mint' | 'upload' | 'complete' = 'mint';
  try {
    const mintRes = await fetch(new URL('/api/bug-report', base), {
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
    if (!mintRes.ok) return { ok: false, reason: `mint-rejected: ${mintRes.status}` };
    const mint = parseMintResponse(await mintRes.json().catch(() => null));
    if (mint === null) return { ok: false, reason: 'mint-malformed' };
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
      };
    }

    step = 'upload';
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
    // `redirect: 'manual'` surfaces the un-followed redirect either as the
    // raw 3xx or as an opaque-redirect response (status 0), depending on
    // runtime — classify both apart from an ordinary status rejection.
    if (
      putRes.type === 'opaqueredirect' ||
      putRes.status === 0 ||
      (putRes.status >= 300 && putRes.status < 400)
    ) {
      return { ok: false, reason: 'upload-redirected' };
    }
    if (!putRes.ok) return { ok: false, reason: `upload-rejected: ${putRes.status}` };

    step = 'complete';
    const completeRes = await fetch(new URL('/api/bug-report/complete', base), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ assetUrl: mint.assetUrl, metadata }),
      redirect: 'manual',
      signal: AbortSignal.timeout(timeouts?.completeMs ?? COMPLETE_TIMEOUT_MS),
    });
    if (!completeRes.ok) return { ok: false, reason: `complete-rejected: ${completeRes.status}` };
    const reference = parseCompletionReference(await completeRes.json().catch(() => null));
    if (reference === null) return { ok: false, reason: 'complete-malformed' };
    return { ok: true, reference };
  } catch (err) {
    // Offline, DNS failure, refused connection — or a timeout ceiling firing
    // on a hung endpoint. `AbortError` is classified as a timeout alongside
    // `TimeoutError` because runtimes disagree on which name an
    // `AbortSignal.timeout()` abort carries; the flip side is that no
    // user-cancel AbortController may be wired to these fetches without
    // first splitting cancel out of this classification.
    const timedOut =
      err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return { ok: false, reason: timedOut ? `${step}-timeout` : 'network-error', cause: err };
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
    return { ok: false, reason: 'email-draft', fallback };
  }
  const wireMetadata: BugReportWireMetadata = { ...metadata, ...hostFacts };
  const outcome = await uploadBugReport(
    deps.intakeBaseUrl,
    canonicalZipPath,
    wireMetadata,
    deps.timeouts,
  );
  if (outcome.ok) return { ok: true, reference: outcome.reference };
  logIpcError({
    event: 'ipc.error',
    channel: 'ok:bug-report:dispatch',
    reason: outcome.reason,
    handler: 'handleBugReportSend',
    cause: outcome.cause,
  });
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

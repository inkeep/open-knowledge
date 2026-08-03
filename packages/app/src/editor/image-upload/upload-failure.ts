/**
 * Classification for an upload that failed before the server saw it.
 *
 * `fetch` collapses every pre-network failure into an opaque
 * `TypeError: Failed to fetch`: a vanished backing file, an OS read denial and
 * an unreachable server are indistinguishable from the error alone. None of
 * them reach the server either, so there is no server-side record to correlate
 * against — the failure is invisible on both sides of the wire.
 *
 * The distinguishing fact is that Chromium materializes a `File`'s bytes
 * lazily, when it builds the request body. A file that was readable when the
 * user dropped it can therefore fail at send time, and once its backing store
 * is gone `File.size` reads 0 while the object itself stays usable.
 *
 * That last detail is why the probe takes `sizeAtDrop`. Bounding the read by
 * the file's CURRENT size cannot detect anything: for a vanished file
 * `slice(0, 1)` spans zero bytes, resolves to an empty buffer, and reports
 * success for precisely the case worth catching.
 */
import { t } from '@lingui/core/macro';

export type UploadFailureKind = 'file-unreadable' | 'network';

/**
 * Ceiling on the probe's read.
 *
 * The probe sits between a failed upload and the error UI, so it must not
 * become a second way for the user to be left waiting. A local read of one
 * byte is sub-millisecond; the case that can stall is a cloud placeholder
 * whose bytes the OS tries to materialize on demand, which is one of the
 * causes the user-facing copy names. The File API sets no deadline on a read,
 * so without this bound a stalled materialization would leave the upload
 * skeleton spinning forever and emit no log at all.
 */
const PROBE_TIMEOUT_MS = 1000;

export interface FileReadProbe {
  /** False when the bytes promised at drop time can no longer be read. */
  readable: boolean;
  /** Bytes the probe actually obtained. */
  bytesRead: number;
  /** Present only when the read threw, e.g. a `NotReadableError` denial. */
  error?: string;
  /** True when the read did not settle within `PROBE_TIMEOUT_MS`. */
  timedOut?: boolean;
}

/** Error thrown by `uploadFile`, carrying the classification for its callers. */
export class UploadFailedError extends Error {
  readonly kind: UploadFailureKind;

  constructor(message: string, kind: UploadFailureKind) {
    super(message);
    this.name = 'UploadFailedError';
    this.kind = kind;
  }
}

/**
 * Re-read the head of `file`, bounded both by the size observed when the user
 * handed it over and by a wall-clock deadline. Runs only on an already-failed
 * upload, so the cost is one byte on a path that is about to show an error.
 */
export async function probeFileReadable(
  file: Blob,
  sizeAtDrop: number,
  timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<FileReadProbe> {
  // A genuinely empty file has nothing to prove — reading zero bytes from it
  // succeeds and says nothing about the backing store either way.
  if (sizeAtDrop <= 0) return { readable: true, bytesRead: 0 };

  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<FileReadProbe>((resolve) => {
    timer = setTimeout(() => resolve({ readable: false, bytesRead: 0, timedOut: true }), timeoutMs);
  });
  const read = (async (): Promise<FileReadProbe> => {
    try {
      const head = await file.slice(0, 1).arrayBuffer();
      return { readable: head.byteLength === 1, bytesRead: head.byteLength };
    } catch (error) {
      return {
        readable: false,
        bytesRead: 0,
        error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      };
    }
  })();

  try {
    return await Promise.race([read, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

export function classifyUploadFailure(probe: FileReadProbe): UploadFailureKind {
  // A read that never answered is not evidence of a healthy file. Reporting it
  // as a server problem would send the user to the wrong place, and the
  // unreadable copy ("moved, deleted, or not finished downloading") describes a
  // stalled materialization accurately.
  return probe.readable ? 'network' : 'file-unreadable';
}

export function uploadFailureMessage(kind: UploadFailureKind, fileName: string): string {
  return kind === 'file-unreadable'
    ? t`Couldn't read ${fileName}. It may have been moved, deleted, or not finished downloading. Try adding it again.`
    : t`Couldn't reach the Open Knowledge server to upload ${fileName}.`;
}

export interface UploadFailureReport {
  kind: UploadFailureKind;
  /** Translated, user-facing sentence for `kind`. */
  message: string;
  /** Structured record for the diagnostics bundle. */
  log: Record<string, unknown>;
}

/**
 * Single decision point for a failed upload, shared by the editor drop path and
 * the file pickers so both classify, phrase and log identically.
 */
export async function reportUploadFailure(input: {
  file: File;
  sizeAtDrop: number;
  error: unknown;
}): Promise<UploadFailureReport> {
  const { file, sizeAtDrop, error } = input;
  const probe = await probeFileReadable(file, sizeAtDrop);
  const kind = classifyUploadFailure(probe);
  return {
    kind,
    message: uploadFailureMessage(kind, file.name),
    log: {
      kind,
      name: file.name,
      type: file.type,
      sizeAtDrop,
      sizeAtSend: file.size,
      bytesRead: probe.bytesRead,
      readError: probe.error,
      readTimedOut: probe.timedOut,
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    },
  };
}

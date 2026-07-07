/**
 * Typed upload-write errors.
 *
 * Extracted from api-extension.ts into its own module so upload-streaming.ts
 * and api-extension.ts can both import without creating a cycle. The reason
 * field is a strict subset of `ProblemType` — the URN token is the same
 * value the wire-side error envelope emits, so the handler dispatch from
 * `e.reason` to the response is a typed pass-through (no kebab→URN
 * translation table to drift).
 */

import { assertNeverProblemType, type ProblemType } from '@inkeep/open-knowledge-core';
import type { HttpErrorStatus } from './http/error-response.ts';

/**
 * The upload-side subset of `ProblemType`. Five variants:
 * collision-exhaustion, storage-full, storage-readonly, storage-error,
 * malformed-upload — each maps 1:1 to a `urn:ok:error:*` URN registered
 * in `ProblemTypeSchema`.
 */
export type UploadWriteReason = Extract<
  ProblemType,
  | 'urn:ok:error:collision-exhaustion'
  | 'urn:ok:error:storage-full'
  | 'urn:ok:error:storage-readonly'
  | 'urn:ok:error:storage-error'
  | 'urn:ok:error:malformed-upload'
>;

export class UploadWriteError extends Error {
  readonly reason: UploadWriteReason;

  constructor(reason: UploadWriteReason, cause?: unknown) {
    // ES2022 `Error(message, { cause })` populates `Error.cause` on the
    // prototype chain so Pino's std serializer surfaces the underlying
    // I/O error in structured logs. Setting `this.name` ensures
    // `err.name === 'UploadWriteError'` for serializer routing and
    // stack-trace identification, matching codebase parity with
    // `HocuspocusAuthRejection`, `StateManifestError`, and
    // `SuggestLinksTargetNotFoundError`.
    super(`UploadWriteError: ${reason}`, { cause });
    this.name = 'UploadWriteError';
    this.reason = reason;
  }
}

/**
 * HTTP status for a given upload reason. Exhaustive switch — adding a new
 * variant to `UploadWriteReason` surfaces here as a compile error before
 * the handler can drop a write into a generic 500.
 */
export function uploadStatusFor(reason: UploadWriteReason): HttpErrorStatus {
  switch (reason) {
    case 'urn:ok:error:malformed-upload':
      return 400;
    case 'urn:ok:error:storage-full':
      // RFC 4918 507 Insufficient Storage — explicit "disk full," retry
      // makes no sense until the operator frees space.
      return 507;
    case 'urn:ok:error:storage-readonly':
      return 500;
    case 'urn:ok:error:storage-error':
      return 500;
    case 'urn:ok:error:collision-exhaustion':
      return 500;
    default:
      return assertNeverProblemType(reason);
  }
}

/**
 * Classify a `NodeJS.ErrnoException` from a filesystem write into a typed
 * upload write reason. Shared by the streaming-write pipeline (busboy's
 * `_write` error path) and the upload-asset destination-mkdir guard so
 * both sites map the same errno tables to the same URN — without this,
 * the mkdir guard would silently route `ENOSPC` / `EROFS` / `EACCES` into
 * a generic 500 `storage-error` instead of the typed 507 `storage-full`
 * / 500 `storage-readonly` SDK consumers branch on.
 */
export function classifyUploadErrno(err: NodeJS.ErrnoException): UploadWriteReason {
  if (err.code === 'ENOSPC' || err.code === 'EDQUOT') return 'urn:ok:error:storage-full';
  if (err.code === 'EROFS' || err.code === 'EACCES' || err.code === 'EPERM') {
    return 'urn:ok:error:storage-readonly';
  }
  return 'urn:ok:error:storage-error';
}

/**
 * RFC 9457 `title` for a given upload reason. Required short human-readable
 * English summary (RFC 9457 §3.1.4).
 */
export function uploadTitleFor(reason: UploadWriteReason): string {
  switch (reason) {
    case 'urn:ok:error:malformed-upload':
      return 'Upload payload is malformed.';
    case 'urn:ok:error:storage-full':
      return 'Storage is full.';
    case 'urn:ok:error:storage-readonly':
      return 'Storage is read-only.';
    case 'urn:ok:error:storage-error':
      return 'Failed to write upload.';
    case 'urn:ok:error:collision-exhaustion':
      return 'Filename collision retries exhausted.';
    default:
      return assertNeverProblemType(reason);
  }
}

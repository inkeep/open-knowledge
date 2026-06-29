import { assertNeverProblemType, type ProblemType } from '@inkeep/open-knowledge-core';
import type { HttpErrorStatus } from './http/error-response.ts';

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
    super(`UploadWriteError: ${reason}`, { cause });
    this.name = 'UploadWriteError';
    this.reason = reason;
  }
}

export function uploadStatusFor(reason: UploadWriteReason): HttpErrorStatus {
  switch (reason) {
    case 'urn:ok:error:malformed-upload':
      return 400;
    case 'urn:ok:error:storage-full':
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

export function classifyUploadErrno(err: NodeJS.ErrnoException): UploadWriteReason {
  if (err.code === 'ENOSPC' || err.code === 'EDQUOT') return 'urn:ok:error:storage-full';
  if (err.code === 'EROFS' || err.code === 'EACCES' || err.code === 'EPERM') {
    return 'urn:ok:error:storage-readonly';
  }
  return 'urn:ok:error:storage-error';
}

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

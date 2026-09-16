import type { ServerResponse } from 'node:http';
import { stripDocExtension } from './doc-extensions.ts';
import { errorResponse } from './http/error-response.ts';
import { getLogger } from './logger.ts';
import { incrementConcurrentOverwriteRefused } from './metrics.ts';

export const CONCURRENT_OVERWRITE_REFUSED_TYPE = 'urn:ok:error:concurrent-overwrite-refused';
export const CONCURRENT_OVERWRITE_REFUSED_TITLE = 'Concurrent overwrite refused.';
export const CONCURRENT_OVERWRITE_REFUSED_DETAIL =
  'Another writer changed this document recently. Wait a few seconds and retry.';
export const CONCURRENT_OVERWRITE_REFUSED_DETAIL_WITH_POSITIONS = `${CONCURRENT_OVERWRITE_REFUSED_DETAIL} A write with position append or prepend is not refused.`;

export const CONCURRENT_OVERWRITE_RETRY_AFTER_SECONDS = 3;

export class ConcurrentOverwriteRefusedError extends Error {
  readonly file: string;
  override readonly name = 'ConcurrentOverwriteRefusedError' as const;

  constructor(file: string) {
    super(`Concurrent overwrite refused for ${file}`);
    this.file = file;
  }
}

export function logConcurrentOverwriteRefusal(
  error: ConcurrentOverwriteRefusedError,
  handler: string,
): void {
  incrementConcurrentOverwriteRefused();
  getLogger('agent-write').warn(
    {
      event: 'concurrent-overwrite-write-refused',
      handler,
      'doc.name': stripDocExtension(error.file),
    },
    'concurrent replace refused before mutation',
  );
}

export function respondConcurrentOverwriteRefused(
  res: ServerResponse,
  error: ConcurrentOverwriteRefusedError,
  handler: string,
): void {
  logConcurrentOverwriteRefusal(error, handler);
  errorResponse(res, 409, CONCURRENT_OVERWRITE_REFUSED_TYPE, CONCURRENT_OVERWRITE_REFUSED_TITLE, {
    handler,
    detail: CONCURRENT_OVERWRITE_REFUSED_DETAIL_WITH_POSITIONS,
    extensions: {
      file: error.file,
      retryAfterSeconds: CONCURRENT_OVERWRITE_RETRY_AFTER_SECONDS,
    },
    extraHeaders: { 'Retry-After': String(CONCURRENT_OVERWRITE_RETRY_AFTER_SECONDS) },
  });
}

import type { ServerResponse } from 'node:http';
import type { AgentWriteOutcomeFields } from '@inkeep/open-knowledge-core';
import { errorResponse } from './error-response.ts';

const BOTH_KEPT_TITLE = 'Edit saved; both versions of a block changed here and outside were kept.';

const BOTH_KEPT_DETAIL =
  'Your write landed and is saved to the file; do not retry it. Where a block was changed both here and outside, both versions are in the document, the version here first and the outside version directly under it. Re-read the document and, if your task calls for it, remove the duplicate with an ordinary edit.';

export function respondBothKept(
  res: ServerResponse,
  handler: string,
  body: Record<string, unknown>,
  outcome: AgentWriteOutcomeFields,
): void {
  errorResponse(res, 409, 'urn:ok:error:both-kept', BOTH_KEPT_TITLE, {
    handler,
    detail: BOTH_KEPT_DETAIL,
    extensions: { ...body, ...outcome },
    logLevel: 'debug',
  });
}

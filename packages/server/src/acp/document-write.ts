import { RequestError, type WriteTextFileResponse } from '@agentclientprotocol/sdk';
import {
  type AgentWriteOutcomeFields,
  normalizeAgentWriteOutcome,
} from '@inkeep/open-knowledge-core';
import { asRecord } from '@inkeep/open-knowledge-core/acp/tool-call-input';
import {
  CONCURRENT_OVERWRITE_REFUSED_DETAIL,
  CONCURRENT_OVERWRITE_REFUSED_TYPE,
  CONCURRENT_OVERWRITE_RETRY_AFTER_SECONDS,
} from '../concurrent-overwrite-refused-error.ts';
import type { LocalApiDispatch } from '../http/local-api-dispatch.ts';

export const ACP_DOCUMENT_WRITE_PATH = '/internal/acp/document-write';

const CONCURRENT_OVERWRITE_REFUSED_CODE = -32009;

const WRITE_NOT_PLAIN_SUCCESS_CODE = -32010;

export interface AcpDocumentWrite {
  readonly docName: string;
  readonly file: string;
  readonly markdown: string;
  readonly agentId: string;
  readonly agentName: string;
  readonly clientName: string;
}

export async function writeDocumentThroughRoute(
  localApi: LocalApiDispatch,
  write: AcpDocumentWrite,
): Promise<WriteTextFileResponse> {
  const answer = await localApi('POST', ACP_DOCUMENT_WRITE_PATH, {
    body: JSON.stringify({
      docName: write.docName,
      file: write.file,
      markdown: write.markdown,
      ...markdownExtensionOf(write.file),
      agentId: write.agentId,
      agentName: write.agentName,
      clientName: write.clientName,
    }),
    contentType: 'application/json',
  });
  if (answer === null) {
    throw new Error(`${ACP_DOCUMENT_WRITE_PATH} is not dispatchable in process`);
  }
  return acpWriteResult(answer.status, asRecord(JSON.parse(answer.bodyText)), write.file);
}

function markdownExtensionOf(file: string): { extension?: '.md' | '.mdx' } {
  if (file.endsWith('.mdx')) return { extension: '.mdx' };
  if (file.endsWith('.md')) return { extension: '.md' };
  return {};
}

function outcomeFieldsOf(
  body: Record<string, unknown>,
): (Pick<AgentWriteOutcomeFields, 'outcome'> & Partial<AgentWriteOutcomeFields>) | undefined {
  const normalized = normalizeAgentWriteOutcome(body);
  if (normalized === undefined) return undefined;
  return {
    outcome: normalized.outcome,
    ...(normalized.saved === undefined ? {} : { saved: normalized.saved }),
    ...(normalized.nextStep === undefined ? {} : { nextStep: normalized.nextStep }),
  };
}

function problemMessage(status: number, body: Record<string, unknown>): string {
  const title = typeof body.title === 'string' ? body.title : `The write answered ${status}.`;
  return typeof body.detail === 'string' ? `${title} ${body.detail}` : title;
}

function acpWriteResult(
  status: number,
  body: Record<string, unknown>,
  file: string,
): WriteTextFileResponse {
  const fields = outcomeFieldsOf(body);
  const plainSuccess =
    status >= 200 &&
    status < 300 &&
    (fields === undefined || fields.outcome === 'applied' || fields.outcome === 'merged-first');
  if (plainSuccess) return fields === undefined ? {} : { _meta: { openknowledge: { ...fields } } };
  if (body.type === CONCURRENT_OVERWRITE_REFUSED_TYPE) {
    throw new RequestError(CONCURRENT_OVERWRITE_REFUSED_CODE, CONCURRENT_OVERWRITE_REFUSED_DETAIL, {
      type: CONCURRENT_OVERWRITE_REFUSED_TYPE,
      file,
      retryable: true,
      retryAfterSeconds: CONCURRENT_OVERWRITE_RETRY_AFTER_SECONDS,
      ...fields,
    });
  }
  throw new RequestError(WRITE_NOT_PLAIN_SUCCESS_CODE, problemMessage(status, body), {
    type: typeof body.type === 'string' ? body.type : 'urn:ok:error:internal-server-error',
    file,
    ...fields,
  });
}

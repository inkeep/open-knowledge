import type { ServerResponse } from 'node:http';
import type { AgentSessionCapacityError } from '../agent-sessions.ts';
import { errorResponse } from './error-response.ts';

export const AGENT_SESSION_CAPACITY_TYPE = 'urn:ok:error:too-many-agent-sessions';
export const AGENT_SESSION_CAPACITY_TITLE = 'Too many agent sessions.';
export const AGENT_SESSION_CAPACITY_DETAIL =
  'The server is at its agent session limit, so this write was not applied and is safe to retry.';
const AGENT_SESSION_CAPACITY_RETRY_AFTER_SECONDS = 10;

export const AGENT_SESSION_CAPACITY_EXTENSIONS = {
  committed: false,
  retryAfterSeconds: AGENT_SESSION_CAPACITY_RETRY_AFTER_SECONDS,
} as const;

export function respondAgentSessionCapacity(
  res: ServerResponse,
  error: AgentSessionCapacityError,
  handler: string,
): void {
  errorResponse(res, 503, AGENT_SESSION_CAPACITY_TYPE, AGENT_SESSION_CAPACITY_TITLE, {
    handler,
    cause: error,
    detail: AGENT_SESSION_CAPACITY_DETAIL,
    extensions: { ...AGENT_SESSION_CAPACITY_EXTENSIONS },
    extraHeaders: { 'Retry-After': String(AGENT_SESSION_CAPACITY_RETRY_AFTER_SECONDS) },
  });
}

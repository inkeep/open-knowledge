import {
  buildClaudeUrl,
  buildCodexUrl,
  buildCursorUrl,
  type HandoffOutcome,
  type HandoffPayload,
  type HandoffTarget,
} from '@inkeep/open-knowledge-core';

interface DispatchHandoffDeps {
  readonly fetch?: typeof globalThis.fetch;
}

interface HandoffRequestBody {
  readonly target: HandoffTarget;
  readonly url: string;
  readonly workspacePath?: string;
}

async function postHandoff(
  body: HandoffRequestBody,
  fetchImpl: typeof globalThis.fetch,
): Promise<HandoffOutcome> {
  let res: Response;
  try {
    res = await fetchImpl('/api/handoff', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: 'dispatch-error', detail };
  }
  if (res.status === 200) {
    return { ok: true };
  }
  if (res.status === 404) {
    return { ok: false, reason: 'not-installed', detail: 'POST /api/handoff returned 404' };
  }
  if (res.status === 422) {
    return {
      ok: false,
      reason: 'not-installed',
      detail: `POST /api/handoff returned ${res.status}`,
    };
  }
  return {
    ok: false,
    reason: 'dispatch-error',
    detail: `POST /api/handoff returned ${res.status}`,
  };
}

export async function dispatchHandoff(
  payload: HandoffPayload,
  deps: DispatchHandoffDeps = {},
): Promise<HandoffOutcome> {
  const fetchImpl = deps.fetch ?? globalThis.fetch.bind(globalThis);
  switch (payload.target) {
    case 'claude-cowork':
      return postHandoff(
        {
          target: 'claude-cowork',
          url: buildClaudeUrl({ mode: 'cowork' }, payload),
        },
        fetchImpl,
      );
    case 'claude-code':
      return postHandoff(
        {
          target: 'claude-code',
          url: buildClaudeUrl({ mode: 'code' }, payload),
        },
        fetchImpl,
      );
    case 'codex':
      return postHandoff(
        {
          target: 'codex',
          url: buildCodexUrl(payload),
        },
        fetchImpl,
      );
    case 'cursor':
      return postHandoff(
        {
          target: 'cursor',
          url: buildCursorUrl(payload),
          workspacePath: payload.projectDir,
        },
        fetchImpl,
      );
    case 'opencode':
      return {
        ok: false,
        reason: 'invalid-payload',
        detail: 'opencode is terminal-only; launch via requestTerminalLaunch',
      };
    default: {
      const _exhaustive: never = payload.target;
      return {
        ok: false,
        reason: 'invalid-payload',
        detail: `unknown target: ${String(_exhaustive)}`,
      };
    }
  }
}

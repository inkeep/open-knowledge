/**
 * Single outbound-dispatch entry point for the Open-in-Agent dropdown.
 *
 * Renderer-side responsibilities are minimal:
 *   1. Build the target's URL via the per-target builder
 *      (`buildClaudeUrl`, `buildCodexUrl`, `buildCursorUrl`).
 *   2. POST the URL (plus `workspacePath` for Cursor) to `/api/handoff`.
 *
 * The server owns the entire recipe — quit, spawn `open -a` / `cursor`,
 * settle, fire URL. One source of truth (`handoff-dispatch-api.ts`) covers
 * both web-host and Electron-host renderers because the renderer's `fetch`
 * works identically against the embedded server in either mode.
 *
 * Adding a 5th target is a 3-step change:
 *   (1) Append the recipe to `RECIPES` in `handoff-dispatch-api.ts`.
 *   (2) Add a URL builder under `packages/core/src/handoff/`.
 *   (3) Add the switch case below.
 */

import {
  buildClaudeUrl,
  buildCodexUrl,
  buildCursorUrl,
  type HandoffOutcome,
  type HandoffPayload,
  type HandoffTarget,
} from '@inkeep/open-knowledge-core';

interface DispatchHandoffDeps {
  /** Test seam — defaults to `globalThis.fetch`. */
  readonly fetch?: typeof globalThis.fetch;
}

interface HandoffRequestBody {
  readonly target: HandoffTarget;
  readonly url: string;
  /** Cursor only — passed to `cursor <path>` step 1. */
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
    // Older OK server without /api/handoff registered — surface as
    // not-installed so the dispatch UX matches "this transport doesn't
    // exist here yet" rather than a generic dispatch failure.
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

/** Route a `HandoffPayload` to its per-target dispatch primitive. */
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
      // Terminal-only target: OpenCode has no URL scheme and is launched via
      // `requestTerminalLaunch` (the terminal-CLI path), never the deep-link
      // dispatch here. Defensive — no production caller routes opencode through
      // `dispatchHandoff` (it is excluded from `VISIBLE_TARGETS`).
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

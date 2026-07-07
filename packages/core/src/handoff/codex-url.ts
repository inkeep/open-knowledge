import type { HandoffPayload } from './types.ts';

/**
 * Build a `codex://new?...` URL for OpenAI Codex Desktop.
 *
 * Emits the prompt + path shape when a prompt is present:
 *
 *   codex://new?prompt=<encoded prompt>&path=<projectDir>
 *
 * The empty-prompt sub-branch is a defensive fallback that drops `prompt=`
 * and emits cwd-only:
 *
 *   codex://new?path=<projectDir>
 *
 * **Prompt threading applies to ALL scopes** (file / folder / project) — the
 * dispatch hook composes the right scope-specific prompt and threads it
 * through `payload.prompt`; the builder doesn't branch on scope. The
 * precedent #25 invariant ("agent grounds via OK MCP, not native attach")
 * is preserved by virtue of the URL never carrying file content / a `file=`
 * attach param — the prompt is a short directive only. `docPath` is never
 * threaded — Codex's URL scheme has no atomic file param.
 */
export function buildCodexUrl(payload: HandoffPayload): string {
  const path = encodeURIComponent(payload.projectDir);
  if (payload.prompt === '') {
    return `codex://new?path=${path}`;
  }
  const prompt = encodeURIComponent(payload.prompt);
  return `codex://new?prompt=${prompt}&path=${path}`;
}

import type { HandoffPayload } from './types.ts';

/**
 * The precedent #60 invariant ("agent grounds via OK MCP, not native attach") is preserved by
 * virtue of the URL never carrying file content / a `file=` attach param — the prompt is a short
 * directive only.
 */
export function buildCodexUrl(payload: HandoffPayload): string {
  const path = encodeURIComponent(payload.projectDir);
  if (payload.prompt === '') {
    return `codex://new?path=${path}`;
  }
  const prompt = encodeURIComponent(payload.prompt);
  return `codex://new?prompt=${prompt}&path=${path}`;
}

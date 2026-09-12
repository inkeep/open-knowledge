import type { HandoffPayload } from './types.ts';

/**
 * The precedent #60 invariant ("agent grounds via OK MCP, not native attach") is preserved by
 * virtue of the URL never carrying file content / `file=` attach param — the prompt is a short
 * directive only.
 */
export function buildClaudeUrl(opts: { mode: 'cowork' | 'code' }, payload: HandoffPayload): string {
  const folder = encodeURIComponent(payload.projectDir);
  if (payload.prompt === '') {
    return `claude://${opts.mode}/new?folder=${folder}`;
  }
  const q = encodeURIComponent(payload.prompt);
  return `claude://${opts.mode}/new?q=${q}&folder=${folder}`;
}

import type { HandoffPayload } from './types.ts';

function basename(p: string): string {
  const idx = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return idx < 0 ? p : p.substring(idx + 1);
}

/**
 * The precedent #60 invariant ("agent grounds via OK MCP, not native attach") is preserved by
 * virtue of the URL never carrying file content / a `file=` attach param — the prompt is a short
 * directive only.
 */
export function buildCursorUrl(payload: HandoffPayload): string {
  const workspace = encodeURIComponent(basename(payload.projectDir));
  if (payload.prompt === '') {
    return `cursor://anysphere.cursor-deeplink/prompt?workspace=${workspace}&mode=agent`;
  }
  const text = encodeURIComponent(encodeURIComponent(payload.prompt));
  return `cursor://anysphere.cursor-deeplink/prompt?text=${text}&workspace=${workspace}&mode=agent`;
}

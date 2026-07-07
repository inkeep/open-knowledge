import type { HandoffPayload } from './types.ts';

/**
 * Path-separator-agnostic basename — core is "no Node APIs" so
 * `path.basename` is unavailable. Returns input unchanged if no separator.
 */
function basename(p: string): string {
  const idx = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return idx < 0 ? p : p.substring(idx + 1);
}

/**
 * Build Cursor's step-2 prompt URL. Step 1 (`cursor <workspacePath>` spawn to
 * focus the workspace window) is owned by the `cli-binary` recipe in
 * `handoff-dispatch-api.ts`, which delegates to `spawn-cursor-api.ts`.
 *
 * Emits the prompt + workspace shape when a prompt is present:
 *
 *   cursor://anysphere.cursor-deeplink/prompt?text=<double-enc prompt>&workspace=<single-enc-basename>&mode=agent
 *
 * The empty-prompt sub-branch is a defensive fallback that drops `text=`
 * and emits cwd-only:
 *
 *   cursor://anysphere.cursor-deeplink/prompt?workspace=<single-enc-basename>&mode=agent
 *
 * `text=` is DOUBLE-encoded: Cursor's router does two decode passes with
 * error recovery on the second. Single-encoding silently corrupts prompts
 * containing substrings that look like valid URL escapes (`%41`, em-dash
 * bytes, pct-encoded URLs in quoted text) — this matches Linear's production
 * rule. `workspace=` is single-encoded basename (Cursor routes by
 * window-name, which is the basename, not the full path).
 *
 * **Prompt threading applies to ALL scopes** (file / folder / project) — the
 * dispatch hook composes the right scope-specific prompt and threads it
 * through `payload.prompt`; the builder doesn't branch on scope. The
 * precedent #25 invariant ("agent grounds via OK MCP, not native attach")
 * is preserved by virtue of the URL never carrying file content / a `file=`
 * attach param — the prompt is a short directive only.
 */
export function buildCursorUrl(payload: HandoffPayload): string {
  const workspace = encodeURIComponent(basename(payload.projectDir));
  if (payload.prompt === '') {
    return `cursor://anysphere.cursor-deeplink/prompt?workspace=${workspace}&mode=agent`;
  }
  const text = encodeURIComponent(encodeURIComponent(payload.prompt));
  return `cursor://anysphere.cursor-deeplink/prompt?text=${text}&workspace=${workspace}&mode=agent`;
}

import type { HandoffPayload } from './types.ts';

/**
 * Build a `claude://cowork/new` or `claude://code/new` URL for the unified
 * Claude Desktop app (Cowork tab or Code/Epitaxy tab).
 *
 * Emits the prompt + folder shape when a prompt is present:
 *
 *   claude://<mode>/new?q=<encoded prompt>&folder=<projectDir>
 *
 * The empty-prompt sub-branch is a defensive fallback that drops `q=` and
 * emits cwd-only:
 *
 *   claude://<mode>/new?folder=<projectDir>
 *
 * **Prompt threading applies to ALL scopes** (file / folder / project) — the
 * dispatch hook composes the right scope-specific prompt (file directive,
 * folder directive, or project directive) and threads it through
 * `payload.prompt`; the builder doesn't branch on scope. The
 * precedent #25 invariant ("agent grounds via OK MCP, not native attach")
 * is preserved by virtue of the URL never carrying file content / `file=`
 * attach param — the prompt is a short directive only.
 *
 * `opts.mode` must agree with `payload.target` ('claude-cowork' → 'cowork',
 * 'claude-code' → 'code'); dispatch.ts enforces the pairing.
 */
export function buildClaudeUrl(opts: { mode: 'cowork' | 'code' }, payload: HandoffPayload): string {
  const folder = encodeURIComponent(payload.projectDir);
  if (payload.prompt === '') {
    return `claude://${opts.mode}/new?folder=${folder}`;
  }
  const q = encodeURIComponent(payload.prompt);
  return `claude://${opts.mode}/new?q=${q}&folder=${folder}`;
}

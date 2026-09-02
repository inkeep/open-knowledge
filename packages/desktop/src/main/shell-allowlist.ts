export const ALLOWED_SCHEMES: ReadonlySet<string> = new Set([
  'https:',
  'http:',
  'mailto:',
  'openknowledge:',

  /**
   * Claude Desktop unified app (Chat + Cowork + Code).
   * OK emits two shapes (single-encoded per `packages/core/src/handoff/claude-url.ts`):
   *   claude://<mode>/new?folder=<enc>                  (doc-scoped: cwd-only, agent grounds via OK MCP per precedent #25)
   *   claude://<mode>/new?q=<enc>&folder=<enc>          (project-scoped: empty-state cards)
   * `<mode>` is `cowork` or `code`. No other paths.
   */
  'claude:',

  /**
   * OpenAI Codex Desktop.
   * OK emits two shapes (single-encoded per `packages/core/src/handoff/codex-url.ts`):
   *   codex://new?path=<enc>                            (doc-scoped: cwd-only, agent grounds via OK MCP per precedent #25)
   *   codex://new?prompt=<enc>&path=<enc>               (project-scoped: empty-state cards)
   * No other paths.
   */
  'codex:',

  /**
   * Cursor IDE.
   * OK emits two shapes (per `packages/core/src/handoff/cursor-url.ts`):
   *   cursor://anysphere.cursor-deeplink/prompt?workspace=<enc>&mode=agent                    (doc-scoped: cwd-only, agent grounds via OK MCP per precedent #25)
   *   cursor://anysphere.cursor-deeplink/prompt?text=<double-enc>&workspace=<enc>&mode=agent  (project-scoped: empty-state cards)
   * `text=` is double-encoded per the two-pass-decode behavior.
   * No other paths.
   */
  'cursor:',
]);

interface AllowlistResult {
  ok: boolean;
  reason?: string;
}

export function checkOutboundUrl(url: string): AllowlistResult {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: 'invalid-url' };
  }
  if (!ALLOWED_SCHEMES.has(parsed.protocol)) {
    return { ok: false, reason: `scheme-not-allowed: ${parsed.protocol}` };
  }
  return { ok: true };
}

export function handleShellOpenExternal(deps: {
  openExternal: (url: string) => Promise<void>;
}): (url: string) => Promise<void> {
  return async (url: string) => {
    const check = checkOutboundUrl(url);
    if (!check.ok) {
      throw new Error(`shell.openExternal blocked: ${check.reason}`);
    }
    await deps.openExternal(url);
  };
}

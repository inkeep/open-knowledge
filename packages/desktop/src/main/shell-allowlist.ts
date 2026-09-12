export const ALLOWED_SCHEMES: ReadonlySet<string> = new Set([
  'https:',
  'http:',
  'mailto:',
  'openknowledge:',

  /**
   * Claude Desktop unified app. OK emits `claude://<mode>/new?folder=<enc>` (doc-scoped) and
   * `claude://<mode>/new?q=<enc>&folder=<enc>` (project-scoped), `<mode>` being `cowork` or `code`;
   * the doc-scoped shape is cwd-only and the agent grounds via OK MCP (precedent #60).
   */
  'claude:',

  /**
   * OK emits two shapes (single-encoded per `packages/core/src/handoff/codex-url.ts`):
   * codex://new?path=<enc> (doc-scoped: cwd-only, agent grounds via OK MCP per precedent #60)
   * codex://new?prompt=<enc>&path=<enc> (project-scoped: empty-state cards) No other paths.
   */
  'codex:',

  /**
   * Cursor IDE. OK emits `cursor://anysphere.cursor-deeplink/prompt?workspace=<enc>&mode=agent`
   * (doc-scoped, cwd-only, the agent grounds via OK MCP per precedent #60) and the same URL with a
   * double-encoded `text=` for project-scoped cards. No other paths.
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

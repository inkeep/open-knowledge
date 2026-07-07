/**
 * Outbound URL scheme allowlist for `shell.openExternal`.
 *
 * Defense-in-depth against the "1-click RCE via OS-native URL schemes" class
 * (Shabarkin 2022 — `ms-msdt:`, `search-ms:`, `ms-officecmd:`, etc.). The
 * exact-set allowlist excludes that class by construction. Outbound payloads
 * come from exactly two sanctioned caller classes: per-target URL-builders in
 * `packages/core/src/handoff/`, and main-built web-search URLs where user
 * text appears only as a percent-encoded query value under a hardcoded
 * scheme+host (`spellcheck-context-menu.ts`). Never a user-supplied raw URL —
 * this scheme-only gate is NOT sufficient for those (it allows `http:`,
 * `mailto:`, agent deep-links, etc.).
 *
 * Pure module — no Electron import — so unit tests exercise it without an
 * Electron BrowserWindow.
 */

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

/**
 * Validate a URL string against the outbound-scheme allowlist.
 * Returns `{ ok: true }` if allowed, `{ ok: false, reason }` otherwise.
 */
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

/**
 * Pure shell.openExternal bridge-handler factory. Returns an async handler
 * that throws on disallowed schemes and calls `openExternal` on allowed ones.
 * Separated from `index.ts`'s IPC wiring so the check-and-delegate contract
 * can be unit-tested without an Electron runtime.
 */
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

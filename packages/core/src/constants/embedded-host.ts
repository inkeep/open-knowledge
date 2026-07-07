export type EmbeddedHost = 'cursor' | 'codex' | 'claude-desktop' | null;

// UA tokens were hand-validated for Cursor + Codex
// (3 live sessions each) and inferred for Claude Desktop from asar invariants
// (`setUserAgent=0` + Electron default UA template). The parenthetical-tolerant
// form `(?:\([^)]+\))?` is mandatory — it absorbs flavor bumps (`Codex(Dev)/`,
// `Cursor(Beta)/`, `Claude(Canary)/`) the bare token regex would miss
// . All three tokens collapse to `claude-desktop` for the
// Claude family because the renderer cannot distinguish Code-pane vs
// Cowork-pane vs Chat-pane — `EmbeddedHost` is app-granular only.
//
// Future-host caveat: if a future `EditorId.claude`-class webview ships (e.g.
// a `@anthropic-ai/claude-code` VS Code extension with an embedded webview
// that sets its own `Claude/<version>` UA token), this regex would
// mis-classify it as `'claude-desktop'`. When that ships, give it its own
// `EmbeddedHost` variant and UA pattern. (`EditorId.claude` in
// `constants/editors.ts` is the CLI surface today — not a webview host.)
// Single source of truth for the per-app UA regexes. Both this client-side
// detector and the server-side `/api/__embed-detect` probe
// (`packages/server/src/embed-probe.ts`) consume these so the two answers to
// "is this Cursor / Codex / Claude?" cannot drift apart.
export const UA_PATTERNS = {
  cursor: /\bCursor(?:\([^)]+\))?\/\d/,
  codex: /\bCodex(?:\([^)]+\))?\/\d/,
  'claude-desktop': /\bClaude(?:\([^)]+\))?\/\d/,
} as const satisfies Record<NonNullable<EmbeddedHost>, RegExp>;

export function detectEmbeddedHostFromBrowser(): EmbeddedHost {
  if (typeof navigator === 'undefined') return null;
  const ua = navigator.userAgent;
  for (const [host, pattern] of Object.entries(UA_PATTERNS)) {
    if (pattern.test(ua)) return host as NonNullable<EmbeddedHost>;
  }
  return null;
}

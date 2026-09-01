export type EmbeddedHost = 'cursor' | 'codex' | 'claude-desktop' | null;

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

/**
 * Outbound `Referer` rewrite for third-party embed iframes that gate the
 * embedding origin (YouTube, primarily).
 *
 * ── Why ─────────────────────────────────────────────────────────────────
 *
 * YouTube's embed iframe player validates the embedding origin via the
 * `Referer` request header against the video owner's allowlist (when
 * set) AND against a general "is this a real web origin" gate. In the
 * Electron renderer:
 *
 *   - **Dev mode** loads via `loadURL(rendererDevUrl)` → an
 *     `http://localhost:<port>` origin → YouTube receives a normal
 *     Referer and accepts the embed.
 *   - **Packaged mode** loads via `loadFile(rendererEntryPath)` → a
 *     `file://` origin. Combined with the `<iframe>`'s
 *     `referrerPolicy="strict-origin-when-cross-origin"` (the
 *     react-lite-youtube-embed default, deliberately pinned for the
 *     allowlist gate), the browser sends `Referer: null` on the cross-
 *     origin request to `youtube.com` — YouTube treats that as an
 *     unknown embedding origin and returns
 *     `Error 153: Video player configuration error`.
 *
 * Intercepting the outbound request at the session layer and rewriting
 * `Referer` to a real HTTPS origin lets the iframe player accept the
 * embed exactly as it does in dev mode + on the web. Same pattern
 * production Electron apps (Notion, Obsidian, Logseq) use for the same
 * YouTube-in-`file://` problem.
 *
 * ── Why \`https://inkeep.com/\` ──────────────────────────────────────────
 *
 * The header value needs to be:
 *   - A real `https://` origin (YouTube rejects `file://`, `app://`,
 *     and empty Referers).
 *   - Stable across builds (no per-version drift would force re-listing
 *     in any video owner's embed allowlist).
 *   - Attributable to this app (the value is exposed in YouTube's
 *     analytics dashboards under "Embedded on" — a generic value like
 *     `https://www.google.com/` would be dishonest signal-noise for
 *     creators).
 *
 * \`https://inkeep.com/\` is the canonical Inkeep-controlled domain — a
 * real, stable, attributable origin.
 *
 * ── Scope ───────────────────────────────────────────────────────────────
 *
 * YouTube only for now. Vimeo + Loom embed iframes don't gate on
 * Referer the same way (their iframes accept any embedding origin
 * including \`file://\`), so they don't need the rewrite. If a report
 * comes in that Vimeo's iframe also fails in packaged builds, extend
 * \`EMBED_HOST_PATTERNS\` with \`player.vimeo.com\` and add a regression
 * test — the rewrite logic is provider-agnostic.
 */

const EMBED_REFERER = 'https://inkeep.com/';

/**
 * Electron \`webRequest\` URL patterns matching the third-party embed
 * iframes that need the Referer rewrite. \`*.\` matches any subdomain so
 * \`www.youtube.com\`, \`m.youtube.com\`, \`youtube.com\` (bare host —
 * Electron's pattern matcher treats it as a host) and the
 * privacy-enhanced \`youtube-nocookie.com\` all hit the rewrite.
 */
const EMBED_HOST_PATTERNS: readonly string[] = [
  'https://*.youtube.com/*',
  'https://youtube.com/*',
  'https://*.youtube-nocookie.com/*',
  'https://youtube-nocookie.com/*',
];

/**
 * Pure header-rewrite — separated from the Electron \`webRequest\`
 * binding so the rewrite behavior is unit-testable without touching
 * \`session.defaultSession\`.
 *
 * Replaces (or sets) the \`Referer\` header to a real HTTPS origin so
 * YouTube's embed player accepts the request. All other headers are
 * preserved unchanged. The rewrite is idempotent: subsequent calls on
 * the already-rewritten headers produce the same output.
 *
 * Header-name casing — Electron's \`webRequest.HttpHeaders\` is
 * case-insensitive on read but preserves the casing of the last write,
 * and downstream HTTP libs vary on which they emit. To avoid leaving a
 * stale lowercase \`referer\` alongside our title-case \`Referer\` (which
 * some libs would then concatenate or treat as two distinct headers),
 * the rewrite explicitly deletes any existing casing before setting the
 * canonical \`Referer\` once.
 */
export function rewriteEmbedRequestHeaders(
  headers: Record<string, string | string[]>,
): Record<string, string | string[]> {
  const next: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === 'referer') continue;
    next[name] = value;
  }
  next.Referer = EMBED_REFERER;
  return next;
}

export { EMBED_HOST_PATTERNS, EMBED_REFERER };

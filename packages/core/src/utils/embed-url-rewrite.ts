/**
 * Rewrite well-known video-host watch URLs into their frame-embeddable
 * counterparts so the generic `<Embed>` iframe can actually load them.
 *
 * The `<Embed>` component is a thin sandboxed iframe wrapper for arbitrary
 * URLs. The user-facing URLs for the major video hosts
 * (`youtube.com/watch?v=…`, `vimeo.com/<id>`, `loom.com/share/<id>`) all
 * refuse to be framed via `X-Frame-Options: SAMEORIGIN` / `Content-Security-Policy:
 * frame-ancestors`, so the iframe renders blank when an agent (or an
 * author who hasn't memorized the embed-URL shape) pastes the URL bar's
 * copy. Rewriting at the render boundary fixes the symptom without
 * touching the source markdown — the descriptor's `src` prop still holds
 * the original URL, only the in-flight iframe `src` changes.
 *
 * For YouTube the native `<video>` block is the better tool (it routes
 * through `react-lite-youtube-embed`'s click-facade, which handles
 * autoplay heuristics + nocookie hosts correctly). The palette steers
 * agents that way; this helper exists for the legacy / non-canonical
 * authoring path where an `<Embed>` already shipped.
 *
 * Returns the rewritten URL when a rewrite applies; returns the input
 * unchanged otherwise (including non-string / non-URL inputs — callers
 * pass values directly through). Pure — no DOM, no React.
 */

import { parseLoomUrl } from './loom-embed.ts';
import { isVimeoUrl } from './vimeo-embed.ts';
import { parseYouTubeUrl } from './youtube-embed.ts';

/**
 * Vimeo numeric ID extracted from any of the recognized URL shapes
 * (`vimeo.com/<id>`, `player.vimeo.com/video/<id>`). Returns `null` when
 * the URL is a Vimeo host but the ID can't be located (channels /
 * showcase / group pages — these have no per-video iframe equivalent
 * so we leave the original URL alone and let the iframe fail visibly).
 */
function extractVimeoVideoId(rawUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  // `player.vimeo.com/video/<id>` is already the embed URL — return the
  // id so callers can short-circuit the rewrite, leaving the URL as-is.
  const playerMatch = url.pathname.match(/^\/video\/(\d+)/);
  if (playerMatch) return playerMatch[1] ?? null;
  // Canonical `vimeo.com/<id>` (and `vimeo.com/<id>/<hash>` for unlisted
  // videos — hash isn't needed by the embed iframe).
  const canonicalMatch = url.pathname.match(/^\/(\d+)/);
  if (canonicalMatch) return canonicalMatch[1] ?? null;
  return null;
}

/**
 * Rewrite a watch URL into a frame-embeddable URL when the host is one
 * of the recognized video providers. Returns `src` unchanged when no
 * rewrite applies — `<Embed>` callers can blindly forward the return
 * value to the iframe `src` attribute.
 *
 *   - YouTube: `youtube.com/watch?v=ID` / `youtu.be/ID` / `youtube.com/shorts/ID`
 *     → `youtube[-nocookie].com/embed/ID?start=<seconds>`
 *   - Vimeo:   `vimeo.com/ID` → `player.vimeo.com/video/ID`
 *   - Loom:    `loom.com/share/ID` → `loom.com/embed/ID?t=<raw>`
 *   - Anything else: returned unchanged.
 */
export function rewriteEmbedUrl(src: string | undefined): string | undefined {
  if (typeof src !== 'string' || src.length === 0) return src;

  const yt = parseYouTubeUrl(src);
  if (yt) {
    const host = yt.noCookie ? 'www.youtube-nocookie.com' : 'www.youtube.com';
    const query = yt.startSeconds !== null ? `?start=${yt.startSeconds}` : '';
    return `https://${host}/embed/${yt.id}${query}`;
  }

  if (isVimeoUrl(src)) {
    const id = extractVimeoVideoId(src);
    if (id) return `https://player.vimeo.com/video/${id}`;
    // Vimeo host but unrecognized URL shape (channel / group / showcase
    // pages). Leave as-is; the iframe will fail visibly and the author
    // can switch to the canonical video URL.
    return src;
  }

  const loom = parseLoomUrl(src);
  if (loom) {
    const query = loom.startRaw !== null ? `?t=${loom.startRaw}` : '';
    return `https://www.loom.com/embed/${loom.id}${query}`;
  }

  return src;
}

/**
 * True iff `rewriteEmbedUrl(src)` would actually change the URL. Used
 * by callers that want to surface a "this URL was rewritten" affordance
 * (a chip badge, a tooltip) without recomputing the rewrite twice.
 */
export function isEmbedUrlRewritable(src: string): boolean {
  return rewriteEmbedUrl(src) !== src;
}

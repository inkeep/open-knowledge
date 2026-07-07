/**
 * Detect a YouTube URL and extract its structured pieces (`parseYouTubeUrl`)
 * or directly produce the canonical `/embed/<id>` URL (`youtubeEmbedUrl`,
 * a thin wrapper).
 *
 * Returns `null` when `src` is not recognizable as YouTube — the caller
 * (`Video` component, paste handler, etc.) can then fall through to its
 * default behavior (HTML5 `<video>` for direct media files, "invalid src"
 * placeholder, etc.). This keeps URL sniffing scoped to "is this YouTube?"
 * — every other host stays out of the dispatch.
 *
 * Accepted input shapes:
 *   - `https://www.youtube.com/watch?v=<ID>`         (canonical web)
 *   - `https://youtube.com/watch?v=<ID>`             (canonical web, no www)
 *   - `https://m.youtube.com/watch?v=<ID>`           (mobile web)
 *   - `https://youtu.be/<ID>`                        (short link)
 *   - `https://www.youtube.com/shorts/<ID>`          (Shorts)
 *   - `https://www.youtube.com/embed/<ID>`           (already embed)
 *   - `https://www.youtube.com/v/<ID>`               (old player URL — still in wild)
 *   - `https://www.youtube-nocookie.com/embed/<ID>`  (privacy-enhanced)
 *
 * Timestamps are preserved through the conversion. Both `?t=42`,
 * `?t=42s`, `?t=1m30s`, and `?start=42` are accepted on input; the output
 * always uses `?start=<seconds>` which is what `/embed/` URLs honor. The
 * `1m30s` form is parsed by splitting on the `h` / `m` / `s` suffix
 * tokens so "2h3m4s" → 7384 seconds.
 *
 * Video IDs are validated against the YouTube `[A-Za-z0-9_-]{11}`
 * grammar — anything that doesn't match returns `null` so a malformed
 * URL can't smuggle an arbitrary path into the iframe. Host is validated
 * against an allowlist so subdomain spoofing (`youtube.com.attacker.example`)
 * doesn't slip through.
 */

const YOUTUBE_VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

// Hosts we recognize as YouTube — youtube.com, youtu.be, m.youtube.com,
// youtube-nocookie.com. The privacy-preserving `youtube-nocookie.com` is
// accepted because it's literally YouTube's own embed-friendly host
// (`/embed/<id>` works there too) and authors who paste it want the
// privacy posture preserved on render.
function isYouTubeHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return (
    h === 'youtube.com' ||
    h === 'www.youtube.com' ||
    h === 'm.youtube.com' ||
    // `music.youtube.com` watch URLs use the same video-id system and
    // `/embed/<id>` works against the canonical host. Without this entry,
    // the validator (`validateMediaUrl`) accepts music URLs via its
    // `endsWith('.youtube.com')` rule, but the renderer fails to detect
    // the host here, falls back to the native `<video>` element, and the
    // browser silently fails to load the watch page. Add to keep
    // validator and renderer in lock-step.
    h === 'music.youtube.com' ||
    h === 'youtu.be' ||
    h === 'youtube-nocookie.com' ||
    h === 'www.youtube-nocookie.com'
  );
}

// Parse a YouTube timestamp query value (`?t=` / `?start=`) to integer
// seconds. Accepts plain integer strings (`42`, `42s`) and the colon-free
// `<H>h<M>m<S>s` shorthand (`1h2m3s`, `2m30s`, `45s`). Returns `null` for
// unparseable input rather than NaN so the caller's `?? ''` fall-through
// preserves a clean URL.
function parseTimestampToSeconds(raw: string): number | null {
  if (raw.length === 0) return null;
  // Plain integer fast path — `?t=42` is common. The `> 0` guard mirrors
  // the composite-path floor below so `?t=0` and `?t=0s` converge on the
  // same null-and-skip result; YouTube ignores `?start=0` so the clean
  // URL is the better serialization.
  if (/^[0-9]+$/.test(raw)) {
    const n = Number.parseInt(raw, 10);
    return n > 0 ? n : null;
  }
  const match = raw.match(/^(?:([0-9]+)h)?(?:([0-9]+)m)?(?:([0-9]+)s?)?$/);
  if (!match) return null;
  const hours = match[1] ? Number.parseInt(match[1], 10) : 0;
  const minutes = match[2] ? Number.parseInt(match[2], 10) : 0;
  const seconds = match[3] ? Number.parseInt(match[3], 10) : 0;
  const total = hours * 3600 + minutes * 60 + seconds;
  return total > 0 ? total : null;
}

// Extract the video ID from a parsed YouTube URL's pathname + query.
// Returns null for any shape that doesn't yield exactly 11 ID chars.
function extractVideoId(url: URL): string | null {
  const host = url.hostname.toLowerCase();
  // `youtu.be/<ID>` — the ID is the first path segment.
  if (host === 'youtu.be') {
    const id = url.pathname.replace(/^\//, '').split('/')[0] ?? '';
    return YOUTUBE_VIDEO_ID_RE.test(id) ? id : null;
  }
  // `youtube.com/watch?v=<ID>` — the ID lives in `?v=`.
  if (url.pathname === '/watch') {
    const id = url.searchParams.get('v') ?? '';
    return YOUTUBE_VIDEO_ID_RE.test(id) ? id : null;
  }
  // `youtube.com/embed/<ID>` | `/shorts/<ID>` | `/v/<ID>` (old player URL).
  const embedMatch = url.pathname.match(/^\/(?:embed|shorts|v)\/([A-Za-z0-9_-]{11})\/?$/);
  if (embedMatch) {
    return embedMatch[1] ?? null;
  }
  return null;
}

/**
 * Structured parse — for callers that want to render via a facade (e.g.
 * `react-lite-youtube-embed`'s `<LiteYouTubeEmbed id={...} params={...}
 * cookie={...} />`) instead of building the embed URL themselves.
 */
export interface ParsedYouTubeUrl {
  /** 11-char video ID, validated against the YouTube grammar. */
  id: string;
  /** Resolved timestamp in seconds, or `null` when none was present / parseable. */
  startSeconds: number | null;
  /** `true` when the source URL targeted the `youtube-nocookie.com` host. */
  noCookie: boolean;
}

export function parseYouTubeUrl(src: string): ParsedYouTubeUrl | null {
  if (typeof src !== 'string' || src.length === 0) return null;
  let url: URL;
  try {
    url = new URL(src);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (!isYouTubeHost(url.hostname)) return null;

  const id = extractVideoId(url);
  if (!id) return null;

  // Timestamp can arrive as either `?t=` (watch / youtu.be) or `?start=`
  // (embed) — take whichever exists, normalize to integer seconds.
  const tRaw = url.searchParams.get('t') ?? url.searchParams.get('start') ?? '';
  const startSeconds = tRaw.length > 0 ? parseTimestampToSeconds(tRaw) : null;

  const noCookie = url.hostname.toLowerCase().endsWith('youtube-nocookie.com');

  return { id, startSeconds, noCookie };
}

export function youtubeEmbedUrl(src: string): string | null {
  const parsed = parseYouTubeUrl(src);
  if (!parsed) return null;
  // Preserve the privacy-enhanced host when the input used it. Otherwise
  // canonicalize to www.youtube.com — `/embed/<id>` works on both.
  const embedHost = parsed.noCookie ? 'www.youtube-nocookie.com' : 'www.youtube.com';
  const base = `https://${embedHost}/embed/${parsed.id}`;
  return parsed.startSeconds !== null ? `${base}?start=${parsed.startSeconds}` : base;
}

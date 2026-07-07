/**
 * Detect a Loom URL (`isLoomUrl`) and extract its structured pieces
 * (`parseLoomUrl`).
 *
 * Mirrors the shape of `youtube-embed.ts` so the dispatch in
 * `Video.tsx` reads symmetrically across providers. Loom is much simpler
 * than YouTube + Vimeo: no SDK, no oEmbed lookup, no facade — just a
 * direct iframe to `loom.com/embed/<id>?…params`. Returns `null` when
 * `src` isn't recognizable as Loom so the caller can fall through.
 *
 * Accepted input shapes:
 *   - `https://www.loom.com/share/<ID>`   (canonical share link)
 *   - `https://loom.com/share/<ID>`       (no www)
 *   - `https://www.loom.com/embed/<ID>`   (already-embed URL)
 *   - `https://loom.com/embed/<ID>`
 *
 * Timestamps ride on the URL as `?t=<value>`. Loom honors integer
 * seconds (`?t=42`) or the `<H>h<M>m<S>s` shorthand (`?t=2m30s`).
 * The parser validates against that exact grammar and returns `null`
 * on anything else — load-bearing because `URLSearchParams.get('t')`
 * returns the URL-decoded value, so an author-supplied
 * `?t=42%26autoplay%3Dfalse` would otherwise carry a literal
 * `42&autoplay=false` through to the embed URL and silently inject
 * extra Loom params. Rejecting at parse time keeps the iframe URL
 * honest to what `parseLoomUrl` claims to extract.
 *
 * Loom IDs are 32-char lowercase-hex (UUIDs without dashes) in
 * production, but we accept the slightly looser `[A-Za-z0-9]{20,}`
 * grammar to leave room for future ID-format tweaks without breaking
 * existing posts. Host validated against an allowlist so subdomain
 * spoofing (`loom.com.attacker.example`) can't slip through.
 */

const LOOM_ID_RE = /^[A-Za-z0-9]{20,}$/;

// Documented grammar: pure integer seconds (`42`, `42s`) OR
// `<H>h<M>m<S>s` mixed shorthand (`1h2m3s`, `2m30s`, `45s`).
// Anything else fails the parse — see top-of-file comment for why this
// is load-bearing (param-injection prevention).
const LOOM_TIMESTAMP_RE = /^(?:\d+s?|(?:\d+h)?(?:\d+m)?(?:\d+s)?)$/;

function isLoomHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === 'loom.com' || h === 'www.loom.com';
}

function extractLoomId(url: URL): string | null {
  const m = url.pathname.match(/^\/(?:share|embed)\/([A-Za-z0-9]+)\/?$/);
  if (!m) return null;
  const id = m[1] ?? '';
  return LOOM_ID_RE.test(id) ? id : null;
}

export interface ParsedLoomUrl {
  /** Loom video ID, validated against the loose Loom grammar. */
  id: string;
  /** Raw `?t=` query value when present and matches the Loom timestamp
   * grammar, or `null`. Validated by `LOOM_TIMESTAMP_RE` so that
   * embedding it back into the iframe URL can't carry `&`-bearing
   * payloads that would otherwise inject extra Loom params. */
  startRaw: string | null;
}

export function parseLoomUrl(src: string): ParsedLoomUrl | null {
  if (typeof src !== 'string' || src.length === 0) return null;
  let url: URL;
  try {
    url = new URL(src);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (!isLoomHost(url.hostname)) return null;

  const id = extractLoomId(url);
  if (!id) return null;

  const tRaw = url.searchParams.get('t');
  // Empty-string `?t=` and non-existent `?t` collapse to null; everything
  // else must match the documented grammar.
  const startRaw = tRaw && tRaw.length > 0 && LOOM_TIMESTAMP_RE.test(tRaw) ? tRaw : null;

  return { id, startRaw };
}

export function isLoomUrl(src: string): boolean {
  return parseLoomUrl(src) !== null;
}

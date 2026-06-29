
const LOOM_ID_RE = /^[A-Za-z0-9]{20,}$/;

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
  const startRaw = tRaw && tRaw.length > 0 && LOOM_TIMESTAMP_RE.test(tRaw) ? tRaw : null;

  return { id, startRaw };
}

export function isLoomUrl(src: string): boolean {
  return parseLoomUrl(src) !== null;
}

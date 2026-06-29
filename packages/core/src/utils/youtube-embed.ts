
const YOUTUBE_VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

function isYouTubeHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return (
    h === 'youtube.com' ||
    h === 'www.youtube.com' ||
    h === 'm.youtube.com' ||
    h === 'music.youtube.com' ||
    h === 'youtu.be' ||
    h === 'youtube-nocookie.com' ||
    h === 'www.youtube-nocookie.com'
  );
}

function parseTimestampToSeconds(raw: string): number | null {
  if (raw.length === 0) return null;
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

function extractVideoId(url: URL): string | null {
  const host = url.hostname.toLowerCase();
  if (host === 'youtu.be') {
    const id = url.pathname.replace(/^\//, '').split('/')[0] ?? '';
    return YOUTUBE_VIDEO_ID_RE.test(id) ? id : null;
  }
  if (url.pathname === '/watch') {
    const id = url.searchParams.get('v') ?? '';
    return YOUTUBE_VIDEO_ID_RE.test(id) ? id : null;
  }
  const embedMatch = url.pathname.match(/^\/(?:embed|shorts|v)\/([A-Za-z0-9_-]{11})\/?$/);
  if (embedMatch) {
    return embedMatch[1] ?? null;
  }
  return null;
}

export interface ParsedYouTubeUrl {
  id: string;
  startSeconds: number | null;
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

  const tRaw = url.searchParams.get('t') ?? url.searchParams.get('start') ?? '';
  const startSeconds = tRaw.length > 0 ? parseTimestampToSeconds(tRaw) : null;

  const noCookie = url.hostname.toLowerCase().endsWith('youtube-nocookie.com');

  return { id, startSeconds, noCookie };
}

export function youtubeEmbedUrl(src: string): string | null {
  const parsed = parseYouTubeUrl(src);
  if (!parsed) return null;
  const embedHost = parsed.noCookie ? 'www.youtube-nocookie.com' : 'www.youtube.com';
  const base = `https://${embedHost}/embed/${parsed.id}`;
  return parsed.startSeconds !== null ? `${base}?start=${parsed.startSeconds}` : base;
}

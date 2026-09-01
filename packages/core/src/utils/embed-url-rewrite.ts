import { parseLoomUrl } from './loom-embed.ts';
import { isVimeoUrl } from './vimeo-embed.ts';
import { parseYouTubeUrl } from './youtube-embed.ts';

function extractVimeoVideoId(rawUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  const playerMatch = url.pathname.match(/^\/video\/(\d+)/);
  if (playerMatch) return playerMatch[1] ?? null;
  const canonicalMatch = url.pathname.match(/^\/(\d+)/);
  if (canonicalMatch) return canonicalMatch[1] ?? null;
  return null;
}

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
    return src;
  }

  const loom = parseLoomUrl(src);
  if (loom) {
    const query = loom.startRaw !== null ? `?t=${loom.startRaw}` : '';
    return `https://www.loom.com/embed/${loom.id}${query}`;
  }

  return src;
}

export function isEmbedUrlRewritable(src: string): boolean {
  return rewriteEmbedUrl(src) !== src;
}

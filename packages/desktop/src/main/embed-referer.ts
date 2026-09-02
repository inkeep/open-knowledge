const EMBED_REFERER = 'https://inkeep.com/';

const EMBED_HOST_PATTERNS: readonly string[] = [
  'https://*.youtube.com/*',
  'https://youtube.com/*',
  'https://*.youtube-nocookie.com/*',
  'https://youtube-nocookie.com/*',
];

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


function isVimeoHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === 'vimeo.com' || h === 'www.vimeo.com' || h === 'player.vimeo.com';
}

export function isVimeoUrl(src: string): boolean {
  if (typeof src !== 'string' || src.length === 0) return false;
  let url: URL;
  try {
    url = new URL(src);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  return isVimeoHost(url.hostname);
}

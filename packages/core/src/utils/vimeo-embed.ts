/**
 * Detect a Vimeo URL (`isVimeoUrl`).
 *
 * Sibling to `parseYouTubeUrl` but deliberately lighter: the Vimeo dispatch
 * passes the original URL straight through to `@u-wave/react-vimeo`'s
 * `video` prop (which accepts either a numeric ID or a full URL), so we
 * never extract the ID ourselves. The renderer only needs a yes/no answer
 * to "is this a Vimeo URL I should dispatch to the embed component?" — the
 * lib handles every URL shape (canonical, unlisted-hash, `player.vimeo.com`,
 * channels/groups/showcase) plus `#t=` timestamps internally.
 *
 * Host allowlist over `endsWith('vimeo.com')` so subdomain spoofing
 * (`vimeo.com.attacker.example`) doesn't slip through.
 */

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

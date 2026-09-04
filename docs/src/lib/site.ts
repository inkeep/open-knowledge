import { STABLE_DMG_URL } from './download-links';

export const SITE_URL = 'https://openknowledge.ai';

export function absoluteSiteUrl(path: string): string {
  return new URL(path, SITE_URL).href;
}
export const SITE_NAME = 'OpenKnowledge';
export const TWITTER_HANDLE = '@OpenKnowledge';

export const GITHUB_URL = 'https://github.com/inkeep/open-knowledge';
export const DISCORD_URL = 'https://discord.gg/VRKk2EaGHN';
export const CHANGELOG_ROUTE = '/docs/changelog';
export const CHANGELOG_TIMELINE_LIMIT = 30;
export const X_URL = `https://x.com/${TWITTER_HANDLE.slice(1)}`;
export const SITE_DESCRIPTION =
  'Beautiful, AI-native markdown editor for humans and agents. Build knowledge bases, LLM wikis, and agent 2nd brains.';

export const SITE_HEADLINE = 'Beautiful, AI-native markdown IDE and LLM wiki.';

const DESCRIPTION_MAX = 160;

export function metaDescription(
  text: string | null | undefined,
  fallback: string = SITE_DESCRIPTION,
): string {
  const normalized = (text ?? '').replace(/\s+/g, ' ').trim();
  const base = normalized.length > 0 ? normalized : fallback;
  if (base.length <= DESCRIPTION_MAX) return base;
  const slice = base.slice(0, DESCRIPTION_MAX - 1);
  const lastSpace = slice.lastIndexOf(' ');
  const cut = lastSpace > DESCRIPTION_MAX * 0.6 ? slice.slice(0, lastSpace) : slice;
  return `${cut.trimEnd()}…`;
}

export const DOWNLOAD_URL = STABLE_DMG_URL;

const DOWNLOAD_ROUTE = '/download/stable';

export type DownloadCta =
  | 'docs-content'
  | 'docs-sidebar'
  | 'continue-page'
  | 'share-splash-fallback'
  | 'share-splash';

export function downloadRouteForCta(cta: DownloadCta): string {
  return `${DOWNLOAD_ROUTE}?utm_content=${encodeURIComponent(cta)}`;
}

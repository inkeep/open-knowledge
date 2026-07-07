/**
 * Single source of truth for public site identity. Edit values here;
 * avoid re-introducing duplicate string literals at call sites.
 *
 * `SITE_URL` is consumed by sitemap entries, robots.txt sitemap
 * reference, root `metadataBase`, JSON-LD `url` fields, splash-page
 * openGraph.url, and the llms.txt URL list.
 *
 * `SITE_NAME` + `SITE_DESCRIPTION` feed root metadata, JSON-LD, and the
 * SoftwareApplication schema on the home page.
 */
import { STABLE_DMG_URL } from './download-links';

export const SITE_URL = 'https://openknowledge.ai';
export const SITE_NAME = 'OpenKnowledge';
/** Official X/Twitter handle, used for `twitter:site` card attribution. */
export const TWITTER_HANDLE = '@OpenKnowledge';

/**
 * Single source for the public social/community links surfaced in the nav,
 * footer, JSON-LD `sameAs`, and the search widget's "get help" options. Edit
 * here; don't re-introduce the literal URLs at call sites.
 *
 * `X_URL` derives from {@link TWITTER_HANDLE} so the handle stays the one place
 * the account name lives. The GitHub *repo* link is the community/source entry
 * point — release-asset and releases-page URLs are a separate concern owned by
 * `download-links.ts`.
 */
export const GITHUB_URL = 'https://github.com/inkeep/open-knowledge';
export const DISCORD_URL = 'https://discord.com/invite/YujKpFN49';
export const X_URL = `https://x.com/${TWITTER_HANDLE.slice(1)}`;
export const SITE_DESCRIPTION =
  'An agent-native knowledge platform where humans and AI co-create. Real-time CRDT editing, markdown-native, connected to any AI agent via MCP.';

/**
 * Primary marketing headline. Single source for the homepage hero and the
 * default OpenGraph card so the two never drift.
 */
export const SITE_HEADLINE = 'Beautiful, AI-native markdown editor.';

/**
 * Upper bound for `og:description` / meta descriptions. OG/SEO analysers flag
 * descriptions past ~160 chars as truncated in search/social previews.
 */
const DESCRIPTION_MAX = 160;

/**
 * Normalize a meta description for `og:description` and friends: collapse
 * whitespace, fall back to {@link SITE_DESCRIPTION} when empty (so analysers
 * never see a missing/too-short value), and truncate over-long text at a word
 * boundary with an ellipsis.
 */
export function metaDescription(
  text: string | null | undefined,
  fallback: string = SITE_DESCRIPTION,
): string {
  const normalized = (text ?? '').replace(/\s+/g, ' ').trim();
  const base = normalized.length > 0 ? normalized : fallback;
  if (base.length <= DESCRIPTION_MAX) return base;
  const slice = base.slice(0, DESCRIPTION_MAX - 1);
  const lastSpace = slice.lastIndexOf(' ');
  // Prefer a word boundary, but only if it doesn't lop off too much.
  const cut = lastSpace > DESCRIPTION_MAX * 0.6 ? slice.slice(0, lastSpace) : slice;
  return `${cut.trimEnd()}…`;
}

/**
 * The real macOS DMG file URL. Kept for the SoftwareApplication JSON-LD
 * `downloadUrl` (schema.org wants the actual asset, not a redirect) and
 * anywhere a literal file link is needed. User-facing CTAs link
 * {@link DOWNLOAD_ROUTE} instead, so each click flows through the tracked
 * redirect — see {@link STABLE_DMG_URL}.
 */
export const DOWNLOAD_URL = STABLE_DMG_URL;

/**
 * Tracked stable-download route (`openknowledge.ai/download/stable`). Marketing
 * CTAs and the `DownloadButton` link here so every download fires a
 * `dmg_downloaded` event before the 302 to GitHub.
 */
export const DOWNLOAD_ROUTE = '/download/stable';

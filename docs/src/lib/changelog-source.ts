import { loader, type MetaData, type Source } from 'fumadocs-core/source';
import { loadStableReleases, type ReleaseNote } from '@/lib/releases';
import { CHANGELOG_TIMELINE_LIMIT } from '@/lib/site';

/**
 * Build-time Fumadocs source adapter for `/docs/changelog`.
 *
 * The changelog has no bespoke committed artifact: this adapter reads the CLI
 * package's CHANGELOG.md at build time (see `loadStableReleases`) and turns it into
 * a Fumadocs `Source`. A stable release refreshes it because the `main-reset`
 * commit that rewrites CHANGELOG.md is a push to the repo the docs build from.
 * Publish dates come from a small best-effort GitHub API call; the content does
 * not depend on the network.
 *
 * The source emits two kinds of page:
 *   - the index (`/docs/changelog`, slugs `[]`) carrying the newest
 *     `CHANGELOG_TIMELINE_LIMIT` releases — the timeline the site renders. The cap
 *     keeps the timeline bounded as releases accumulate; older releases stay
 *     reachable via their own pages below, not the timeline.
 *   - one page per release (`/docs/changelog/<tag>`, slugs `[<tag>]`), each a real
 *     static URL, for EVERY stable release (not just the timeline's window). They
 *     are deliberately NOT the only link — each timeline entry links to its page —
 *     so every version keeps its own indexable URL in the sitemap for search
 *     engines even after it scrolls off the timeline. The `[tag]` route and
 *     `sitemap.ts` enumerate them via `getPages()`.
 *
 * `loader()` is synchronous, so the async load is resolved here first and the built
 * `Source` handed to it. Callers `await` this inside static
 * (`dynamic = 'force-static'`) routes, so it runs once at build time and the output
 * is baked into static HTML — fully indexable, no runtime dependency.
 *
 * Memoized as a module-level promise (NOT React `cache()`, which only dedupes within
 * a single render): a build prerenders the index, the RSS feed, and one page per
 * release — each a separate render that would otherwise re-read the file and re-run
 * the date lookup. The singleton collapses them to ONE load per build worker.
 */

/**
 * Data carried by a changelog virtual page. The index page holds the whole window;
 * a per-release page holds just its own release (`releases[0]`).
 */
export interface ChangelogPageData {
  title: string;
  releases: ReleaseNote[];
}

export type ChangelogSource = Awaited<ReturnType<typeof getChangelogSource>>;

let cachedSource: ReturnType<typeof buildChangelogSource> | undefined;

export function getChangelogSource() {
  cachedSource ??= buildChangelogSource();
  return cachedSource;
}

async function buildChangelogSource() {
  // `loadStableReleases` returns [] only when CHANGELOG.md is absent (the public
  // mirror excludes it), and throws if the file is present but malformed — so an
  // empty list here is the legitimate mirror case and builds an empty changelog.
  const releases = await loadStableReleases();
  return loader({ baseUrl: '/docs/changelog', source: buildChangelogSourceFiles(releases) });
}

/**
 * Assemble the Fumadocs `Source` from resolved releases. Pure and network-free
 * (mirrors `pickStableReleases`) so the timeline-window cap vs. full-page-set
 * split is unit-testable without a GitHub fetch.
 *
 * The index page carries only the newest `CHANGELOG_TIMELINE_LIMIT` releases (the
 * timeline); a per-release page is emitted for EVERY release, so the sitemap and
 * `[tag]` routes stay complete no matter how many releases scroll off the
 * timeline.
 */
export function buildChangelogSourceFiles(
  releases: ReleaseNote[],
): Source<{ pageData: ChangelogPageData; metaData: MetaData }> {
  return {
    files: [
      {
        type: 'page',
        path: 'index.mdx',
        slugs: [],
        data: { title: 'Changelog', releases: releases.slice(0, CHANGELOG_TIMELINE_LIMIT) },
      },
      ...releases.map((release) => ({
        type: 'page' as const,
        path: `${release.tag}.mdx`,
        slugs: [release.tag],
        data: { title: release.title, releases: [release] },
      })),
    ],
  };
}

/** Every per-release page (slug `[<tag>]`), excluding the index — the sitemap set. */
export function getReleasePages(source: ChangelogSource) {
  return source.getPages().filter((page) => page.slugs.length === 1);
}

import { loader, type MetaData, type Source } from 'fumadocs-core/source';
import { loadStableReleases, type ReleaseNote } from '@/lib/releases';
import { CHANGELOG_TIMELINE_LIMIT } from '@/lib/site';

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
  const releases = await loadStableReleases();
  return loader({ baseUrl: '/docs/changelog', source: buildChangelogSourceFiles(releases) });
}

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

export function getReleasePages(source: ChangelogSource) {
  return source.getPages().filter((page) => page.slugs.length === 1);
}

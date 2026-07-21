import { describe, expect, test } from 'vitest';
import { buildChangelogSourceFiles } from './changelog-source.ts';
import type { ReleaseNote } from './releases.ts';
import { CHANGELOG_TIMELINE_LIMIT } from './site.ts';

function note(tag: string): ReleaseNote {
  return {
    tag,
    title: tag,
    publishedAt: '2026-07-01T00:00:00Z',
    bodyHtml: `<p>${tag}</p>`,
    htmlUrl: `https://github.com/inkeep/open-knowledge/releases/tag/${tag}`,
  };
}

type Files = ReturnType<typeof buildChangelogSourceFiles>['files'];
type PageFile = Extract<Files[number], { type: 'page' }>;

const isPage = (f: Files[number]): f is PageFile => f.type === 'page';

/** All page files with a single slug segment — the per-release `[tag]` pages. */
function releasePages(files: Files): PageFile[] {
  return files.filter(isPage).filter((f) => f.slugs?.length === 1);
}

/** The lone index page (slugs `[]`). */
function indexPage(files: Files): PageFile | undefined {
  return files.filter(isPage).find((f) => f.slugs?.length === 0);
}

describe('buildChangelogSourceFiles', () => {
  test('caps the index timeline but emits a page for every release', () => {
    const releases = Array.from({ length: CHANGELOG_TIMELINE_LIMIT + 12 }, (_, i) =>
      note(`v0.${i}.0`),
    );
    const { files } = buildChangelogSourceFiles(releases);

    // Timeline is capped...
    expect(indexPage(files)?.data.releases).toHaveLength(CHANGELOG_TIMELINE_LIMIT);
    // ...but every release keeps its own indexable page (sitemap/[tag] stay complete).
    expect(releasePages(files)).toHaveLength(releases.length);
  });

  test('shows the NEWEST releases on the timeline (fetch is already newest-first)', () => {
    const releases = Array.from({ length: CHANGELOG_TIMELINE_LIMIT + 5 }, (_, i) =>
      note(`v0.${i}.0`),
    );
    const shown = indexPage(buildChangelogSourceFiles(releases).files)?.data.releases ?? [];
    expect(shown[0]?.tag).toBe('v0.0.0');
    expect(shown.at(-1)?.tag).toBe(`v0.${CHANGELOG_TIMELINE_LIMIT - 1}.0`);
  });

  test('does not cap when there are fewer releases than the limit', () => {
    const releases = [note('v1.0.0'), note('v0.9.0')];
    const { files } = buildChangelogSourceFiles(releases);
    expect(indexPage(files)?.data.releases).toHaveLength(2);
    expect(releasePages(files)).toHaveLength(2);
  });
});

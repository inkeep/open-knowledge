import { describe, expect, test } from 'vitest';
import { collectDates, fetchReleaseDates, parseChangelog } from './releases.ts';

const SAMPLE = `# @inkeep/open-knowledge

## 0.35.0

### Minor Changes

- 3c124b0: Added the command palette.

### Patch Changes

- 6681a97: Fixed a clone bug.

## 0.34.0

### Patch Changes

- 95380ab: Recorded the server exit reason.

## 0.9.1

### Patch Changes

- deadbeef: Old release.
`;

describe('parseChangelog', () => {
  test('parses each version section, newest first (file order)', () => {
    const out = parseChangelog(SAMPLE);
    expect(out.map((r) => r.tag)).toEqual(['v0.35.0', 'v0.34.0', 'v0.9.1']);
  });

  test('derives tag, title, and htmlUrl from the version', () => {
    const [first] = parseChangelog(SAMPLE);
    expect(first.tag).toBe('v0.35.0');
    expect(first.title).toBe('v0.35.0');
    expect(first.htmlUrl).toBe('https://github.com/inkeep/open-knowledge/releases/tag/v0.35.0');
  });

  test('strips the changeset commit-hash prefix and renders GFM to HTML', () => {
    const [first] = parseChangelog(SAMPLE);
    expect(first.bodyHtml).toContain('<h3');
    expect(first.bodyHtml).toContain('<li>Added the command palette.</li>');
    expect(first.bodyHtml).not.toContain('3c124b0');
  });

  test('injects dates by tag; missing tags get null', () => {
    const dates = new Map([['v0.35.0', '2026-07-20T13:57:49Z']]);
    const out = parseChangelog(SAMPLE, dates);
    expect(out.find((r) => r.tag === 'v0.35.0')?.publishedAt).toBe('2026-07-20T13:57:49Z');
    expect(out.find((r) => r.tag === 'v0.34.0')?.publishedAt).toBeNull();
  });

  test('ignores content before the first version heading', () => {
    const [first] = parseChangelog(SAMPLE);
    expect(first.bodyHtml).not.toContain('@inkeep/open-knowledge');
  });

  test('does not match prerelease headings or malformed input', () => {
    expect(parseChangelog('## 0.30.1-beta.1\n\n- x: note\n')).toEqual([]);
    expect(parseChangelog('# Title only\n\nno versions here')).toEqual([]);
    expect(parseChangelog('')).toEqual([]);
  });
});

/** A GitHub "list releases" entry, dates-relevant fields only. */
function apiRelease(
  tag: string,
  opts: { draft?: boolean; prerelease?: boolean; published_at?: string | null } = {},
) {
  const { draft = false, prerelease = false, published_at = '2026-07-01T00:00:00Z' } = opts;
  return { tag_name: tag, draft, prerelease, published_at };
}

describe('collectDates', () => {
  test('collects stable published dates, skipping drafts and prereleases', () => {
    const dates = new Map<string, string>();
    collectDates(
      [
        apiRelease('v0.35.0'),
        apiRelease('v0.35.0-beta.1', { prerelease: true }),
        apiRelease('v0.29.9', { draft: true }),
        apiRelease('v0.34.0'),
      ],
      dates,
      30,
    );
    expect([...dates.keys()]).toEqual(['v0.35.0', 'v0.34.0']);
  });

  test('honors the limit and tolerates malformed entries', () => {
    const dates = new Map<string, string>();
    collectDates([apiRelease('v1.0.0'), apiRelease('v0.9.0')], dates, 1);
    expect(dates.size).toBe(1);
    const d2 = new Map<string, string>();
    collectDates([null, 42, { tag_name: 5 }, apiRelease('v1.0.0', { published_at: null })], d2, 30);
    expect(d2.size).toBe(0);
    collectDates('not-an-array', d2, 30);
    expect(d2.size).toBe(0);
  });
});

function mockFetch(responder: (page: number) => Response) {
  const pages: number[] = [];
  return ((url: string | URL) => {
    const page = Number(/[?&]page=(\d+)/.exec(String(url))?.[1] ?? '1');
    pages.push(page);
    return Promise.resolve(responder(page));
  }) as unknown as typeof fetch;
}

const json = (data: unknown) => new Response(JSON.stringify(data), { status: 200 });
const fullPage = (page: number) =>
  Array.from({ length: 100 }, (_, i) => apiRelease(`v9.${page}.${i}`, { prerelease: i > 0 }));

describe('fetchReleaseDates (best-effort)', () => {
  test('paginates until it has enough stable dates, then stops', async () => {
    // Each full page carries 1 stable + 99 betas, so reaching 2 dates needs 2 pages.
    const dates = await fetchReleaseDates(
      2,
      mockFetch((p) => json(fullPage(p))),
    );
    expect(dates.size).toBe(2);
  });

  test('stops on a short (final) page', async () => {
    const dates = await fetchReleaseDates(
      30,
      mockFetch(() => json([apiRelease('v1.0.0')])),
    );
    expect(dates.size).toBe(1);
  });

  test('degrades to empty on HTTP error — never throws', async () => {
    const dates = await fetchReleaseDates(
      30,
      mockFetch(() => new Response('nope', { status: 500 })),
    );
    expect(dates.size).toBe(0);
  });

  test('degrades to empty on a network throw — never throws', async () => {
    const dates = await fetchReleaseDates(30, (() =>
      Promise.reject(new Error('offline'))) as never);
    expect(dates.size).toBe(0);
  });
});

import { beforeEach, describe, expect, test, vi } from 'vitest';
import { corpusSourcePages, readCorpus } from '@/lib/docs-corpus.test-helper';
import { markdownHandlerForPage } from '@/lib/markdown-routes';
import { MARKETING_MARKDOWN_PAGES } from '@/lib/marketing-markdown-pages';

const pages = corpusSourcePages(await readCorpus());
vi.doMock('@/lib/source', () => ({ source: { getPages: () => pages } }));

const { GET, revalidate } = await import('./route.ts');

const FEED = [
  '<rss version="2.0"><channel>',
  '<item><title><![CDATA[Keeping you and your agents in check with markdownlint]]></title>',
  '<link>https://openknowledge.ai/blog/markdownlint-support</link>',
  '<description><![CDATA[Native markdownlint support in Open Knowledge.]]></description></item>',
  '</channel></rss>',
].join('\n');

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(FEED)),
  );
  return () => vi.unstubAllGlobals();
});

async function body(): Promise<string> {
  return (await GET()).text();
}

function listedUrls(text: string): string[] {
  return [...text.matchAll(/^- \[(?:\\.|[^\]\\])*]\(([^)]+)\)/gm)].map((match) => match[1]);
}

describe('GET /llms.txt', () => {
  test('serves markdown the edge can cache', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
    expect(res.headers.get('cache-control')).toMatch(/\bs-maxage=\d+/);
  });

  test('refreshes hourly, since the blog it lists is published elsewhere', () => {
    expect(revalidate).toBe(3600);
  });

  test('lists one entry per docs page, derived from the corpus rather than a count', async () => {
    const docsSection = (await body()).split('## Blog')[0];
    expect(listedUrls(docsSection)).toHaveLength(pages.length);
    expect(pages.length).toBeGreaterThan(50);
  });

  test('links the Markdown rendition of every docs page', async () => {
    const listed = new Set(listedUrls(await body()));
    for (const page of pages) {
      expect(listed).toContain(`https://openknowledge.ai${page.url}.md`);
    }
  });

  test('names each docs page by its own title', async () => {
    const quickstart = pages.find((page) => page.url === '/docs/get-started/quickstart');
    expect(quickstart).toBeDefined();
    expect(await body()).toContain(
      `- [${quickstart?.data.title}](https://openknowledge.ai/docs/get-started/quickstart.md)`,
    );
  });

  test('covers the marketing zone the docs app cannot enumerate', async () => {
    const listed = new Set(listedUrls(await body()));
    for (const page of MARKETING_MARKDOWN_PAGES) {
      expect(listed).toContain(`https://openknowledge.ai${page.path}`);
    }
  });

  test('lists the blog posts the marketing zone reported, under their own titles', async () => {
    expect(await body()).toContain(
      '- [Keeping you and your agents in check with markdownlint]' +
        '(https://openknowledge.ai/blog/markdownlint-support.md): ' +
        'Native markdownlint support in Open Knowledge.',
    );
  });

  test('keeps its own promise that every page it names negotiates Markdown', async () => {
    const docsPages = [...(await body()).matchAll(/^- \[(?:\\.|[^\]\\])*]\((\S+)\.md\)/gm)]
      .map((match) => match[1].replace('https://openknowledge.ai', ''))
      .filter((path) => path.startsWith('/docs/'));

    expect(
      docsPages.length,
      'no docs entries found; this check is reading nothing',
    ).toBeGreaterThan(10);
    expect(docsPages.filter((path) => markdownHandlerForPage(path) === null)).toEqual([]);
  });

  test('holds the llms.txt shape: title, summary, then named sections', async () => {
    const text = await body();
    expect(text.startsWith('# OpenKnowledge\n\n> ')).toBe(true);
    expect([...text.matchAll(/^## (.+)$/gm)].map((match) => match[1])).toEqual([
      'Docs',
      'Blog',
      'Product',
    ]);
  });

  test('every link is absolute and resolves to a Markdown rendition', async () => {
    const urls = listedUrls(await body());
    expect(urls.length).toBeGreaterThan(50);
    for (const url of urls) {
      expect(url).toMatch(/^https:\/\/openknowledge\.ai\/[^\s]*\.md$/);
    }
    expect(urls).toEqual([...new Set(urls)]);
  });
});

import { describe, expect, test, vi } from 'vitest';
import { type CorpusSourcePage, corpusSourcePages, readCorpus } from './docs-corpus.test-helper.ts';
import {
  FIDELITY_FIXTURES,
  type FidelityViolation,
  markdownFidelityViolations,
} from './markdown-fidelity.test-helper.ts';

const pages = corpusSourcePages(await readCorpus());
const bySlug = new Map(pages.map((page) => [page.url, page]));

vi.doMock('@/lib/source', () => ({
  source: {
    getPage: (slug: string[]) => bySlug.get(`/docs/${slug.join('/')}`.replace(/\/$/, '')),
    getPages: () => pages,
    generateParams: () => pages.map((page) => ({ slug: slugOf(page) })),
  },
}));

vi.doMock('@/lib/marketing-blog-index', () => ({
  blogPostLinks: async () => [
    { url: 'https://openknowledge.ai/blog/some-post.md', name: 'Some post' },
  ],
}));

const { GET } = await import('@/app/llms.mdx/[...slug]/route.ts');
const { GET: llmsTxtGet } = await import('@/app/llms.txt/route.ts');
const { GET: llmsFullGet } = await import('@/app/llms-full.txt/route.ts');

function slugOf(page: CorpusSourcePage): string[] {
  return page.url.slice('/docs/'.length).split('/').filter(Boolean);
}

async function serve(slug: string[]): Promise<string> {
  const response = await GET(new Request(`https://openknowledge.ai/docs/${slug.join('/')}.md`), {
    params: Promise.resolve({ slug }),
  });
  return response.text();
}

const served = new Map<string, string>();
for (const page of pages) served.set(page.url, await serve(slugOf(page)));
served.set('/docs/<unknown>', await serve(['no', 'such', 'page']));
served.set('/llms.txt', await (await llmsTxtGet()).text());
served.set('/llms-full.txt', await (await llmsFullGet()).text());

describe('the fidelity oracle', () => {
  test.each(FIDELITY_FIXTURES)('$name', ({ name, markdown, expect: expected }) => {
    const kinds = markdownFidelityViolations(name, markdown).map((violation) => violation.kind);
    expect(kinds).toEqual([...expected]);
  });
});

describe('every page the docs app serves as Markdown', () => {
  test('is a census, so a broken content glob cannot vacuously pass this suite', () => {
    expect(served.size).toBeGreaterThan(50);
    for (const [slug, markdown] of served) expect(markdown.length, slug).toBeGreaterThan(0);
  });

  test('reads as Markdown, with no JSX, indented code, base64 or source-form links', () => {
    const violations: FidelityViolation[] = [];
    for (const [slug, markdown] of served) {
      violations.push(...markdownFidelityViolations(slug, markdown));
    }
    expect(violations.map((violation) => violation.message)).toEqual([]);
  });
});

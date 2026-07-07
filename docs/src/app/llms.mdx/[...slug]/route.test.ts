import { describe, expect, mock, test } from 'bun:test';

const overviewPage = {
  url: '/docs/get-started/overview',
  data: {
    title: 'Overview',
    description: 'What OpenKnowledge is.',
    getText: async () => 'PROCESSED BODY',
  },
};

// `getPage` returns the fixture for the overview slug, undefined otherwise —
// lets us exercise both the 200 and the notFound paths.
mock.module('@/lib/source', () => ({
  source: {
    getPage: (slug: string[]) =>
      slug.join('/') === 'get-started/overview' ? overviewPage : undefined,
    generateParams: () => [{ slug: ['get-started', 'overview'] }],
  },
}));

// notFound() throws a sentinel in the App Router; mirror that so the handler's
// `if (!page) notFound()` branch is observable in a unit test.
mock.module('next/navigation', () => ({
  notFound: () => {
    throw new Error('NEXT_HTTP_ERROR_FALLBACK;404');
  },
}));

const { GET, generateStaticParams } = await import('./route.ts');

function props(slug: string[]) {
  return { params: Promise.resolve({ slug }) };
}

describe('GET /docs/<slug>.md (markdown route handler)', () => {
  test('serves text/markdown with the page rendered by getLLMText', async () => {
    const res = await GET(new Request('https://openknowledge.ai/docs/get-started/overview.md'), {
      ...props(['get-started', 'overview']),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/markdown; charset=utf-8');

    const body = await res.text();
    expect(body).toContain('# Overview (/docs/get-started/overview)');
    expect(body).toContain('PROCESSED BODY');
  });

  test('calls notFound() for an unknown page', async () => {
    await expect(
      GET(new Request('https://openknowledge.ai/docs/nope.md'), { ...props(['nope']) }),
    ).rejects.toThrow('404');
  });

  test('generateStaticParams delegates to the loader and yields slug-shaped params', () => {
    const params = generateStaticParams();
    // Assert the contract (non-empty list of `{ slug: string[] }`) rather than
    // echoing the mock's exact return — the route owes slug-shaped params so the
    // markdown pages prerender, regardless of which pages the loader reports.
    expect(params.length).toBeGreaterThan(0);
    for (const entry of params) {
      expect(Array.isArray(entry.slug)).toBe(true);
    }
  });
});

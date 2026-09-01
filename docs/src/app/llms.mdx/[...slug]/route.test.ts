import { describe, expect, test, vi } from 'vitest';

const overviewPage = {
  url: '/docs/get-started/overview',
  data: {
    title: 'Overview',
    description: 'What OpenKnowledge is.',
    getText: async () => 'PROCESSED BODY',
  },
};

vi.doMock('@/lib/source', () => ({
  source: {
    getPage: (slug: string[]) =>
      slug.join('/') === 'get-started/overview' ? overviewPage : undefined,
    generateParams: () => [{ slug: ['get-started', 'overview'] }],
  },
}));

vi.doMock('next/navigation', () => ({
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
    expect(params.length).toBeGreaterThan(0);
    for (const entry of params) {
      expect(Array.isArray(entry.slug)).toBe(true);
    }
  });
});

import { describe, expect, test, vi } from 'vitest';
import { NO_MARKDOWN_PREFIXES } from '@/lib/markdown-routes';

const overviewPage = {
  url: '/docs/get-started/overview',
  data: {
    title: 'Overview',
    description: 'What OpenKnowledge is.',
    getText: async () => '<Callout type="info">\n\nEarly days.\n\n</Callout>\n',
  },
};

vi.doMock('@/lib/source', () => ({
  source: {
    getPage: (slug: string[]) =>
      slug.join('/') === 'get-started/overview' ? overviewPage : undefined,
    generateParams: () => [{ slug: ['get-started', 'overview'] }],
  },
}));

const { GET, generateStaticParams } = await import('./route.ts');

function props(slug: string[]) {
  return { params: Promise.resolve({ slug }) };
}

function get(slug: string[]) {
  return GET(new Request(`https://openknowledge.ai/docs/${slug.join('/')}.md`), {
    ...props(slug),
  });
}

describe('GET /docs/<slug>.md (markdown route handler)', () => {
  test('serves text/markdown with the page rendered by getLLMText', async () => {
    const res = await get(['get-started', 'overview']);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/markdown; charset=utf-8');

    const body = await res.text();
    expect(body).toContain('# Overview (https://openknowledge.ai/docs/get-started/overview)');
    expect(body).toContain('> Early days.');
    expect(body).not.toContain('<Callout');
  });

  test('points at the human page with a canonical Link header', async () => {
    const res = await get(['get-started', 'overview']);
    expect(res.headers.get('link')).toBe(
      '<https://openknowledge.ai/docs/get-started/overview>; rel="canonical"',
    );
  });

  test('is edge-cacheable', async () => {
    const res = await get(['get-started', 'overview']);
    expect(res.headers.get('cache-control')).toMatch(/\bs-maxage=\d+/);
  });

  test('answers an unknown page with a hard 404 whose body is markdown', async () => {
    const res = await get(['nope']);
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toBe('text/markdown; charset=utf-8');

    const body = await res.text();
    expect(body).toContain('# 404 Not Found');
    expect(body).toContain('https://openknowledge.ai/llms.txt');
  });

  test('the 404 body is not mistakable for a real page rendition', async () => {
    const [missing, real] = await Promise.all([
      get(['nope']).then((r) => r.text()),
      get(['get-started', 'overview']).then((r) => r.text()),
    ]);
    expect(missing).not.toBe(real);
  });

  test.each(
    NO_MARKDOWN_PREFIXES,
  )('%s tells a real page apart from a URL no page holds', async (prefix) => {
    const slug = [...prefix.replace('/docs/', '').split('/'), 'some-page'];
    const [subtree, missing] = await Promise.all([
      get(slug).then((r) => r.text()),
      get(['nope']).then((r) => r.text()),
    ]);

    expect(subtree).not.toBe(missing);
    expect(subtree).not.toContain('No OpenKnowledge documentation page exists');
    expect(subtree).toContain(`https://openknowledge.ai${prefix}`);
  });

  test.each(
    NO_MARKDOWN_PREFIXES,
  )('%s still answers with a hard 404 carrying the contract', async (prefix) => {
    const res = await get([...prefix.replace('/docs/', '').split('/'), 'some-page']);
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
  });

  test('generateStaticParams delegates to the loader and yields slug-shaped params', () => {
    const params = generateStaticParams();
    expect(params.length).toBeGreaterThan(0);
    for (const entry of params) {
      expect(Array.isArray(entry.slug)).toBe(true);
    }
  });
});

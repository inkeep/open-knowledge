import { describe, expect, test, vi } from 'vitest';
import { corpusSourcePages, readCorpus } from '@/lib/docs-corpus.test-helper';
import { classifyLlmsFullSize, describeLlmsFullSize } from '@/lib/llms-full-size.test-helper';

const pages = corpusSourcePages(await readCorpus());
vi.doMock('@/lib/source', () => ({ source: { getPages: () => pages } }));

const { GET } = await import('./route.ts');

describe('GET /llms-full.txt', () => {
  test('serves the corpus as cacheable markdown', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
    expect(res.headers.get('cache-control')).toMatch(/\bs-maxage=\d+/);
  });

  test('renders no canonical of its own, since it renders no single page', async () => {
    expect((await GET()).headers.get('link')).toBeNull();
  });

  test('stays inside the size an agent can actually fetch', async () => {
    const bytes = Buffer.byteLength(await (await GET()).text(), 'utf8');
    const verdict = classifyLlmsFullSize(bytes);
    if (verdict === 'warn') process.stderr.write(`${describeLlmsFullSize(bytes)}\n`);
    expect(verdict, describeLlmsFullSize(bytes)).not.toBe('fail');
  });

  test('carries every page in the corpus', async () => {
    const body = await (await GET()).text();
    for (const page of pages) {
      expect(body).toContain(`(https://openknowledge.ai${page.url})`);
    }
  });
});

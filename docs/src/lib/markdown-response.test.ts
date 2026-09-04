import { describe, expect, test } from 'vitest';
import {
  MARKDOWN_CACHE_CONTROL,
  MARKDOWN_CONTENT_TYPE,
  markdownResponse,
} from './markdown-response.ts';

describe('markdownResponse', () => {
  test('serves the body as markdown with an edge-cacheable directive', async () => {
    const res = markdownResponse('# Hi');

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
    expect(res.headers.get('cache-control')).toMatch(/\bs-maxage=\d+/);
    expect(await res.text()).toBe('# Hi');
  });

  test('points agents at the human page with a canonical Link header', () => {
    const res = markdownResponse('# Hi', {
      canonicalUrl: 'https://openknowledge.ai/docs/get-started/overview',
    });

    expect(res.headers.get('link')).toBe(
      '<https://openknowledge.ai/docs/get-started/overview>; rel="canonical"',
    );
  });

  test('omits the canonical Link when the response renders no single page', () => {
    expect(markdownResponse('# Hi').headers.get('link')).toBeNull();
  });

  test('carries the full header contract on an error status too', () => {
    const res = markdownResponse('# 404', { status: 404 });

    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toBe(MARKDOWN_CONTENT_TYPE);
    expect(res.headers.get('cache-control')).toBe(MARKDOWN_CACHE_CONTROL);
    expect(res.headers.get('vary')).toBe('Accept');
  });

  test('varies on Accept, the correct signal this representation can carry', () => {
    expect(markdownResponse('# Hi').headers.get('vary')).toBe('Accept');
  });

  test('charset is explicit — text/markdown has no default one', () => {
    expect(MARKDOWN_CONTENT_TYPE).toContain('charset=utf-8');
  });
});

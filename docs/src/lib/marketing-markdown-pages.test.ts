import { describe, expect, test } from 'vitest';
import { BRAND_ROUTE } from './brand-assets';
import { MARKETING_MARKDOWN_PAGES } from './marketing-markdown-pages';

describe('curated marketing rendition inventory', () => {
  test('tracks the brand route this app links elsewhere', () => {
    expect(MARKETING_MARKDOWN_PAGES.map((page) => page.path)).toContain(`${BRAND_ROUTE}.md`);
  });

  test('every entry is a site-relative Markdown path', () => {
    for (const page of MARKETING_MARKDOWN_PAGES) {
      expect(page.path).toMatch(/^\/[^\s]*\.md$/);
    }
  });

  test('every entry can be described to an agent', () => {
    for (const page of MARKETING_MARKDOWN_PAGES) {
      expect(page.name.length).toBeGreaterThan(0);
      expect(page.description.length).toBeGreaterThan(0);
    }
  });

  test('lists no path twice', () => {
    const paths = MARKETING_MARKDOWN_PAGES.map((page) => page.path);
    expect(paths).toEqual([...new Set(paths)]);
  });
});

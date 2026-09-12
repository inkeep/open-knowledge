import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';
import { visit } from 'unist-util-visit';
import { describe, expect, test } from 'vitest';
import { getLLMText } from '@/lib/get-llm-text';
import type { FidelityViolation } from '@/lib/markdown-fidelity.test-helper';
import { markdownFidelityViolations } from '@/lib/markdown-fidelity.test-helper';
import { absoluteSiteUrl, SITE_URL } from '@/lib/site';
import { source } from '@/lib/source';

const pages = source.getPages();

function hrefsIn(markdown: string): string[] {
  const tree = unified().use(remarkParse).use(remarkGfm).parse(markdown);
  const urls: string[] = [];
  visit(tree, (node) => {
    if (node.type === 'link' || node.type === 'image' || node.type === 'definition') {
      urls.push(node.url);
    }
  });
  return urls;
}

describe('every page the real loader hands to the Markdown pipeline', () => {
  test('is a census, so a broken content glob cannot vacuously pass this suite', () => {
    expect(pages.length).toBeGreaterThan(50);
  });

  test('reads as Markdown, with no JSX, indented code, base64 or source-form links', async () => {
    const violations: FidelityViolation[] = [];
    for (const page of pages) {
      violations.push(...markdownFidelityViolations(page.url, await getLLMText(page)));
    }
    expect(violations.map((violation) => violation.message)).toEqual([]);
  });

  test('resolves every docs href to a page the loader actually serves', async () => {
    const pageUrls = new Set(pages.map((page) => absoluteSiteUrl(page.url)));
    const failures: string[] = [];
    for (const page of pages) {
      for (const href of hrefsIn(await getLLMText(page))) {
        const target = href.split(/[#?]/)[0] ?? href;
        if (target.startsWith(`${SITE_URL}/docs/`) && !pageUrls.has(target)) {
          failures.push(`${page.url}: resolved docs href is not a page (${target})`);
        }
      }
    }
    expect(failures).toEqual([]);
  });
});

describe('the real loader derives a page from its file', () => {
  test('nests the URL by directory rather than flattening or keeping the extension', () => {
    const page = source.getPage(['reference', 'components', 'callout']);
    expect(page?.url).toBe('/docs/reference/components/callout');
    expect(page?.data.title).toBe('Callout');
  });

  test('reads the title from frontmatter rather than from the filename', () => {
    const page = source.getPage(['get-started', 'quickstart']);
    expect(page?.url).toBe('/docs/get-started/quickstart');
    expect(page?.data.title).toBe('Quickstart');
  });

  test('serves raw source, not the compiled rendition, for the document body', async () => {
    const page = source.getPage(['reference', 'components', 'callout']);
    await expect(page?.data.getText('raw')).resolves.toContain('title: "Callout"');
  });
});

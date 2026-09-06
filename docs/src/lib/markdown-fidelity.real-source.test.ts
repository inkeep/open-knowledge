import { describe, expect, test } from 'vitest';
import { getLLMText } from '@/lib/get-llm-text';
import type { FidelityViolation } from '@/lib/markdown-fidelity.test-helper';
import { markdownFidelityViolations } from '@/lib/markdown-fidelity.test-helper';
import { source } from '@/lib/source';

const pages = source.getPages();

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

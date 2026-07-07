import { describe, expect, test } from 'bun:test';
import { getHeadingSlug, toWikiLinkSlug, wikiLinkHref } from './slug.ts';

describe('toWikiLinkSlug', () => {
  test('normalizes ASCII names to kebab-case slugs', () => {
    expect(toWikiLinkSlug('Nonexistent Page')).toBe('nonexistent-page');
    expect(toWikiLinkSlug('  Mixed_CASE  Page  ')).toBe('mixed-case-page');
  });

  test('preserves Unicode letters while removing accent marks safely', () => {
    expect(toWikiLinkSlug('Café Menu')).toBe('cafe-menu');
    expect(toWikiLinkSlug('Ångström Notes')).toBe('angstrom-notes');
    expect(toWikiLinkSlug('東京 2026')).toBe('東京-2026');
    expect(toWikiLinkSlug('Привет, мир!')).toBe('привет-мир');
    expect(toWikiLinkSlug('مرحبا بالعالم')).toBe('مرحبا-بالعالم');
  });

  test('is idempotent once a slug has been produced', () => {
    const samples = ['nonexistent-page', 'cafe-menu', '東京-2026', 'привет-мир', 'مرحبا-بالعالم'];
    for (const sample of samples) {
      expect(toWikiLinkSlug(toWikiLinkSlug(sample))).toBe(sample);
    }
  });
});

describe('getHeadingSlug', () => {
  test('deduplicates repeated headings in document order', () => {
    const slugCounts = new Map<string, number>();
    expect(getHeadingSlug('Notes', slugCounts)).toBe('notes');
    expect(getHeadingSlug('Notes', slugCounts)).toBe('notes-1');
    expect(getHeadingSlug('Notes', slugCounts)).toBe('notes-2');
  });

  test('deduplicates repeated Unicode headings using the same shared logic', () => {
    const slugCounts = new Map<string, number>();
    expect(getHeadingSlug('東京', slugCounts)).toBe('東京');
    expect(getHeadingSlug('東京', slugCounts)).toBe('東京-1');
    expect(getHeadingSlug('Café', slugCounts)).toBe('cafe');
    expect(getHeadingSlug('Café', slugCounts)).toBe('cafe-1');
  });
});

describe('wikiLinkHref', () => {
  test('target only — null anchor produces a fragment of just the target slug', () => {
    expect(wikiLinkHref('Page', null)).toBe('#page');
    expect(wikiLinkHref('Other Doc', null)).toBe('#other-doc');
    expect(wikiLinkHref('Mixed_CASE  Page', null)).toBe('#mixed-case-page');
  });

  test('target + anchor — joins both slugs with a single hyphen', () => {
    expect(wikiLinkHref('Page', 'Section')).toBe('#page-section');
    expect(wikiLinkHref('Other Doc', 'Section Name')).toBe('#other-doc-section-name');
  });

  test('Unicode targets and anchors slug consistently', () => {
    expect(wikiLinkHref('Café Menu', null)).toBe('#cafe-menu');
    expect(wikiLinkHref('東京', '2026')).toBe('#東京-2026');
    expect(wikiLinkHref('Привет', 'мир')).toBe('#привет-мир');
  });

  test('empty target with null anchor produces #', () => {
    // The wiki-link parser rejects empty targets upstream, but the helper
    // is pure — defensive coverage proves it does not throw or read
    // undefined slug bytes.
    expect(wikiLinkHref('', null)).toBe('#');
  });

  test('whitespace-only target collapses to # (treated as empty after slug normalization)', () => {
    expect(wikiLinkHref('   ', null)).toBe('#');
  });

  test('byte-identical to the historical mdast-to-hast-handlers private implementation', () => {
    // Drift fence — if this assertion ever changes, the wikiLinkHandler
    // round-trip in mdast-to-hast-handlers.test.ts will diverge from the
    // walker-side wiki-link transform that imports this same helper.
    const cases: Array<[string, string | null, string]> = [
      ['Page', null, '#page'],
      ['Page', 'Heading', '#page-heading'],
      ['Other Doc', 'Section Name', '#other-doc-section-name'],
      ['Café', 'Menü', '#cafe-menu'],
    ];
    for (const [target, anchor, expected] of cases) {
      expect(wikiLinkHref(target, anchor)).toBe(expected);
    }
  });
});

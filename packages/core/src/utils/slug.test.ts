import { describe, expect, test } from 'vitest';
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

  test('keeps the marks that distinguish letters outside Latin, Greek, Cyrillic, Arabic and Hebrew', () => {
    expect(toWikiLinkSlug('ガラス')).toBe('ガラス');
    expect(toWikiLinkSlug('カラス')).toBe('カラス');
    expect(toWikiLinkSlug('パン')).toBe('パン');
    expect(toWikiLinkSlug('がっこう')).toBe('がっこう');
    expect(toWikiLinkSlug('किताब')).toBe('किताब');
    expect(toWikiLinkSlug('क्या हाल')).toBe('क्या-हाल');
    expect(toWikiLinkSlug('বাংলা')).toBe('বাংলা');
    expect(toWikiLinkSlug('ที่นี่')).toBe('ที่นี่');
  });

  test('returns composed text for scripts whose letters decompose', () => {
    expect(toWikiLinkSlug('\uff76\uff9e\uff97\uff7d')).toBe('ガラス');
    expect(toWikiLinkSlug('\u30ab\u3099\u30e9\u30b9')).toBe('ガラス');
    expect(toWikiLinkSlug('한국어 문서')).toBe('한국어-문서');
  });

  test('keeps folding accents in Latin, Greek, Cyrillic, Arabic and Hebrew', () => {
    expect(toWikiLinkSlug('Crème Brûlée')).toBe('creme-brulee');
    expect(toWikiLinkSlug('Tiếng Việt')).toBe('tieng-viet');
    expect(toWikiLinkSlug('Άλφα Ωμέγα')).toBe('αλφα-ωμεγα');
    expect(toWikiLinkSlug('Ёлка')).toBe('елка');
    expect(toWikiLinkSlug('مَرْحَبًا')).toBe('مرحبا');
    expect(toWikiLinkSlug('שָׁלוֹם')).toBe('שלום');
    expect(toWikiLinkSlug('مـَـرْحَبًا')).toBe('مــرحبا');
    expect(toWikiLinkSlug('الرحمـٰن')).toBe('الرحمـن');
  });

  test('drops marks that do not sit on a letter', () => {
    expect(toWikiLinkSlug('1\ufe0f\u20e3 Intro')).toBe('1-intro');
    expect(toWikiLinkSlug('Party \u{1f389}\ufe0f')).toBe('party');
    expect(toWikiLinkSlug('\u0301Café')).toBe('cafe');
    expect(toWikiLinkSlug('葛\u{e0100}飾区')).toBe('葛飾区');
  });

  test('takes linear time on a long run of marks after a letter that keeps them', () => {
    const input = `葛${'\u0301'.repeat(20_000)}`;
    const started = performance.now();
    const slug = toWikiLinkSlug(input);
    expect(performance.now() - started).toBeLessThan(1500);
    expect(slug).toBe(input);
  });

  test('is idempotent once a slug has been produced', () => {
    const samples = [
      'nonexistent-page',
      'cafe-menu',
      '東京-2026',
      'привет-мир',
      'مرحبا-بالعالم',
      'ガラス',
      'किताब',
      '한국어-문서',
    ];
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

  test('headings that differ only by a voicing mark get distinct anchors', () => {
    const slugCounts = new Map<string, number>();
    expect(getHeadingSlug('ガラス', slugCounts)).toBe('ガラス');
    expect(getHeadingSlug('カラス', slugCounts)).toBe('カラス');
    expect(getHeadingSlug('ガラス', slugCounts)).toBe('ガラス-1');
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
    expect(wikiLinkHref('', null)).toBe('#');
  });

  test('whitespace-only target collapses to # (treated as empty after slug normalization)', () => {
    expect(wikiLinkHref('   ', null)).toBe('#');
  });

  test('byte-identical to the historical mdast-to-hast-handlers private implementation', () => {
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

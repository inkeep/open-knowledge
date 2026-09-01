import { describe, expect, test } from 'vitest';
import { scanHeadingLine } from './heading-scan.ts';

function counts(): Map<string, number> {
  return new Map();
}

describe('scanHeadingLine', () => {
  test('reports level, trimmed text, and slug for an accepted line', () => {
    expect(scanHeadingLine('## Section 8.9', counts())).toEqual({
      level: 2,
      text: 'Section 8.9',
      slug: 'section-8-9',
    });
  });

  test('accepts every ATX level from 1 to 6', () => {
    const levels = ['# One', '## Two', '### Three', '#### Four', '##### Five', '###### Six'].map(
      (line) => scanHeadingLine(line, counts())?.level,
    );

    expect(levels).toEqual([1, 2, 3, 4, 5, 6]);
  });

  test('rejects a seventh hash', () => {
    expect(scanHeadingLine('####### Seven', counts())).toBeNull();
  });

  test('trims padding around the heading text', () => {
    expect(scanHeadingLine('##   Padded heading   ', counts())).toEqual({
      level: 2,
      text: 'Padded heading',
      slug: 'padded-heading',
    });
  });

  test('accepts a tab between the hashes and the text', () => {
    expect(scanHeadingLine('#\tTabbed', counts())?.slug).toBe('tabbed');
  });

  test('tolerates a trailing carriage return', () => {
    expect(scanHeadingLine('# Intro\r', counts())).toEqual({
      level: 1,
      text: 'Intro',
      slug: 'intro',
    });
  });

  test('rejects hashes with no separating whitespace', () => {
    expect(scanHeadingLine('#NoSpace', counts())).toBeNull();
  });

  test('rejects an indented hash line', () => {
    expect(scanHeadingLine('  # Indented', counts())).toBeNull();
  });

  test('rejects hashes followed by no text', () => {
    expect(scanHeadingLine('### ', counts())).toBeNull();
    expect(scanHeadingLine('###   ', counts())).toBeNull();
    expect(scanHeadingLine('#', counts())).toBeNull();
  });

  test('rejects a heading whose text slugs to nothing', () => {
    expect(scanHeadingLine('## ---', counts())).toBeNull();
    expect(scanHeadingLine('## ***', counts())).toBeNull();
    expect(scanHeadingLine('## 🎉', counts())).toBeNull();
  });

  test('rejects a line with no hashes at all', () => {
    expect(scanHeadingLine('Plain paragraph', counts())).toBeNull();
    expect(scanHeadingLine('', counts())).toBeNull();
  });

  test('disambiguates repeated slugs through the caller-supplied counter map', () => {
    const shared = counts();

    expect(scanHeadingLine('# Intro', shared)?.slug).toBe('intro');
    expect(scanHeadingLine('## Intro', shared)?.slug).toBe('intro-1');
    expect(scanHeadingLine('### intro', shared)?.slug).toBe('intro-2');
  });

  test('a rejected line does not consume a slug count', () => {
    const shared = counts();

    expect(scanHeadingLine('## ---', shared)).toBeNull();
    expect(scanHeadingLine('#NotAHeading', shared)).toBeNull();
    expect(scanHeadingLine('# Intro', shared)?.slug).toBe('intro');
  });

  test('slugs non-ASCII text without transliterating it away', () => {
    expect(scanHeadingLine('## 東京', counts())?.slug).toBe('東京');
    expect(scanHeadingLine('## Café', counts())?.slug).toBe('cafe');
  });
});

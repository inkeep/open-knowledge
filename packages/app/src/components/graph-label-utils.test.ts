import { describe, expect, test } from 'bun:test';

import { buildGraphLabelDescriptors, pickGraphLabelText } from './graph-label-utils';

describe('graph label clamp helpers', () => {
  test('keeps the full cleaned label when it fits', () => {
    const descriptors = buildGraphLabelDescriptors([
      { id: 'docs/meeting-notes', label: 'Meeting Notes (draft)' },
    ]);

    const label = pickGraphLabelText(
      descriptors.get('docs/meeting-notes'),
      40,
      (text) => text.length,
    );

    expect(label).toBe('Meeting Notes');
  });

  test('prefers the topic segment over a clamped generic prefix when tight', () => {
    const descriptors = buildGraphLabelDescriptors([
      { id: 'docs/db-sync', label: 'Research Summary: Database comparison for offline sync' },
    ]);

    const label = pickGraphLabelText(descriptors.get('docs/db-sync'), 32, (text) => text.length);

    expect(label).toBe('Database comparison … sync');
  });

  test('falls back to compressed path labels for path-like titles', () => {
    const descriptors = buildGraphLabelDescriptors([
      {
        id: 'notes/2026/architecture/review',
        label: 'notes/2026/architecture/review',
      },
    ]);

    const label = pickGraphLabelText(
      descriptors.get('notes/2026/architecture/review'),
      28,
      (text) => text.length,
    );

    expect(label).toBe('architecture / review');
  });

  test('falls back to word-boundary end-truncation when no candidate with full topic fits', () => {
    // Char-clamp would produce 'Install…n guide' (mid-word break — reads as
    // garbled text). The algorithm prefers word-boundary truncation:
    // 'Installation…' is the longest readable fit within budget 16.
    const descriptors = buildGraphLabelDescriptors([
      { id: 'docs/guide', label: 'Installation and configuration guide' },
    ]);

    const label = pickGraphLabelText(descriptors.get('docs/guide'), 16, (text) => text.length);

    expect(label).toBe('Installation…');
  });

  test('uses word-boundary middle-clamp when symmetric word boundaries fit (tier 1)', () => {
    // 'abc xyz xyz abc' has spaces at indices 3, 7, 11. At budget 7 neither
    // word-split candidate fits ('abc xyz … abc' = 13 chars; 'abc … abc' =
    // 9 chars). clampMiddleByCharacters' tier-1 loop finds keep=3 where
    // text[3]=' ' AND text[length-3-1]=text[11]=' ' — both slice boundaries
    // land on spaces — producing 'abc…abc' (7 chars, both sides full words).
    // Pins the most-readable tier of the cascade against arithmetic regressions.
    const descriptors = buildGraphLabelDescriptors([{ id: 'docs/sym', label: 'abc xyz xyz abc' }]);

    const label = pickGraphLabelText(descriptors.get('docs/sym'), 7, (text) => text.length);

    expect(label).toBe('abc…abc');
  });

  test('falls back to character end-truncation when no word boundary exists (tier 3)', () => {
    // Single word with no spaces — neither tier-1 (no boundary symmetry) nor
    // tier-2 (no internal spaces to anchor end-truncation) can produce a
    // candidate. Tier-3 picks the largest character prefix + … that fits.
    // For 'aaaaaa' (6 chars) at budget 3, that's 'aa…'.
    const descriptors = buildGraphLabelDescriptors([{ id: 'docs/long', label: 'aaaaaa' }]);

    const label = pickGraphLabelText(descriptors.get('docs/long'), 3, (text) => text.length);

    expect(label).toBe('aa…');
  });
});

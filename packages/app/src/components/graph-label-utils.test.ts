import { describe, expect, test } from 'vitest';

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
    const descriptors = buildGraphLabelDescriptors([
      { id: 'docs/guide', label: 'Installation and configuration guide' },
    ]);

    const label = pickGraphLabelText(descriptors.get('docs/guide'), 16, (text) => text.length);

    expect(label).toBe('Installation…');
  });

  test('uses word-boundary middle-clamp when symmetric word boundaries fit (tier 1)', () => {
    const descriptors = buildGraphLabelDescriptors([{ id: 'docs/sym', label: 'abc xyz xyz abc' }]);

    const label = pickGraphLabelText(descriptors.get('docs/sym'), 7, (text) => text.length);

    expect(label).toBe('abc…abc');
  });

  test('falls back to character end-truncation when no word boundary exists (tier 3)', () => {
    const descriptors = buildGraphLabelDescriptors([{ id: 'docs/long', label: 'aaaaaa' }]);

    const label = pickGraphLabelText(descriptors.get('docs/long'), 3, (text) => text.length);

    expect(label).toBe('aa…');
  });
});

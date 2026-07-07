/**
 * Unit tests for the pure-function helpers in TimelinePanel.tsx.
 *
 * The React rendering itself is exercised via the Playwright e2e suite; this
 * test focuses on the summary-flattening helper so refactors survive without
 * a browser.
 */
import { describe, expect, test } from 'bun:test';
import type { TimelineEntry } from '@inkeep/open-knowledge-core';
import { allSummariesFor } from './TimelinePanel.tsx';

function baseEntry(overrides: Partial<TimelineEntry>): TimelineEntry {
  return {
    sha: '0'.repeat(40),
    timestamp: '2026-04-17T00:00:00Z',
    author: 'openknowledge',
    authorEmail: 'noreply@openknowledge.local',
    type: 'wip',
    message: 'wip: edits',
    contributors: [],
    checkpoint: null,
    ...overrides,
  };
}

describe('allSummariesFor (flat shape)', () => {
  test('returns [] for legacy entries with no contributors', () => {
    expect(allSummariesFor(baseEntry({ contributors: [] }))).toEqual([]);
  });

  test('returns [] when contributors have no summaries field (legacy commit shape)', () => {
    expect(
      allSummariesFor(
        baseEntry({
          contributors: [{ id: 'agent-a', name: 'Claude', docs: ['foo.md'] }],
        }),
      ),
    ).toEqual([]);
  });

  test('preserves insertion order for a single contributor', () => {
    expect(
      allSummariesFor(
        baseEntry({
          contributors: [
            {
              id: 'agent-a',
              name: 'Claude',
              docs: ['foo.md'],
              summaries: ['Fixed typo', 'Added example', 'Tightened intro'],
            },
          ],
        }),
      ),
    ).toEqual(['Fixed typo', 'Added example', 'Tightened intro']);
  });

  test('flattens across multiple contributors in contributor order (D23)', () => {
    expect(
      allSummariesFor(
        baseEntry({
          contributors: [
            { id: 'agent-a', name: 'Alice', docs: ['a.md'], summaries: ['A1', 'A2'] },
            { id: 'agent-b', name: 'Bob', docs: ['b.md'], summaries: ['B1'] },
          ],
        }),
      ),
    ).toEqual(['A1', 'A2', 'B1']);
  });

  test('mixed contributors: one with summaries, one without — only the summaries land', () => {
    expect(
      allSummariesFor(
        baseEntry({
          contributors: [
            { id: 'agent-a', name: 'Alice', docs: ['a.md'], summaries: ['Cleaned up'] },
            { id: 'agent-b', name: 'Bob', docs: ['b.md'] },
          ],
        }),
      ),
    ).toEqual(['Cleaned up']);
  });
});

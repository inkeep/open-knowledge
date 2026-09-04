import type { TimelineEntry } from '@inkeep/open-knowledge-core';
import { describe, expect, test } from 'vitest';
import { allSummariesFor, contributorIconKind } from './TimelinePanel.tsx';

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

describe('contributorIconKind', () => {
  const SYSTEM_WRITER_NAMES = [
    'File System',
    'Git (upstream)',
    'OpenKnowledge (service)',
    'OpenKnowledge (generated)',
  ];

  test('no system writer renders as a person', () => {
    for (const name of SYSTEM_WRITER_NAMES) {
      expect(contributorIconKind(name)).not.toBe('person');
    }
  });

  test('the generated writer gets its own icon family, distinct from the service writer', () => {
    expect(contributorIconKind('OpenKnowledge (generated)')).toBe('generated');
    expect(contributorIconKind('OpenKnowledge (service)')).toBe('upstream');
  });

  test('a human or unknown contributor still falls back to a person', () => {
    expect(contributorIconKind('Serafin Garcia')).toBe('person');
    expect(contributorIconKind('')).toBe('person');
  });
});

import { beforeEach, describe, expect, test } from 'bun:test';
import { parseContributors } from '@inkeep/open-knowledge-core/shadow-repo-layout';
import {
  contributorCount,
  __formatContributorsForTests as formatContributorsForTest,
  formatContributorsFrom,
  recordContributor,
  __resetContributorsForTests as resetContributorsForTest,
  restoreContributors,
  swapContributors,
} from './contributor-tracker.ts';

beforeEach(() => {
  resetContributorsForTest();
});

describe('recordContributor', () => {
  test('records a single contributor', () => {
    recordContributor('notes.md', 'agent-claude-1', 'Claude');
    expect(contributorCount()).toBe(1);
  });

  test('merges docs for the same agent across multiple calls', () => {
    recordContributor('a.md', 'agent-claude-1', 'Claude');
    recordContributor('b.md', 'agent-claude-1', 'Claude');
    expect(contributorCount()).toBe(1);
    const output = formatContributorsForTest();
    expect(output).toContain('"a.md"');
    expect(output).toContain('"b.md"');
  });

  test('accumulates multiple distinct agents', () => {
    recordContributor('a.md', 'agent-alice', 'Alice');
    recordContributor('b.md', 'agent-bob', 'Bob');
    expect(contributorCount()).toBe(2);
  });

  test('deduplicates the same doc for the same agent', () => {
    recordContributor('a.md', 'agent-alice', 'Alice');
    recordContributor('a.md', 'agent-alice', 'Alice');
    const output = formatContributorsForTest();
    // Only one "a.md" entry
    expect((output.match(/a\.md/g) ?? []).length).toBe(1);
  });

  test('includes colorSeed in formatted output', () => {
    recordContributor('doc.md', 'agent-alice', 'Alice', 'alice-custom-seed');
    const output = formatContributorsForTest();
    expect(output).toContain('"colorSeed":"alice-custom-seed"');
  });

  test('colorSeed defaults to displayName when not provided', () => {
    recordContributor('doc.md', 'agent-alice', 'Alice');
    const output = formatContributorsForTest();
    expect(output).toContain('"colorSeed":"Alice"');
  });
});

describe('formatContributors / formatContributorsFrom', () => {
  test('returns empty string when no contributors', () => {
    expect(formatContributorsForTest()).toBe('');
  });

  test('returns newline-prefixed lines when contributors exist', () => {
    recordContributor('doc.md', 'agent-claude-1', 'Claude');
    const output = formatContributorsForTest();
    expect(output.startsWith('\n')).toBe(true);
    expect(output).toContain('ok-contributors:');
  });

  test('includes v:1 version field', () => {
    recordContributor('doc.md', 'agent-claude-1', 'Claude');
    const output = formatContributorsForTest();
    expect(output).toContain('"v":1');
  });

  test('round-trips through parseContributors', () => {
    recordContributor('notes.md', 'agent-claude-1', 'Claude');
    recordContributor('docs.md', 'agent-cursor-abc', 'Cursor');
    const body = `WIP auto-save 2026-01-01T00:00:00.000Z${formatContributorsForTest()}`;
    const parsed = parseContributors(body);
    expect(parsed).toHaveLength(2);
    const ids = parsed.map((c) => c.id).sort();
    expect(ids).toEqual(['agent-claude-1', 'agent-cursor-abc']);
  });

  test('colorSeed round-trips through parseContributors', () => {
    recordContributor('doc.md', 'agent-alice', 'Alice', 'my-seed');
    const body = formatContributorsForTest();
    const parsed = parseContributors(body);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.colorSeed).toBe('my-seed');
  });

  test('formatContributorsFrom uses provided snapshot, not live map', () => {
    recordContributor('live.md', 'agent-live', 'Live');
    const snapshot = swapContributors();
    recordContributor('after-swap.md', 'agent-new', 'New');
    // snapshot has only 'agent-live'; live map has 'agent-new'
    const fromSnapshot = formatContributorsFrom(snapshot);
    expect(fromSnapshot).toContain('agent-live');
    expect(fromSnapshot).not.toContain('agent-new');
  });
});

describe('swapContributors + restoreContributors (swap-and-drain pattern)', () => {
  test('swapContributors returns the live map and resets to empty', () => {
    recordContributor('a.md', 'agent-alice', 'Alice');
    const snapshot = swapContributors();
    expect(snapshot.size).toBe(1);
    expect(contributorCount()).toBe(0);
  });

  test('recordContributor after swap goes to new live map, not snapshot', () => {
    recordContributor('a.md', 'agent-alice', 'Alice');
    const snapshot = swapContributors();
    recordContributor('b.md', 'agent-bob', 'Bob');
    expect(snapshot.has('agent-bob')).toBe(false);
    expect(contributorCount()).toBe(1); // agent-bob in live map
  });

  test('restoreContributors merges snapshot back on failure', () => {
    recordContributor('a.md', 'agent-alice', 'Alice');
    const snapshot = swapContributors();
    // Simulate a new contribution arriving during the failed commit
    recordContributor('b.md', 'agent-bob', 'Bob');
    restoreContributors(snapshot);
    // Both alice and bob should now be in the live map
    expect(contributorCount()).toBe(2);
    const output = formatContributorsForTest();
    expect(output).toContain('agent-alice');
    expect(output).toContain('agent-bob');
  });

  test('restoreContributors merges docs when same agent in both snapshot and live map', () => {
    recordContributor('a.md', 'agent-alice', 'Alice');
    const snapshot = swapContributors();
    recordContributor('b.md', 'agent-alice', 'Alice'); // same agent, new doc
    restoreContributors(snapshot);
    const output = formatContributorsForTest();
    expect(output).toContain('"a.md"');
    expect(output).toContain('"b.md"');
    // Still one entry for agent-alice
    const lines = output.split('\n').filter((l) => l.includes('agent-alice'));
    expect(lines).toHaveLength(1);
  });

  test('restoreContributors on empty live map fully restores snapshot', () => {
    recordContributor('a.md', 'agent-alice', 'Alice');
    const snapshot = swapContributors();
    // no new contributions
    restoreContributors(snapshot);
    expect(contributorCount()).toBe(1);
  });

  test('discarding snapshot on success is correct (no restore)', () => {
    recordContributor('a.md', 'agent-alice', 'Alice');
    const snapshot = swapContributors();
    recordContributor('b.md', 'agent-bob', 'Bob');
    // On success: discard snapshot; live map has agent-bob
    // (no restoreContributors call)
    expect(contributorCount()).toBe(1);
    const output = formatContributorsForTest();
    expect(output).toContain('agent-bob');
    expect(output).not.toContain('agent-alice');
    void snapshot; // explicitly unused
  });
});

describe('__resetContributorsForTests', () => {
  test('clears all accumulated contributors', () => {
    recordContributor('a.md', 'agent-alice', 'Alice');
    recordContributor('b.md', 'agent-bob', 'Bob');
    resetContributorsForTest();
    expect(contributorCount()).toBe(0);
    expect(formatContributorsForTest()).toBe('');
  });
});

describe('recordContributor (summary) — D23 flat array', () => {
  test('undefined summary → no summaries field in output (byte-identical to legacy)', () => {
    recordContributor('doc.md', 'agent-claude-1', 'Claude');
    const output = formatContributorsForTest();
    expect(output).not.toContain('summaries');
  });

  test('empty-string summary → no summaries field in output', () => {
    recordContributor('doc.md', 'agent-claude-1', 'Claude', undefined, undefined, undefined, '');
    const output = formatContributorsForTest();
    expect(output).not.toContain('summaries');
  });

  test('single summary is appended and emitted', () => {
    recordContributor(
      'doc.md',
      'agent-claude-1',
      'Claude',
      undefined,
      undefined,
      undefined,
      'Fixed typo',
    );
    const output = formatContributorsForTest();
    expect(output).toContain('"summaries":["Fixed typo"]');
  });

  test('multiple summaries append in insertion order (oldest first)', () => {
    recordContributor(
      'doc.md',
      'agent-claude-1',
      'Claude',
      undefined,
      undefined,
      undefined,
      'First',
    );
    recordContributor(
      'doc.md',
      'agent-claude-1',
      'Claude',
      undefined,
      undefined,
      undefined,
      'Second',
    );
    recordContributor(
      'doc.md',
      'agent-claude-1',
      'Claude',
      undefined,
      undefined,
      undefined,
      'Third',
    );
    const output = formatContributorsForTest();
    expect(output).toContain('"summaries":["First","Second","Third"]');
  });

  test('mixed contributors: one with summaries emits the field, the other omits it', () => {
    recordContributor(
      'a.md',
      'agent-alice',
      'Alice',
      undefined,
      undefined,
      undefined,
      'Cleaned up',
    );
    recordContributor('b.md', 'agent-bob', 'Bob');
    const output = formatContributorsForTest();
    const lines = output.split('\n').filter((l) => l.startsWith('ok-contributors:'));
    expect(lines).toHaveLength(2);
    const aliceLine = lines.find((l) => l.includes('agent-alice'));
    const bobLine = lines.find((l) => l.includes('agent-bob'));
    expect(aliceLine).toContain('"summaries":["Cleaned up"]');
    expect(bobLine).not.toContain('summaries');
  });

  test('summaries round-trip through parseContributors (verifies US-001 contract)', () => {
    recordContributor(
      'a.md',
      'agent-alice',
      'Alice',
      'seed',
      undefined,
      undefined,
      'Added example',
    );
    recordContributor('a.md', 'agent-alice', 'Alice', 'seed', undefined, undefined, 'Fixed typo');
    const body = `WIP auto-save 2026-01-01T00:00:00.000Z${formatContributorsForTest()}`;
    const parsed = parseContributors(body);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.summaries).toEqual(['Added example', 'Fixed typo']);
  });

  test('legacy-shape (no summaries) round-trips with summaries undefined', () => {
    recordContributor('a.md', 'agent-alice', 'Alice');
    const body = formatContributorsForTest();
    const parsed = parseContributors(body);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.summaries).toBeUndefined();
  });
});

describe('restoreContributors preserves summaries (D16 failure recovery)', () => {
  test('restored entry keeps its summaries when no live arrival during failure window', () => {
    recordContributor('a.md', 'agent-alice', 'Alice', undefined, undefined, undefined, 'First');
    const snapshot = swapContributors();
    restoreContributors(snapshot);
    const output = formatContributorsForTest();
    expect(output).toContain('"summaries":["First"]');
  });

  test('snapshot summaries merge BEFORE live summaries (chronological order preserved)', () => {
    recordContributor(
      'a.md',
      'agent-alice',
      'Alice',
      undefined,
      undefined,
      undefined,
      'Snapshot-1',
    );
    recordContributor(
      'a.md',
      'agent-alice',
      'Alice',
      undefined,
      undefined,
      undefined,
      'Snapshot-2',
    );
    const snapshot = swapContributors();
    // Simulate summaries arriving while the commit was failing
    recordContributor('a.md', 'agent-alice', 'Alice', undefined, undefined, undefined, 'Live-1');
    restoreContributors(snapshot);
    const output = formatContributorsForTest();
    expect(output).toContain('"summaries":["Snapshot-1","Snapshot-2","Live-1"]');
  });

  test('restore does not dedup — same summary twice legitimately preserved', () => {
    recordContributor('a.md', 'agent-alice', 'Alice', undefined, undefined, undefined, 'Same');
    const snapshot = swapContributors();
    recordContributor('a.md', 'agent-alice', 'Alice', undefined, undefined, undefined, 'Same');
    restoreContributors(snapshot);
    const output = formatContributorsForTest();
    expect(output).toContain('"summaries":["Same","Same"]');
  });

  test('restore rebuilds new live entry with summaries when snapshot-only', () => {
    recordContributor(
      'a.md',
      'agent-alice',
      'Alice',
      'seed',
      undefined,
      undefined,
      'Only in snapshot',
    );
    const snapshot = swapContributors();
    expect(contributorCount()).toBe(0);
    restoreContributors(snapshot);
    expect(contributorCount()).toBe(1);
    const output = formatContributorsForTest();
    expect(output).toContain('"summaries":["Only in snapshot"]');
  });
});

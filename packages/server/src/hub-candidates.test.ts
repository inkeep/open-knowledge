import { describe, expect, test } from 'bun:test';
import { findHubCandidates } from './hub-candidates.ts';

function makeIndex(docNames: string[]): ReadonlyMap<string, unknown> {
  return new Map(docNames.map((name) => [name, { mtime: 0 }]));
}

describe('findHubCandidates', () => {
  test('finds a sibling INDEX.md', () => {
    const index = makeIndex(['reports/r1/INDEX', 'reports/r1/foo', 'reports/r1/bar']);
    expect(findHubCandidates('reports/r1/foo', index)).toEqual(['reports/r1/INDEX']);
  });

  test('finds folder-name-match as hub', () => {
    const index = makeIndex(['reports/r1/r1', 'reports/r1/evidence']);
    expect(findHubCandidates('reports/r1/evidence', index)).toEqual(['reports/r1/r1']);
  });

  test('walks upward when no hub in immediate folder', () => {
    const index = makeIndex(['reports/r1/evidence/a', 'reports/r1/evidence/b', 'reports/r1/INDEX']);
    expect(findHubCandidates('reports/r1/evidence/a', index)).toEqual(['reports/r1/INDEX']);
  });

  test('prefers nearest hub over ancestor hub', () => {
    const index = makeIndex([
      'reports/r1/INDEX',
      'reports/r1/evidence/REPORT',
      'reports/r1/evidence/a',
    ]);
    // evidence/REPORT is nearer than reports/r1/INDEX — should appear first.
    const result = findHubCandidates('reports/r1/evidence/a', index);
    expect(result[0]).toBe('reports/r1/evidence/REPORT');
    expect(result).toContain('reports/r1/INDEX');
  });

  test('caps at 3 candidates', () => {
    const index = makeIndex([
      'reports/r1/INDEX',
      'reports/r1/README',
      'reports/r1/REPORT',
      'reports/r1/SPEC',
      'reports/r1/r1',
      'reports/r1/foo',
    ]);
    const result = findHubCandidates('reports/r1/foo', index);
    expect(result.length).toBe(3);
    // INDEX > README > REPORT priority preserved
    expect(result).toEqual(['reports/r1/INDEX', 'reports/r1/README', 'reports/r1/REPORT']);
  });

  test('matches case-insensitively on hub basenames', () => {
    const index = makeIndex(['reports/r1/readme', 'reports/r1/foo']);
    expect(findHubCandidates('reports/r1/foo', index)).toEqual(['reports/r1/readme']);
  });

  test('returns empty when no hub exists anywhere', () => {
    const index = makeIndex(['reports/r1/foo', 'reports/r1/bar']);
    expect(findHubCandidates('reports/r1/foo', index)).toEqual([]);
  });

  test('excludes the target doc itself', () => {
    // If somehow the target doc has a hub-matching name, it's not its own hub.
    const index = makeIndex(['reports/r1/INDEX']);
    expect(findHubCandidates('reports/r1/INDEX', index)).toEqual([]);
  });

  test('finds root-level README for a doc at root', () => {
    const index = makeIndex(['README', 'foo']);
    expect(findHubCandidates('foo', index)).toEqual(['README']);
  });

  test('finds root-level README for a deep doc after walking up', () => {
    const index = makeIndex(['README', 'a/b/c/d']);
    expect(findHubCandidates('a/b/c/d', index)).toEqual(['README']);
  });

  test('no folder-name-match at content root (empty folder has no basename)', () => {
    // A doc at content root has parentFolder = '' — there is no folder basename
    // to probe. Only fixed hub names match.
    const index = makeIndex(['foo', 'bar']);
    expect(findHubCandidates('foo', index)).toEqual([]);
  });
});

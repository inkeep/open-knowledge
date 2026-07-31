import { describe, expect, test } from 'vitest';
import { evaluateBugLane } from './bug-lane.mjs';

const FIX_A = 'a'.repeat(40);
const FIX_B = 'b'.repeat(40);
const FEAT = 'c'.repeat(40);
const SHIPPED = 'd'.repeat(40);

const cs = (id, bump, addingSha, addingSubject = `${id} subject (#100)`) => ({
  id,
  bump,
  addingSha,
  addingSubject,
});

const bugIssues = { issues: [{ identifier: 'PRD-1', labels: ['Bug', 'ok:ui'] }] };
const plainIssues = { issues: [{ identifier: 'PRD-2', labels: ['ok:ui'] }] };

const evaluate = (overrides = {}) =>
  evaluateBugLane({
    pendingChangesets: [cs('one', 'patch', FIX_A)],
    isInStable: () => false,
    resolveChangesetPrUrl: (id) => `https://github.com/inkeep/agents-private/pull/${id.length}`,
    resolveIssuesForUrl: async () => bugIssues,
    ...overrides,
  });

describe('evaluateBugLane', () => {
  test('a patch-only bug-linked commit qualifies', async () => {
    const r = await evaluate();
    expect(r.fixRefs).toEqual([FIX_A]);
    expect(r.reason).toBe('candidates');
    expect(r.perCommit[0]).toMatchObject({ qualifies: true, linkedIssues: ['PRD-1'] });
  });

  test('a commit adding any minor changeset is feature work and stays with its cycle', async () => {
    const r = await evaluate({
      pendingChangesets: [cs('one', 'patch', FEAT), cs('two', 'minor', FEAT)],
    });
    expect(r.fixRefs).toEqual([]);
    expect(r.perCommit[0].reason).toBe('not-patch-only');
  });

  test('a patch commit with no Bug-labeled issue does not qualify', async () => {
    const r = await evaluate({ resolveIssuesForUrl: async () => plainIssues });
    expect(r.fixRefs).toEqual([]);
    expect(r.perCommit[0].reason).toBe('not-bug-linked');
  });

  test('a commit already contained in the stable is excluded before any resolution', async () => {
    const r = await evaluate({
      pendingChangesets: [cs('restored', 'patch', SHIPPED)],
      isInStable: (sha) => sha === SHIPPED,
      resolveChangesetPrUrl: () => {
        throw new Error('must not resolve an already-shipped commit');
      },
    });
    expect(r.fixRefs).toEqual([]);
    expect(r.perCommit[0].reason).toBe('already-in-stable');
  });

  test('several qualifying commits batch in input (merge) order', async () => {
    const r = await evaluate({
      pendingChangesets: [cs('one', 'patch', FIX_A), cs('two', 'patch', FIX_B)],
    });
    expect(r.fixRefs).toEqual([FIX_A, FIX_B]);
  });

  test('resolution failures degrade the commit, never the tick', async () => {
    const r = await evaluate({
      pendingChangesets: [cs('one', 'patch', FIX_A), cs('two', 'patch', FIX_B)],
      resolveIssuesForUrl: async (url) => {
        if (url.endsWith('/3')) throw new Error('linear down');
        return bugIssues;
      },
      resolveChangesetPrUrl: (id) => `https://github.com/inkeep/agents-private/pull/${id.length}`,
    });
    // 'one' resolves via /3 (length 3) and errors -> not bug-linked; 'two' via
    // /3 as well... both ids are length 3, so both error: the tick still
    // answers rather than throwing.
    expect(r.reason).toBe('no-qualifying-fixes');
    expect(r.warnings.some((w) => w.startsWith('issues-error'))).toBe(true);
  });

  test('an unresolvable Linear lookup (no key) degrades to not-bug-linked', async () => {
    const r = await evaluate({
      resolveIssuesForUrl: async () => ({ unresolvable: 'no-linear-api-key' }),
    });
    expect(r.fixRefs).toEqual([]);
    expect(r.perCommit[0].reason).toBe('not-bug-linked');
    expect(r.warnings.some((w) => w.includes('no-linear-api-key'))).toBe(true);
  });

  test('a commit qualifies through any one of its changesets', async () => {
    const r = await evaluate({
      pendingChangesets: [cs('one', 'patch', FIX_A), cs('two', 'patch', FIX_A)],
      resolveIssuesForUrl: async (url) => (url.endsWith('/3') ? plainIssues : bugIssues),
      resolveChangesetPrUrl: (id) => `https://github.com/inkeep/agents-private/pull/${id === 'one' ? 3 : 4}`,
    });
    expect(r.fixRefs).toEqual([FIX_A]);
  });

  test('an isInStable failure degrades that commit with a warning and the tick still answers', async () => {
    const r = await evaluate({
      pendingChangesets: [cs('one', 'patch', FIX_A), cs('two', 'patch', FIX_B)],
      isInStable: (sha) => {
        if (sha === FIX_A) throw new Error('git lock');
        return false;
      },
    });
    expect(r.fixRefs).toEqual([FIX_B]);
    expect(r.warnings.some((w) => w.startsWith('containment-error') && w.includes('git lock'))).toBe(true);
    expect(r.perCommit.find((c) => c.sha === FIX_A).reason).toBe('containment-error');
  });

  test('an empty pile is a real answer', async () => {
    const r = await evaluate({ pendingChangesets: [] });
    expect(r).toMatchObject({ fixRefs: [], reason: 'no-pending-changesets' });
  });

  test('the Bug label matches case-insensitively and no other label counts', async () => {
    const r = await evaluate({
      resolveIssuesForUrl: async () => ({ issues: [{ identifier: 'PRD-9', labels: ['bug'] }] }),
    });
    expect(r.fixRefs).toEqual([FIX_A]);
    const r2 = await evaluate({
      resolveIssuesForUrl: async () => ({ issues: [{ identifier: 'PRD-9', labels: ['Bugfix'] }] }),
    });
    expect(r2.fixRefs).toEqual([]);
  });
});

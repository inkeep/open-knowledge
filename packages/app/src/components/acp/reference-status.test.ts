import type { GitHubReferencePreview, GitHubReferenceStatus } from '@inkeep/open-knowledge-core';
import { describe, expect, test } from 'vitest';
import { diffBlocks, referenceStatusLine } from './reference-status';

const IDLE: GitHubReferenceStatus = {
  mergeQueue: null,
  autoMerge: false,
  mergeState: null,
  reviewDecision: null,
  checks: null,
};

function openPull(status: Partial<GitHubReferenceStatus>): GitHubReferencePreview {
  return {
    kind: 'pull',
    repo: 'inkeep/agents',
    number: 1,
    title: 't',
    author: null,
    createdAt: '2026-09-20T10:00:00Z',
    lifecycle: 'open',
    status: { ...IDLE, ...status },
  };
}

describe('referenceStatusLine', () => {
  test('the merge queue outranks everything, with its position', () => {
    expect(
      referenceStatusLine(
        openPull({
          mergeQueue: { position: 3, state: 'AWAITING_CHECKS' },
          mergeState: 'BLOCKED',
          autoMerge: true,
        }),
      ),
    ).toEqual({ kind: 'queued', tone: 'attention', position: 3 });
    expect(
      referenceStatusLine(openPull({ mergeQueue: { position: 1, state: 'UNMERGEABLE' } })),
    ).toEqual({ kind: 'queue-unmergeable', tone: 'danger' });
  });

  test('auto-merge tells an armed pull request apart from a stuck one', () => {
    expect(referenceStatusLine(openPull({ mergeState: 'BLOCKED', autoMerge: true }))?.kind).toBe(
      'auto-merge',
    );
    expect(referenceStatusLine(openPull({ mergeState: 'BLOCKED' }))?.kind).toBe('blocked');
    expect(
      referenceStatusLine(openPull({ mergeState: 'BLOCKED', autoMerge: true, checks: 'FAILURE' })),
    ).toEqual({ kind: 'checks-failing', tone: 'danger' });
  });

  test('a failing optional check is not reported as blocked', () => {
    expect(referenceStatusLine(openPull({ mergeState: 'UNSTABLE', checks: 'FAILURE' }))).toEqual({
      kind: 'unstable',
      tone: 'severe',
    });
  });

  test('an optional check that is still running is not reported as failed', () => {
    expect(referenceStatusLine(openPull({ mergeState: 'UNSTABLE', checks: 'PENDING' }))).toEqual({
      kind: 'checks-running',
      tone: 'attention',
    });
    expect(referenceStatusLine(openPull({ mergeState: 'UNSTABLE', checks: null }))).toBeNull();
  });

  test('blocked pull requests name what they wait for', () => {
    expect(
      referenceStatusLine(openPull({ mergeState: 'BLOCKED', reviewDecision: 'REVIEW_REQUIRED' }))
        ?.kind,
    ).toBe('review-required');
    expect(referenceStatusLine(openPull({ mergeState: 'BLOCKED', checks: 'PENDING' }))?.kind).toBe(
      'checks-running',
    );
  });

  test('conflicts and requested changes come before readiness', () => {
    expect(referenceStatusLine(openPull({ mergeState: 'DIRTY', autoMerge: true }))?.kind).toBe(
      'conflicts',
    );
    expect(
      referenceStatusLine(openPull({ mergeState: 'CLEAN', reviewDecision: 'CHANGES_REQUESTED' }))
        ?.kind,
    ).toBe('changes-requested');
    expect(
      referenceStatusLine(openPull({ mergeState: 'CLEAN', reviewDecision: 'APPROVED' })),
    ).toEqual({ kind: 'approved', tone: 'success' });
    expect(referenceStatusLine(openPull({ mergeState: 'BEHIND' }))?.kind).toBe('behind');
  });

  test('closed, merged and statusless references get no status row', () => {
    expect(referenceStatusLine({ ...openPull({}), lifecycle: 'merged' })).toBeNull();
    expect(referenceStatusLine({ ...openPull({}), status: undefined })).toBeNull();
    expect(referenceStatusLine(openPull({}))).toBeNull();
  });
});

describe('diffBlocks', () => {
  test('floors each share of five blocks and leaves the rest grey', () => {
    expect(diffBlocks(120, 30)).toEqual(['add', 'add', 'add', 'add', 'del']);
    expect(diffBlocks(90, 20)).toEqual(['add', 'add', 'add', 'add', 'none']);
    expect(diffBlocks(1, 1)).toEqual(['add', 'add', 'del', 'del', 'none']);
    expect(diffBlocks(0, 0)).toEqual(['none', 'none', 'none', 'none', 'none']);
    expect(diffBlocks(0, 9)).toEqual(['del', 'del', 'del', 'del', 'del']);
  });
});

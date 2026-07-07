import { describe, expect, test } from 'bun:test';

import { type BranchInfoResponse, BranchInfoResponseSchema } from '@inkeep/open-knowledge-core';

import {
  applyBranchInfo,
  applyCheckoutOutcome,
  applyVerdict,
  type BranchSwitchDialogState,
  classifyCheckoutOutcome,
  formatCurrentLabel,
  initialBranchSwitchState,
  markSwitching,
  markVerdictPending,
  selectBranchSwitchVariant,
  shouldProbeTargetStatus,
} from './branch-switch-flow';

const cleanInfo = (overrides: Partial<BranchInfoResponse> = {}): BranchInfoResponse =>
  ({
    currentBranch: 'main',
    currentHeadSha: null,
    detached: false,
    shareTargetExists: true,
    dirtyConflicts: { conflicts: false, files: [] },
    branchIsLocal: true,
    ...overrides,
  }) as BranchInfoResponse;

const detachedInfo = (overrides: Partial<BranchInfoResponse> = {}): BranchInfoResponse =>
  ({
    currentBranch: null,
    currentHeadSha: 'deadbee',
    detached: true,
    shareTargetExists: true,
    dirtyConflicts: { conflicts: false, files: [] },
    branchIsLocal: true,
    ...overrides,
  }) as BranchInfoResponse;

describe('selectBranchSwitchVariant', () => {
  test('variant A — file exists on current branch, clean tree', () => {
    const variant = selectBranchSwitchVariant(cleanInfo());
    expect(variant).toEqual({
      kind: 'A',
      openCurrentEnabled: true,
      switchEnabled: true,
      conflictingFiles: [],
    });
  });

  test('variant B — file missing on current branch, clean tree', () => {
    const variant = selectBranchSwitchVariant(cleanInfo({ shareTargetExists: false }));
    expect(variant).toEqual({
      kind: 'B',
      openCurrentEnabled: false,
      switchEnabled: true,
      conflictingFiles: [],
    });
  });

  test('variant C — file exists on current, dirty conflict', () => {
    const variant = selectBranchSwitchVariant(
      cleanInfo({
        dirtyConflicts: { conflicts: true, files: ['a.md', 'b.md'] },
      }),
    );
    expect(variant).toEqual({
      kind: 'C',
      openCurrentEnabled: true,
      switchEnabled: false,
      conflictingFiles: ['a.md', 'b.md'],
    });
  });

  test('variant D — file missing on current, dirty conflict — only Cancel viable', () => {
    const variant = selectBranchSwitchVariant(
      cleanInfo({
        shareTargetExists: false,
        dirtyConflicts: { conflicts: true, files: ['x.md'] },
      }),
    );
    expect(variant).toEqual({
      kind: 'D',
      openCurrentEnabled: false,
      switchEnabled: false,
      conflictingFiles: ['x.md'],
    });
  });
});

describe('formatCurrentLabel', () => {
  test('uses the branch name when HEAD is on a named branch', () => {
    expect(formatCurrentLabel(cleanInfo({ currentBranch: 'main' }))).toBe('main');
  });

  test('uses the short SHA when HEAD is detached', () => {
    expect(formatCurrentLabel(detachedInfo({ currentHeadSha: 'deadbee' }))).toBe('deadbee');
  });

  test('falls back to HEAD when not detached but currentBranch is null', () => {
    // computeBranchInfo emits {detached: false, currentBranch: null} when
    // symbolic-ref returns something other than `refs/heads/*` (e.g.
    // unusual ref layouts). Last-resort sentinel keeps the dialog rendering.
    expect(formatCurrentLabel(cleanInfo({ currentBranch: null }))).toBe('HEAD');
  });

  test('preserves slashed branch names verbatim', () => {
    expect(formatCurrentLabel(cleanInfo({ currentBranch: 'feat/foo' }))).toBe('feat/foo');
  });
});

describe('BranchInfoResponseSchema (discriminated union)', () => {
  test('accepts the named-branch variant ({detached: false, currentHeadSha: null})', () => {
    const valid = {
      detached: false,
      currentBranch: 'main',
      currentHeadSha: null,
      shareTargetExists: true,
      dirtyConflicts: { conflicts: false, files: [] },
      branchIsLocal: true,
    };
    const result = BranchInfoResponseSchema['~standard'].validate(valid);
    expect(result).toMatchObject({ value: valid });
  });

  test('accepts the detached-HEAD variant ({detached: true, currentBranch: null, currentHeadSha: string})', () => {
    const valid = {
      detached: true,
      currentBranch: null,
      currentHeadSha: 'deadbee',
      shareTargetExists: true,
      dirtyConflicts: { conflicts: false, files: [] },
      branchIsLocal: true,
    };
    const result = BranchInfoResponseSchema['~standard'].validate(valid);
    expect(result).toMatchObject({ value: valid });
  });

  test('rejects the contradictory state ({detached: true, currentBranch: "main"})', () => {
    // this was a representable invalid
    // state because the schema had `detached`, `currentBranch`, and
    // `currentHeadSha` as independent fields. The discriminated union
    // makes it unrepresentable.
    const invalid = {
      detached: true,
      currentBranch: 'main',
      currentHeadSha: 'deadbee',
      shareTargetExists: true,
      dirtyConflicts: { conflicts: false, files: [] },
      branchIsLocal: true,
    };
    const result = BranchInfoResponseSchema['~standard'].validate(invalid);
    expect('issues' in result && result.issues !== undefined).toBe(true);
  });

  test('rejects the contradictory state ({detached: false, currentHeadSha: "deadbee"})', () => {
    const invalid = {
      detached: false,
      currentBranch: 'main',
      currentHeadSha: 'deadbee',
      shareTargetExists: true,
      dirtyConflicts: { conflicts: false, files: [] },
      branchIsLocal: true,
    };
    const result = BranchInfoResponseSchema['~standard'].validate(invalid);
    expect('issues' in result && result.issues !== undefined).toBe(true);
  });
});

describe('classifyCheckoutOutcome', () => {
  test('ok=true classifies to await-cc1 (caller registers CC1 listener)', () => {
    expect(classifyCheckoutOutcome({ ok: true })).toEqual({ action: 'await-cc1' });
  });

  test('branch-not-found classifies to dismiss-with-toast (no path forward)', () => {
    expect(classifyCheckoutOutcome({ ok: false, reason: 'branch-not-found' })).toEqual({
      action: 'dismiss-with-toast',
      reason: 'branch-not-found',
    });
  });

  test('fetch-failed classifies to stay-with-toast (user can retry)', () => {
    expect(classifyCheckoutOutcome({ ok: false, reason: 'fetch-failed' })).toEqual({
      action: 'stay-with-toast',
      reason: 'fetch-failed',
    });
  });

  test('checkout-failed classifies to stay-with-toast', () => {
    expect(classifyCheckoutOutcome({ ok: false, reason: 'checkout-failed' })).toEqual({
      action: 'stay-with-toast',
      reason: 'checkout-failed',
    });
  });

  test('dirty-conflict re-renders the variant with the fresh file list — never navigates', () => {
    expect(
      classifyCheckoutOutcome({
        ok: false,
        reason: 'dirty-conflict',
        files: ['a.md'],
      }),
    ).toEqual({ action: 'rerender-conflict', files: ['a.md'] });
  });

  test('dirty-conflict without files defaults to an empty list', () => {
    expect(classifyCheckoutOutcome({ ok: false, reason: 'dirty-conflict' })).toEqual({
      action: 'rerender-conflict',
      files: [],
    });
  });

  test('exhaustiveness guard rejects an unhandled CheckoutFailureReason at runtime', () => {
    // The compile-time `_exhaustive: never` guard catches new failure reasons
    // at build time; this runtime check pins the safety net for the case
    // where a wire response carries a reason the schema parser missed (e.g.
    // a forward-compatibility hole in `.loose()`).
    expect(() =>
      classifyCheckoutOutcome({
        ok: false,
        // biome-ignore lint/suspicious/noExplicitAny: deliberately bypass type to test the runtime exhaustiveness guard
        reason: 'unknown-future-reason' as any,
      }),
    ).toThrow(/Unhandled CheckoutFailureReason/);
  });
});

describe('BranchSwitchDialogState transitions', () => {
  test('initial state is loading', () => {
    expect(initialBranchSwitchState).toEqual({ phase: 'loading' });
  });

  test('applyBranchInfo with a valid response transitions to ready', () => {
    const next = applyBranchInfo(initialBranchSwitchState, cleanInfo());
    expect(next).toEqual({ phase: 'ready', info: cleanInfo() });
  });

  test('applyBranchInfo with null transitions to error', () => {
    const next = applyBranchInfo(initialBranchSwitchState, null);
    expect(next).toEqual({ phase: 'error' });
  });

  test('markSwitching only fires from ready — variant must be switchable', () => {
    const ready: BranchSwitchDialogState = {
      phase: 'ready',
      info: cleanInfo(),
    };
    const next = markSwitching(ready, 'docs/foo.md');
    expect(next).toEqual({
      phase: 'switching',
      info: cleanInfo(),
      pendingDoc: 'docs/foo.md',
    });
  });

  test('markSwitching from loading is a no-op (cannot switch while loading)', () => {
    const next = markSwitching(initialBranchSwitchState, 'docs/foo.md');
    expect(next).toEqual({ phase: 'loading' });
  });

  test('checkout ok=true transitions switching → awaiting-cc1-recycle holding pendingDoc (no side effect)', () => {
    const switching: BranchSwitchDialogState = {
      phase: 'switching',
      info: cleanInfo(),
      pendingDoc: 'docs/foo.md',
    };
    const result = applyCheckoutOutcome(switching, { ok: true });
    expect(result.state).toEqual({
      phase: 'awaiting-cc1-recycle',
      pendingDoc: 'docs/foo.md',
    });
    expect(result.sideEffect).toBeUndefined();
  });

  test('checkout dirty-conflict re-renders ready state with the fresh file list (no side effect)', () => {
    const switching: BranchSwitchDialogState = {
      phase: 'switching',
      info: cleanInfo(),
      pendingDoc: 'docs/foo.md',
    };
    const result = applyCheckoutOutcome(switching, {
      ok: false,
      reason: 'dirty-conflict',
      files: ['fresh.md'],
    });
    expect(result.state).toEqual({
      phase: 'ready',
      info: {
        ...cleanInfo(),
        dirtyConflicts: { conflicts: true, files: ['fresh.md'] },
      },
    });
    expect(result.sideEffect).toBeUndefined();
  });

  test('checkout terminal failure (branch-not-found) collapses to dismissed with branch-not-found toast', () => {
    const switching: BranchSwitchDialogState = {
      phase: 'switching',
      info: cleanInfo(),
      pendingDoc: 'docs/foo.md',
    };
    const result = applyCheckoutOutcome(switching, { ok: false, reason: 'branch-not-found' });
    expect(result.state).toEqual({ phase: 'dismissed', reason: 'branch-not-found' });
    expect(result.sideEffect).toEqual({ kind: 'toast', reason: 'branch-not-found' });
  });

  test('checkout transient failure (fetch-failed) returns to ready with fetch-failed toast', () => {
    const switching: BranchSwitchDialogState = {
      phase: 'switching',
      info: cleanInfo(),
      pendingDoc: 'docs/foo.md',
    };
    const result = applyCheckoutOutcome(switching, { ok: false, reason: 'fetch-failed' });
    expect(result.state).toEqual({ phase: 'ready', info: cleanInfo() });
    expect(result.sideEffect).toEqual({ kind: 'toast', reason: 'fetch-failed' });
  });

  test('checkout transient failure (checkout-failed) returns to ready with checkout-failed toast', () => {
    const switching: BranchSwitchDialogState = {
      phase: 'switching',
      info: cleanInfo(),
      pendingDoc: 'docs/foo.md',
    };
    const result = applyCheckoutOutcome(switching, { ok: false, reason: 'checkout-failed' });
    expect(result.state).toEqual({ phase: 'ready', info: cleanInfo() });
    expect(result.sideEffect).toEqual({ kind: 'toast', reason: 'checkout-failed' });
  });

  test('checkout null (proxy failure) returns to ready with proxy-null toast', () => {
    const switching: BranchSwitchDialogState = {
      phase: 'switching',
      info: cleanInfo(),
      pendingDoc: 'docs/foo.md',
    };
    const result = applyCheckoutOutcome(switching, null);
    expect(result.state).toEqual({ phase: 'ready', info: cleanInfo() });
    expect(result.sideEffect).toEqual({ kind: 'toast', reason: 'proxy-null' });
  });

  test('applyCheckoutOutcome from non-switching phase is identity with no side effect', () => {
    const ready: BranchSwitchDialogState = { phase: 'ready', info: cleanInfo() };
    const result = applyCheckoutOutcome(ready, null);
    expect(result.state).toBe(ready);
    expect(result.sideEffect).toBeUndefined();
  });
});

describe('classifyCheckoutOutcome — branch-in-other-worktree (FR6 / J5)', () => {
  test('branch-in-other-worktree with otherWorktreePath classifies to pivot-to-other-worktree', () => {
    const result = classifyCheckoutOutcome({
      ok: false,
      reason: 'branch-in-other-worktree',
      otherWorktreePath: '/tmp/wt/feat-bar',
    });
    expect(result).toEqual({
      action: 'pivot-to-other-worktree',
      otherWorktreePath: '/tmp/wt/feat-bar',
    });
  });

  test('branch-in-other-worktree without otherWorktreePath falls back to stay-with-toast (defensive)', () => {
    const result = classifyCheckoutOutcome({
      ok: false,
      reason: 'branch-in-other-worktree',
    });
    expect(result).toEqual({ action: 'stay-with-toast', reason: 'checkout-failed' });
  });

  test('branch-in-other-worktree with empty-string otherWorktreePath falls back', () => {
    const result = classifyCheckoutOutcome({
      ok: false,
      reason: 'branch-in-other-worktree',
      otherWorktreePath: '',
    });
    expect(result).toEqual({ action: 'stay-with-toast', reason: 'checkout-failed' });
  });
});

describe('applyCheckoutOutcome — J5 transition', () => {
  test('switching → branch-in-other-worktree carries otherWorktreePath + preserves pendingDoc + info', () => {
    const switching: BranchSwitchDialogState = {
      phase: 'switching',
      info: cleanInfo(),
      pendingDoc: 'README.md',
    };
    const result = applyCheckoutOutcome(switching, {
      ok: false,
      reason: 'branch-in-other-worktree',
      otherWorktreePath: '/tmp/wt/feat-bar',
    });
    expect(result.state).toEqual({
      phase: 'branch-in-other-worktree',
      info: switching.info,
      otherWorktreePath: '/tmp/wt/feat-bar',
      pendingDoc: 'README.md',
    });
    // No toast — the dialog re-renders with the pivot CTA.
    expect(result.sideEffect).toBeUndefined();
  });

  test('switching → branch-in-other-worktree without path falls back to ready + checkout-failed toast', () => {
    const switching: BranchSwitchDialogState = {
      phase: 'switching',
      info: cleanInfo(),
      pendingDoc: 'README.md',
    };
    const result = applyCheckoutOutcome(switching, {
      ok: false,
      reason: 'branch-in-other-worktree',
    });
    expect(result.state.phase).toBe('ready');
    expect(result.sideEffect).toEqual({ kind: 'toast', reason: 'checkout-failed' });
  });

  test('cancel-from-pivot (J5): branch-in-other-worktree is a reducer terminal — every transition is identity', () => {
    // The dialog cancels via store.dismiss() — the parent controls
    // unmounting. The state machine itself has no `cancel` action; the
    // safety net is that every reducer (applyBranchInfo, markSwitching,
    // applyCheckoutOutcome) is an identity no-op from
    // branch-in-other-worktree. This test guards against accidentally
    // adding a transition out of this phase that would corrupt the
    // dialog mid-cancel (e.g., a late branch-info arrival rewriting
    // the otherWorktreePath, or a delayed checkout response promoting
    // the user past the pivot dialog).
    const pivot: BranchSwitchDialogState = {
      phase: 'branch-in-other-worktree',
      info: cleanInfo(),
      otherWorktreePath: '/tmp/wt/feat-bar',
      pendingDoc: 'README.md',
    };

    // applyBranchInfo: ignored (only loading → ready/error).
    expect(applyBranchInfo(pivot, cleanInfo())).toBe(pivot);
    expect(applyBranchInfo(pivot, null)).toBe(pivot);

    // markSwitching: ignored (only ready → switching).
    expect(markSwitching(pivot, 'OTHER.md')).toBe(pivot);

    // applyCheckoutOutcome: ignored (only switching → terminal). The
    // typed result returns the unchanged state with no side-effect so a
    // delayed checkout response can't fire a ghost toast after the user
    // has already chosen the pivot CTA path.
    const lateResponse = applyCheckoutOutcome(pivot, { ok: true });
    expect(lateResponse.state).toBe(pivot);
    expect(lateResponse.sideEffect).toBeUndefined();

    const lateProxyNull = applyCheckoutOutcome(pivot, null);
    expect(lateProxyNull.state).toBe(pivot);
    expect(lateProxyNull.sideEffect).toBeUndefined();

    const lateOtherFailure = applyCheckoutOutcome(pivot, {
      ok: false,
      reason: 'branch-not-found',
    });
    expect(lateOtherFailure.state).toBe(pivot);
    expect(lateOtherFailure.sideEffect).toBeUndefined();
  });
});

describe('shouldProbeTargetStatus (origin-hint pivot gate)', () => {
  test('true on the switch-to-recover variant when the origin hint is false', () => {
    expect(
      shouldProbeTargetStatus(
        cleanInfo({ shareTargetExists: false, shareTargetOnOriginBranch: false }),
      ),
    ).toBe(true);
  });

  test('false when the origin hint is true (doc is on origin — plain switch is fine)', () => {
    expect(
      shouldProbeTargetStatus(
        cleanInfo({ shareTargetExists: false, shareTargetOnOriginBranch: true }),
      ),
    ).toBe(false);
  });

  test('false when the hint is omitted (fail-open to today plain switch)', () => {
    expect(shouldProbeTargetStatus(cleanInfo({ shareTargetExists: false }))).toBe(false);
  });

  test('false when the target already exists on the current branch (variant A, not a miss)', () => {
    expect(
      shouldProbeTargetStatus(
        cleanInfo({ shareTargetExists: true, shareTargetOnOriginBranch: false }),
      ),
    ).toBe(false);
  });

  test('false when a dirty conflict blocks the switch (variant D, no recovery via switch)', () => {
    expect(
      shouldProbeTargetStatus(
        cleanInfo({
          shareTargetExists: false,
          shareTargetOnOriginBranch: false,
          dirtyConflicts: { conflicts: true, files: ['x.md'] },
        }),
      ),
    ).toBe(false);
  });
});

describe('markVerdictPending', () => {
  test('ready → verdict-pending, preserving info', () => {
    const ready: BranchSwitchDialogState = { phase: 'ready', info: cleanInfo() };
    expect(markVerdictPending(ready)).toEqual({ phase: 'verdict-pending', info: cleanInfo() });
  });

  test('identity from non-ready phases (a late dispatch cannot rewind a switch)', () => {
    const switching: BranchSwitchDialogState = {
      phase: 'switching',
      info: cleanInfo(),
      pendingDoc: 'docs/foo.md',
    };
    expect(markVerdictPending(switching)).toBe(switching);
  });
});

describe('applyVerdict', () => {
  const pending: BranchSwitchDialogState = { phase: 'verdict-pending', info: cleanInfo() };

  test('on-origin resolves to the on-origin verdict cell', () => {
    expect(applyVerdict(pending, { verdict: 'on-origin' })).toEqual({
      phase: 'verdict',
      info: cleanInfo(),
      resolution: { kind: 'on-origin' },
    });
  });

  test('renamed carries renamedTo through to the resolution', () => {
    expect(applyVerdict(pending, { verdict: 'renamed', renamedTo: 'guides/a.md' })).toEqual({
      phase: 'verdict',
      info: cleanInfo(),
      resolution: { kind: 'renamed', renamedTo: 'guides/a.md' },
    });
  });

  test('deleted resolves to the deleted terminal cell', () => {
    expect(applyVerdict(pending, { verdict: 'deleted' })).toEqual({
      phase: 'verdict',
      info: cleanInfo(),
      resolution: { kind: 'deleted' },
    });
  });

  test('never-on-branch resolves distinctly from deleted', () => {
    expect(applyVerdict(pending, { verdict: 'never-on-branch' })).toEqual({
      phase: 'verdict',
      info: cleanInfo(),
      resolution: { kind: 'never-on-branch' },
    });
  });

  test('unknown verdict falls back to ready (today plain switch)', () => {
    expect(applyVerdict(pending, { verdict: 'unknown' })).toEqual({
      phase: 'ready',
      info: cleanInfo(),
    });
  });

  test('null proxy result falls back to ready (fail-open on transport failure)', () => {
    expect(applyVerdict(pending, null)).toEqual({ phase: 'ready', info: cleanInfo() });
  });

  test('identity from non-verdict-pending phases (a late fetch cannot clobber a switch in flight)', () => {
    const switching: BranchSwitchDialogState = {
      phase: 'switching',
      info: cleanInfo(),
      pendingDoc: 'docs/foo.md',
    };
    expect(applyVerdict(switching, { verdict: 'on-origin' })).toBe(switching);
  });
});

describe('markSwitching from a verdict cell', () => {
  test('on-origin verdict → switching, carrying the navigation target', () => {
    const verdict: BranchSwitchDialogState = {
      phase: 'verdict',
      info: cleanInfo(),
      resolution: { kind: 'on-origin' },
    };
    expect(markSwitching(verdict, 'docs/notes.md')).toEqual({
      phase: 'switching',
      info: cleanInfo(),
      pendingDoc: 'docs/notes.md',
    });
  });

  test('renamed verdict → switching, navigating to the renamed path', () => {
    const verdict: BranchSwitchDialogState = {
      phase: 'verdict',
      info: cleanInfo(),
      resolution: { kind: 'renamed', renamedTo: 'guides/notes.md' },
    };
    expect(markSwitching(verdict, 'guides/notes.md')).toEqual({
      phase: 'switching',
      info: cleanInfo(),
      pendingDoc: 'guides/notes.md',
    });
  });
});

describe('classifyCheckoutOutcome — ff-diverged (FR9 fast-forward refusal)', () => {
  test('ff-diverged classifies to the branch-diverged action', () => {
    expect(classifyCheckoutOutcome({ ok: false, reason: 'ff-diverged' })).toEqual({
      action: 'branch-diverged',
    });
  });
});

describe('applyCheckoutOutcome — ff-diverged transition', () => {
  test('switching → verdict{diverged} with no toast (dialog offers a plain switch)', () => {
    const switching: BranchSwitchDialogState = {
      phase: 'switching',
      info: cleanInfo(),
      pendingDoc: 'docs/notes.md',
    };
    const result = applyCheckoutOutcome(switching, { ok: false, reason: 'ff-diverged' });
    expect(result.state).toEqual({
      phase: 'verdict',
      info: cleanInfo(),
      resolution: { kind: 'diverged' },
    });
    expect(result.sideEffect).toBeUndefined();
  });
});

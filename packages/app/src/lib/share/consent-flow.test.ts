import { describe, expect, test } from 'vitest';
import {
  applyOkInitOutcome,
  applyOpenOutcome,
  type ConsentFlowSeed,
  type ConsentFlowState,
  initialConsentFlowState,
  markCancelled,
  markInitializing,
} from './consent-flow';

const SEED: ConsentFlowSeed = {
  candidatePath: '/wt/feat-bar',
  branch: 'feat-bar',
  targetPath: 'docs/x.md',
  parentProjectName: 'agents-private',
};

describe('initialConsentFlowState', () => {
  test('starts in ready phase with the provided seed', () => {
    expect(initialConsentFlowState(SEED)).toEqual({ phase: 'ready', seed: SEED });
  });
});

describe('markInitializing', () => {
  test('ready → initializing', () => {
    expect(markInitializing(initialConsentFlowState(SEED))).toEqual({
      phase: 'initializing',
      seed: SEED,
    });
  });

  test('any other phase is identity (defensive double-click)', () => {
    const initializing: ConsentFlowState = { phase: 'initializing', seed: SEED };
    expect(markInitializing(initializing)).toBe(initializing);
    const opening: ConsentFlowState = { phase: 'opening', seed: SEED };
    expect(markInitializing(opening)).toBe(opening);
    const cancelled: ConsentFlowState = { phase: 'cancelled', seed: SEED };
    expect(markInitializing(cancelled)).toBe(cancelled);
  });
});

describe('applyOkInitOutcome', () => {
  test('initializing + ok → opening', () => {
    const result = applyOkInitOutcome(
      { phase: 'initializing', seed: SEED },
      { ok: true, projectPath: '/wt/feat-bar' },
    );
    expect(result).toEqual({ phase: 'opening', seed: SEED });
  });

  test('initializing + init-failed → error carries reason + message', () => {
    const result = applyOkInitOutcome(
      { phase: 'initializing', seed: SEED },
      { ok: false, reason: 'init-failed', message: 'symlink at .ok/' },
    );
    expect(result).toEqual({
      phase: 'error',
      seed: SEED,
      reason: 'init-failed',
      message: 'symlink at .ok/',
    });
  });

  test('initializing + not-a-git-worktree → error', () => {
    const result = applyOkInitOutcome(
      { phase: 'initializing', seed: SEED },
      { ok: false, reason: 'not-a-git-worktree', message: 'no .git' },
    );
    expect(result).toEqual({
      phase: 'error',
      seed: SEED,
      reason: 'not-a-git-worktree',
      message: 'no .git',
    });
  });

  test('initializing + network-error → error', () => {
    const result = applyOkInitOutcome(
      { phase: 'initializing', seed: SEED },
      { ok: false, reason: 'network-error', message: 'fetch failed' },
    );
    expect(result.phase).toBe('error');
    if (result.phase === 'error') expect(result.reason).toBe('network-error');
  });

  test('non-initializing phase is identity (delayed response after Cancel)', () => {
    const cancelled: ConsentFlowState = { phase: 'cancelled', seed: SEED };
    const result = applyOkInitOutcome(cancelled, { ok: true, projectPath: '/wt/feat-bar' });
    expect(result).toBe(cancelled);
  });
});

describe('applyOpenOutcome', () => {
  test('opening + ok → done', () => {
    const result = applyOpenOutcome({ phase: 'opening', seed: SEED }, { ok: true });
    expect(result).toEqual({ phase: 'done', seed: SEED });
  });

  test('opening + ok:false → error with network-error reason', () => {
    const result = applyOpenOutcome(
      { phase: 'opening', seed: SEED },
      { ok: false, message: 'IPC failed' },
    );
    expect(result).toEqual({
      phase: 'error',
      seed: SEED,
      reason: 'network-error',
      message: 'IPC failed',
    });
  });

  test('non-opening phase is identity', () => {
    const ready: ConsentFlowState = { phase: 'ready', seed: SEED };
    expect(applyOpenOutcome(ready, { ok: true })).toBe(ready);
  });
});

describe('markCancelled', () => {
  test('ready → cancelled', () => {
    expect(markCancelled(initialConsentFlowState(SEED))).toEqual({
      phase: 'cancelled',
      seed: SEED,
    });
  });

  test('initializing → cancelled (user cancelled during in-flight init)', () => {
    expect(markCancelled({ phase: 'initializing', seed: SEED })).toEqual({
      phase: 'cancelled',
      seed: SEED,
    });
  });

  test('opening → cancelled (user cancelled during in-flight open)', () => {
    expect(markCancelled({ phase: 'opening', seed: SEED })).toEqual({
      phase: 'cancelled',
      seed: SEED,
    });
  });

  test('done is terminal — Cancel is identity', () => {
    const done: ConsentFlowState = { phase: 'done', seed: SEED };
    expect(markCancelled(done)).toBe(done);
  });

  test('error is terminal — Cancel is identity', () => {
    const err: ConsentFlowState = {
      phase: 'error',
      seed: SEED,
      reason: 'init-failed',
      message: 'm',
    };
    expect(markCancelled(err)).toBe(err);
  });

  test('cancelled is idempotent', () => {
    const c: ConsentFlowState = { phase: 'cancelled', seed: SEED };
    expect(markCancelled(c)).toBe(c);
  });
});

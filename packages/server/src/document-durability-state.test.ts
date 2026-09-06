import { describe, expect, test, vi } from 'vitest';
import { DocumentDurabilityState } from './document-durability-state.ts';
import { getMetrics, resetMetrics } from './metrics.ts';

describe('DocumentDurabilityState', () => {
  test('starts with an empty main scope and no transient coordination state', () => {
    const state = new DocumentDurabilityState();

    expect(state.getActiveBranch()).toBe('main');
    expect(state.getReconciledBase('doc')).toBeUndefined();
    expect(state.peekInFlightFlush('doc')).toBeUndefined();
    expect(state.isBatchInProgress()).toBe(false);
    expect(state.consumeAgentWriteStore('doc')).toBe(false);
    expect(state.takeStoreFailure('doc')).toBeNull();
    expect(state.takeStoreDivergence('doc')).toBe(false);
  });

  test('retains reconciled bases independently for each visited branch', () => {
    const state = new DocumentDurabilityState();
    state.setReconciledBase('doc', 'main bytes');
    state.switchReconciledBaseScope('feature');
    state.setReconciledBase('doc', 'feature bytes');

    expect(state.getReconciledBase('doc')).toBe('feature bytes');
    state.switchReconciledBaseScope('main');
    expect(state.getReconciledBase('doc')).toBe('main bytes');
  });

  test('deletes a reconciled base only from the active branch', () => {
    const state = new DocumentDurabilityState();
    state.setReconciledBase('doc', 'main bytes');
    state.switchReconciledBaseScope('feature');
    state.setReconciledBase('doc', 'feature bytes');

    state.switchReconciledBaseScope('main');
    state.deleteReconciledBase('doc');
    expect(state.getReconciledBase('doc')).toBeUndefined();
    state.switchReconciledBaseScope('feature');
    expect(state.getReconciledBase('doc')).toBe('feature bytes');
  });

  test('isolates every owned coordination channel between instances', () => {
    const first = new DocumentDurabilityState();
    const second = new DocumentDurabilityState();
    first.setReconciledBase('doc', 'first');
    first.setBatchInProgress(true);
    first.beginInFlightFlush('doc', 'first flush');
    first.markAgentWriteStore('doc');
    first.recordStoreFailure('doc', { code: 'ENOSPC', message: 'full' });
    first.recordStoreDivergence('doc');

    expect(second.getReconciledBase('doc')).toBeUndefined();
    expect(second.isBatchInProgress()).toBe(false);
    expect(second.peekInFlightFlush('doc')).toBeUndefined();
    expect(second.consumeAgentWriteStore('doc')).toBe(false);
    expect(second.takeStoreFailure('doc')).toBeNull();
    expect(second.takeStoreDivergence('doc')).toBe(false);
  });

  test('does not let an older flush clear a newer in-flight snapshot', () => {
    const state = new DocumentDurabilityState();
    state.beginInFlightFlush('doc', 'older');
    state.beginInFlightFlush('doc', 'newer');
    state.finishInFlightFlush('doc', 'older');
    expect(state.peekInFlightFlush('doc')).toBe('newer');
    state.finishInFlightFlush('doc', 'newer');
    expect(state.peekInFlightFlush('doc')).toBeUndefined();
  });

  test('consumes agent markers, failures, and divergences once', () => {
    const state = new DocumentDurabilityState();
    state.markAgentWriteStore('doc');
    state.recordStoreFailure('doc', { message: 'write failed' });
    state.recordStoreDivergence('doc');

    expect(state.consumeAgentWriteStore('doc')).toBe(true);
    expect(state.consumeAgentWriteStore('doc')).toBe(false);
    expect(state.takeStoreFailure('doc')).toEqual({ message: 'write failed' });
    expect(state.takeStoreFailure('doc')).toBeNull();
    expect(state.takeStoreDivergence('doc')).toBe(true);
    expect(state.takeStoreDivergence('doc')).toBe(false);
  });

  test('clears a store failure without consuming another document failure', () => {
    const state = new DocumentDurabilityState();
    state.recordStoreFailure('cleared', { code: 'ENOSPC', message: 'full' });
    state.recordStoreFailure('retained', { message: 'readonly' });

    state.clearStoreFailure('cleared');
    expect(state.takeStoreFailure('cleared')).toBeNull();
    expect(state.takeStoreFailure('retained')).toEqual({ message: 'readonly' });
  });
});

describe('in-flight flush queue semantics', () => {
  test('finishing one of two identical snapshots leaves the other pending', () => {
    const state = new DocumentDurabilityState();
    state.beginInFlightFlush('doc', 'same');
    state.beginInFlightFlush('doc', 'same');
    state.finishInFlightFlush('doc', 'same');
    expect(state.inFlightFlushCount('doc')).toBe(1);
    expect(state.hasInFlightFlush('doc', 'same')).toBe(true);
    state.finishInFlightFlush('doc', 'same');
    expect(state.peekInFlightFlush('doc')).toBeUndefined();
    expect(state.inFlightFlushCount('doc')).toBe(0);
  });

  test('finishing a snapshot that was never begun leaves the queue untouched', () => {
    const state = new DocumentDurabilityState();
    state.beginInFlightFlush('doc', 'real');
    state.finishInFlightFlush('doc', 'never-begun');
    expect(state.inFlightFlushCount('doc')).toBe(1);
    expect(state.hasInFlightFlush('doc', 'real')).toBe(true);
  });

  test('a middle entry can finish out of order without disturbing its neighbours', () => {
    const state = new DocumentDurabilityState();
    state.beginInFlightFlush('doc', 'a');
    state.beginInFlightFlush('doc', 'b');
    state.beginInFlightFlush('doc', 'c');
    state.finishInFlightFlush('doc', 'b');
    expect(state.hasInFlightFlush('doc', 'a')).toBe(true);
    expect(state.hasInFlightFlush('doc', 'b')).toBe(false);
    expect(state.hasInFlightFlush('doc', 'c')).toBe(true);
    expect(state.peekInFlightFlush('doc')).toBe('c');
  });

  test('content absent from a populated queue does not match', () => {
    const state = new DocumentDurabilityState();
    state.beginInFlightFlush('doc', 'a');
    state.beginInFlightFlush('doc', 'b');
    expect(state.hasInFlightFlush('doc', 'absent')).toBe(false);
    expect(state.hasInFlightFlush('other-doc', 'a')).toBe(false);
  });

  test('a leaked entry expires on read, with no later flush needed to sweep it', () => {
    vi.useFakeTimers();
    try {
      const state = new DocumentDurabilityState();
      state.beginInFlightFlush('doc', 'leaked');
      expect(state.peekInFlightFlush('doc')).toBe('leaked');

      vi.advanceTimersByTime(61_000);

      expect(state.peekInFlightFlush('doc')).toBeUndefined();
      expect(state.inFlightFlushCount('doc')).toBe(0);
      expect(state.hasInFlightFlush('doc', 'leaked')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  test('deleting a doc clears its in-flight flush records alongside its reconciled base', () => {
    const state = new DocumentDurabilityState();
    state.setReconciledBase('doc', 'base');
    state.beginInFlightFlush('doc', 'pending');
    state.beginInFlightFlush('other', 'pending');

    state.deleteReconciledBase('doc');

    expect(state.getReconciledBase('doc')).toBeUndefined();
    expect(state.inFlightFlushCount('doc')).toBe(0);
    expect(state.inFlightFlushCount('other')).toBe(1);
  });

  test('switching branch scope leaves in-flight flush records alone, since a write in flight is not branch-scoped', () => {
    const state = new DocumentDurabilityState();
    state.beginInFlightFlush('doc', 'pending');

    state.switchReconciledBaseScope('feature');

    expect(state.inFlightFlushCount('doc')).toBe(1);
    expect(state.hasInFlightFlush('doc', 'pending')).toBe(true);
  });

  test('the expiry counter reports how many records were dropped, not how many prunes ran', () => {
    vi.useFakeTimers();
    try {
      resetMetrics();
      const state = new DocumentDurabilityState();
      state.beginInFlightFlush('doc', 'first');
      state.beginInFlightFlush('doc', 'second');

      vi.advanceTimersByTime(61_000);
      expect(state.inFlightFlushCount('doc')).toBe(0);

      expect(getMetrics().inFlightFlushExpired).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  test('a stale entry is also discarded when the next flush for the same document begins', () => {
    vi.useFakeTimers();
    try {
      const state = new DocumentDurabilityState();
      state.beginInFlightFlush('doc', 'leaked');
      vi.advanceTimersByTime(61_000);
      state.beginInFlightFlush('doc', 'fresh');

      expect(state.hasInFlightFlush('doc', 'leaked')).toBe(false);
      expect(state.inFlightFlushCount('doc')).toBe(1);
      state.finishInFlightFlush('doc', 'fresh');
      expect(state.peekInFlightFlush('doc')).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  test('a flush still in flight is not aged out while it keeps company with newer flushes', () => {
    vi.useFakeTimers();
    try {
      const state = new DocumentDurabilityState();
      state.beginInFlightFlush('doc', 'slow');
      vi.advanceTimersByTime(5_000);
      state.beginInFlightFlush('doc', 'quick');
      expect(state.hasInFlightFlush('doc', 'slow')).toBe(true);
      expect(state.inFlightFlushCount('doc')).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

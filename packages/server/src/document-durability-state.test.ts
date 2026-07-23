import { describe, expect, test } from 'vitest';
import { DocumentDurabilityState } from './document-durability-state.ts';

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

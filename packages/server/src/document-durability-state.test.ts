import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import * as Y from 'yjs';
import { DiskReceiptLog } from './disk-receipts.ts';
import {
  _resetDocExtensionsForTests,
  docNameToRelativePath,
  isRegisteredMarkdownDocName,
  registerDocExtension,
} from './doc-extensions.ts';
import {
  DISPLACED_VERSION_LIMIT,
  DISPLACED_VERSION_TTL_MS,
  DocumentDurabilityState,
  DocumentDurabilityStateError,
  editWasCarried,
  type StorePublishOutcome,
  WRITE_WAIT_BUDGET_MS,
  writtenThroughOf,
} from './document-durability-state.ts';
import * as tracedFs from './fs-traced.ts';
import { getLogger } from './logger.ts';
import { getMetrics, resetMetrics } from './metrics.ts';
import { contentHash } from './version-hash.ts';

describe('the merge a store recorded for agent writes', () => {
  const at = (clock: number) => ({ clientId: 7, clock });

  test('reaches every write the store carried, not only the first flush that reads it', () => {
    const state = new DocumentDurabilityState();
    state.recordStoreIntake('doc', 'both-kept', at(10));

    expect(state.readStoreIntake('doc', at(4))).toBe('both-kept');
    expect(state.readStoreIntake('doc', at(9))).toBe('both-kept');
  });

  test('never reaches a write that an earlier store did not carry', () => {
    const state = new DocumentDurabilityState();
    state.recordStoreIntake('doc', 'both-kept', at(5));
    state.recordStoreIntake('doc', 'merged', at(12));

    expect(state.readStoreIntake('doc', at(8))).toBe('merged');
    expect(state.readStoreIntake('doc', at(13))).toBeUndefined();
    expect(state.readStoreIntake('doc', { clientId: 8, clock: 1 })).toBeUndefined();
  });

  test('is cleared with the rest of the document state', () => {
    const state = new DocumentDurabilityState();
    state.recordStoreIntake('doc', 'kept-live', at(10));
    state.deleteReconciledBase('doc');

    expect(state.readStoreIntake('doc', at(4))).toBeUndefined();
  });
});

describe('DocumentDurabilityState', () => {
  test('starts with an empty main scope and no transient coordination state', () => {
    const state = new DocumentDurabilityState();

    expect(state.getActiveBranch()).toBe('main');
    expect(state.getReconciledBase('doc')).toBeUndefined();
    expect(state.peekInFlightFlush('doc')).toBeUndefined();
    expect(state.isBatchInProgress()).toBe(false);
    expect(state.consumeAgentWriteStore('doc')).toBe(false);
    expect(state.takeStoreFailure('doc')).toBeNull();
  });

  test('records receipts for a document without giving it a reconciled base', () => {
    const state = new DocumentDurabilityState('main', { receipts: new DiskReceiptLog() });
    state.recordReceiptAgreed('flow.mmd', 'graph TD\n');
    expect(state.getReceipt('flow.mmd')).toMatchObject({ via: 'agreed' });
    state.recordReceiptOwnWrite('flow.mmd', 'graph LR\n');
    expect(state.getReceipt('flow.mmd')).toMatchObject({ via: 'own-write' });
    expect(state.isRecentOwnWrite('flow.mmd', contentHash('graph LR\n'))).toBe(true);
    expect(state.getReconciledBase('flow.mmd')).toBeUndefined();
  });

  test('a batch held by two owners lasts until both release it, and only the last release ends it', () => {
    const state = new DocumentDurabilityState();
    state.holdBatch('head-watcher');
    state.holdBatch('sync-engine');
    state.holdBatch('sync-engine');

    expect(state.releaseBatch('conflict-resolve')).toBe(false);
    expect(state.isBatchInProgress()).toBe(true);
    expect(state.releaseBatch('sync-engine')).toBe(false);
    expect(state.isBatchInProgress()).toBe(true);
    expect(state.releaseBatch('head-watcher')).toBe(true);
    expect(state.isBatchInProgress()).toBe(false);
    expect(state.releaseBatch('head-watcher')).toBe(false);
  });

  test('keeps one reconciled base across branch switches, the bytes last agreed with disk', () => {
    const state = new DocumentDurabilityState();
    state.setReconciledBase('doc', 'main bytes');
    state.switchReconciledBaseScope('feature');
    expect(state.getReconciledBase('doc')).toBe('main bytes');

    state.setReconciledBase('doc', 'feature bytes');
    state.switchReconciledBaseScope('main');
    expect(state.getReconciledBase('doc')).toBe('feature bytes');
  });

  test('a base deleted on one branch stays deleted after a switch', () => {
    const state = new DocumentDurabilityState();
    state.setReconciledBase('doc', 'main bytes');
    state.switchReconciledBaseScope('feature');
    state.deleteReconciledBase('doc');

    state.switchReconciledBaseScope('main');
    expect(state.getReconciledBase('doc')).toBeUndefined();
  });

  test('a document with a stale external write on the target branch keeps that branch base', () => {
    const state = new DocumentDurabilityState();
    state.switchReconciledBaseScope('feature');
    state.setReconciledBase('doc', 'feature acknowledged');
    state.recordStaleExternalWrite('doc', 'stale bytes');
    state.switchReconciledBaseScope('main');
    state.setReconciledBase('doc', 'main bytes');

    state.switchReconciledBaseScope('feature');
    expect(state.getReconciledBase('doc')).toBe('feature acknowledged');
  });

  test('isolates every owned coordination channel between instances', async () => {
    const first = new DocumentDurabilityState();
    const second = new DocumentDurabilityState();
    first.setReconciledBase('doc', 'first');
    first.setBatchInProgress(true);
    first.beginInFlightFlush('doc', 'first flush');
    first.markAgentWriteStore('doc');
    first.recordStoreFailure('doc', { code: 'ENOSPC', message: 'full' });
    first.openDeferredStore('doc');

    expect(second.getReconciledBase('doc')).toBeUndefined();
    expect(second.isBatchInProgress()).toBe(false);
    expect(second.peekInFlightFlush('doc')).toBeUndefined();
    expect(second.consumeAgentWriteStore('doc')).toBe(false);
    expect(second.takeStoreFailure('doc')).toBeNull();
    await expect(second.awaitDeferredStoreOutcome('doc')).resolves.toBeUndefined();
  });

  test('holds writes until every admission hold is released', async () => {
    const state = new DocumentDurabilityState();
    await expect(state.whenWriteAdmitted()).resolves.toBe(true);

    state.setBatchInProgress(true);
    await expect(state.whenWriteAdmitted()).resolves.toBe(true);

    const releaseBranchSwitch = state.holdWriteAdmission();
    const releaseOverlapping = state.holdWriteAdmission();
    let settled = false;
    const waiting = state.whenWriteAdmitted().then((result) => {
      settled = true;
      return result;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);

    releaseOverlapping();
    releaseOverlapping();
    state.setBatchInProgress(false);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);

    releaseBranchSwitch();
    await expect(waiting).resolves.toBe(true);
    expect(state.isWriteAdmissionHeld()).toBe(false);
  });

  test('stops waiting for admission once the bound elapses', async () => {
    vi.useFakeTimers();
    try {
      const state = new DocumentDurabilityState();
      state.holdWriteAdmission();
      let result: boolean | undefined;
      const waiting = state.whenWriteAdmitted().then((admitted) => {
        result = admitted;
      });

      await vi.advanceTimersByTimeAsync(WRITE_WAIT_BUDGET_MS - 1);
      expect(result).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      await waiting;

      expect(result).toBe(false);
      expect(state.isWriteAdmissionHeld()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  test('bounds every wait inside one write budget by that budget together', async () => {
    vi.useFakeTimers();
    try {
      const state = new DocumentDurabilityState();
      state.holdWriteAdmission();
      state.openDeferredStore('doc');
      let finishedAt: number | undefined;
      const started = Date.now();
      const waits = state.runWithinWriteWaitBudget(async () => {
        const admitted = await state.whenWriteAdmitted();
        const outcome = await state.awaitDeferredStoreOutcome('doc');
        const admittedAgain = await state.whenWriteAdmitted();
        finishedAt = Date.now();
        return { admitted, outcome, admittedAgain };
      });

      await vi.advanceTimersByTimeAsync(WRITE_WAIT_BUDGET_MS - 1);
      expect(finishedAt).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);

      await expect(waits).resolves.toEqual({
        admitted: false,
        outcome: { kind: 'unsettled' },
        admittedAgain: false,
      });
      expect(finishedAt).toBe(started + WRITE_WAIT_BUDGET_MS);
    } finally {
      vi.useRealTimers();
    }
  });

  test('does not wait for a deferred store while no admission hold is active', async () => {
    const state = new DocumentDurabilityState();
    state.setBatchInProgress(true);
    state.openDeferredStore('doc');
    await expect(state.awaitDeferredStoreOutcome('doc')).resolves.toBeUndefined();
  });

  test('reports the outcome of the latest deferred store for a document', async () => {
    const state = new DocumentDurabilityState();
    state.holdWriteAdmission();
    await expect(state.awaitDeferredStoreOutcome('doc')).resolves.toBeUndefined();

    const earlier = state.openDeferredStore('doc');
    const earlierOutcome = state.awaitDeferredStoreOutcome('doc');
    const later = state.openDeferredStore('doc');
    const laterOutcome = state.awaitDeferredStoreOutcome('doc');

    earlier.settle({ kind: 'completed' });
    await expect(earlierOutcome).resolves.toEqual({ kind: 'completed' });
    const stillPending = state.awaitDeferredStoreOutcome('doc');

    later.settle({ kind: 'discarded' });
    await expect(laterOutcome).resolves.toEqual({ kind: 'discarded' });
    await expect(stillPending).resolves.toEqual({ kind: 'discarded' });
    await expect(state.awaitDeferredStoreOutcome('doc')).resolves.toBeUndefined();
  });

  test('reports a deferred store that has not settled within the bound as unsettled', async () => {
    vi.useFakeTimers();
    try {
      const state = new DocumentDurabilityState();
      state.holdWriteAdmission();
      state.openDeferredStore('doc');
      let result: unknown;
      const waiting = state.awaitDeferredStoreOutcome('doc').then((outcome) => {
        result = outcome;
      });

      await vi.advanceTimersByTimeAsync(WRITE_WAIT_BUDGET_MS - 1);
      expect(result).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      await waiting;

      expect(result).toEqual({ kind: 'unsettled' });
    } finally {
      vi.useRealTimers();
    }
  });

  test('reports a discard that lands within the bound', async () => {
    vi.useFakeTimers();
    try {
      const state = new DocumentDurabilityState();
      state.holdWriteAdmission();
      const deferral = state.openDeferredStore('doc');
      const waiting = state.awaitDeferredStoreOutcome('doc');

      await vi.advanceTimersByTimeAsync(WRITE_WAIT_BUDGET_MS - 1);
      deferral.settle({ kind: 'discarded' });

      await expect(waiting).resolves.toEqual({ kind: 'discarded' });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
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

  test('consumes agent markers and failures once', () => {
    const state = new DocumentDurabilityState();
    state.markAgentWriteStore('doc');
    state.recordStoreFailure('doc', { message: 'write failed' });

    expect(state.consumeAgentWriteStore('doc')).toBe(true);
    expect(state.consumeAgentWriteStore('doc')).toBe(false);
    expect(state.takeStoreFailure('doc')).toEqual({ message: 'write failed' });
    expect(state.takeStoreFailure('doc')).toBeNull();
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

describe('displaced-version history', () => {
  test('recognizes a version this server displaced and ignores one it never wrote', () => {
    const state = new DocumentDurabilityState();
    state.recordDisplacedVersion('doc', 'v1 bytes');

    expect(state.isDisplacedVersion('doc', 'v1 bytes')).toBe(true);
    expect(state.isDisplacedVersion('doc', 'never written')).toBe(false);
    expect(state.isDisplacedVersion('other-doc', 'v1 bytes')).toBe(false);
  });

  test('retains only the newest DISPLACED_VERSION_LIMIT versions per document', () => {
    const state = new DocumentDurabilityState();
    for (let i = 0; i <= DISPLACED_VERSION_LIMIT; i++) {
      state.recordDisplacedVersion('doc', `v${i}`);
    }

    expect(state.isDisplacedVersion('doc', 'v0')).toBe(false);
    expect(state.isDisplacedVersion('doc', 'v1')).toBe(true);
    expect(state.isDisplacedVersion('doc', `v${DISPLACED_VERSION_LIMIT}`)).toBe(true);
  });

  test('a re-displaced version refreshes in place instead of consuming another slot', () => {
    const state = new DocumentDurabilityState();
    for (let i = 0; i < DISPLACED_VERSION_LIMIT; i++) {
      state.recordDisplacedVersion('doc', 'repeat');
    }
    state.recordDisplacedVersion('doc', 'distinct');

    expect(state.isDisplacedVersion('doc', 'repeat')).toBe(true);
    expect(state.isDisplacedVersion('doc', 'distinct')).toBe(true);
  });

  test('a displaced version expires on read once its TTL has passed', () => {
    vi.useFakeTimers();
    try {
      const state = new DocumentDurabilityState();
      state.recordDisplacedVersion('doc', 'v1 bytes');
      expect(state.isDisplacedVersion('doc', 'v1 bytes')).toBe(true);

      vi.advanceTimersByTime(DISPLACED_VERSION_TTL_MS + 1_000);

      expect(state.isDisplacedVersion('doc', 'v1 bytes')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  test('displaced versions are scoped to the branch that displaced them', () => {
    const state = new DocumentDurabilityState();
    state.recordDisplacedVersion('doc', 'main v1');
    state.switchReconciledBaseScope('feature');

    expect(state.isDisplacedVersion('doc', 'main v1')).toBe(false);
    state.recordDisplacedVersion('doc', 'feature v1');
    state.switchReconciledBaseScope('main');
    expect(state.isDisplacedVersion('doc', 'feature v1')).toBe(false);
    expect(state.isDisplacedVersion('doc', 'main v1')).toBe(true);
  });

  test('deleting a doc clears its displaced versions, leaving other documents intact', () => {
    const state = new DocumentDurabilityState();
    state.recordDisplacedVersion('doc', 'v1 bytes');
    state.recordDisplacedVersion('other', 'v1 bytes');

    state.deleteReconciledBase('doc');

    expect(state.isDisplacedVersion('doc', 'v1 bytes')).toBe(false);
    expect(state.isDisplacedVersion('other', 'v1 bytes')).toBe(true);
  });

  test('tracks stale external conflicts per branch and clears them with document state', () => {
    const state = new DocumentDurabilityState();
    const conflict = state.recordStaleExternalWrite('doc', 'stale bytes');

    expect(state.staleExternalWriteMatches('doc', 'stale bytes')).toBe(true);
    expect(state.listStaleExternalWrites()).toEqual([conflict]);
    state.switchReconciledBaseScope('feature');
    expect(state.listStaleExternalWrites()).toEqual([]);
    state.switchReconciledBaseScope('main');
    state.deleteReconciledBase('doc');
    expect(state.listStaleExternalWrites()).toEqual([]);
  });

  test('restores displaced history, acknowledged content, and unresolved conflicts after restart', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ok-durability-state-'));
    const persistencePath = join(dir, 'stale-external-writes.json');
    try {
      const first = new DocumentDurabilityState('main', { persistencePath });
      first.setReconciledBase('doc', 'old bytes');
      first.recordDisplacedVersion('doc', 'old bytes');
      first.setReconciledBase('doc', 'acknowledged bytes');
      first.recordStaleExternalWrite('doc', 'old bytes');

      const restored = new DocumentDurabilityState('main', { persistencePath });

      expect(restored.getReconciledBase('doc')).toBe('acknowledged bytes');
      expect(restored.isDisplacedVersion('doc', 'old bytes')).toBe(true);
      expect(restored.staleExternalWriteMatches('doc', 'old bytes')).toBe(true);

      restored.deleteReconciledBase('doc');
      const afterDelete = new DocumentDurabilityState('main', { persistencePath });
      expect(afterDelete.getReconciledBase('doc')).toBeUndefined();
      expect(afterDelete.isDisplacedVersion('doc', 'old bytes')).toBe(false);
      expect(afterDelete.staleExternalWriteMatches('doc', 'old bytes')).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('keeps unresolved persisted conflicts after their displaced-history window expires', () => {
    vi.useFakeTimers();
    const dir = mkdtempSync(join(tmpdir(), 'ok-durability-conflict-'));
    const persistencePath = join(dir, 'stale-external-writes.json');
    try {
      const first = new DocumentDurabilityState('main', { persistencePath });
      first.setReconciledBase('doc', 'acknowledged bytes');
      first.recordDisplacedVersion('doc', 'old bytes');
      first.recordStaleExternalWrite('doc', 'old bytes');
      vi.advanceTimersByTime(DISPLACED_VERSION_TTL_MS + 1_000);

      const restored = new DocumentDurabilityState('main', { persistencePath });

      expect(restored.getReconciledBase('doc')).toBe('acknowledged bytes');
      expect(restored.isDisplacedVersion('doc', 'old bytes')).toBe(false);
      expect(restored.staleExternalWriteMatches('doc', 'old bytes')).toBe(true);
    } finally {
      vi.useRealTimers();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('sweeps expired inactive history without expiring unresolved conflicts', () => {
    vi.useFakeTimers();
    const dir = mkdtempSync(join(tmpdir(), 'ok-durability-expiry-'));
    const persistencePath = join(dir, 'state.json');
    try {
      const state = new DocumentDurabilityState('main', { persistencePath });
      state.setReconciledBase('expired-doc', 'acknowledged');
      state.recordDisplacedVersion('expired-doc', 'old');
      state.setReconciledBase('conflicted-doc', 'preserved');
      state.recordDisplacedVersion('conflicted-doc', 'rejected');
      state.recordStaleExternalWrite('conflicted-doc', 'rejected');
      state.switchReconciledBaseScope('feature');
      vi.advanceTimersByTime(DISPLACED_VERSION_TTL_MS + 1);
      state.setReconciledBase('fresh-doc', 'new acknowledged');
      state.recordDisplacedVersion('fresh-doc', 'new old');
      const serialized = readFileSync(persistencePath, 'utf-8');
      expect(serialized).not.toContain('expired-doc');
      expect(serialized).toContain('conflicted-doc');
      const restored = new DocumentDurabilityState('main', { persistencePath });
      expect(restored.getReconciledBase('conflicted-doc')).toBe('preserved');
      expect(restored.staleExternalWriteMatches('conflicted-doc', 'rejected')).toBe(true);
    } finally {
      vi.useRealTimers();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a branch switch purges expired restored plaintext but retains unresolved recovery data', () => {
    vi.useFakeTimers();
    const dir = mkdtempSync(join(tmpdir(), 'ok-durability-restored-expiry-'));
    const persistencePath = join(dir, 'state.json');
    try {
      const state = new DocumentDurabilityState('main', { persistencePath });
      state.setReconciledBase('expired', 'expired plaintext');
      state.recordDisplacedVersion('expired', 'old');
      state.setReconciledBase('pending', 'protected plaintext');
      state.recordStaleExternalWrite('pending', 'rejected');
      vi.advanceTimersByTime(DISPLACED_VERSION_TTL_MS + 1);
      const beforeRestore = readFileSync(persistencePath, 'utf-8');
      const restored = new DocumentDurabilityState('main', { persistencePath });
      expect(restored.getReconciledBase('expired')).toBeUndefined();
      expect(readFileSync(persistencePath, 'utf-8')).toBe(beforeRestore);
      restored.switchReconciledBaseScope('feature');
      expect(readFileSync(persistencePath, 'utf-8')).not.toContain('expired plaintext');
      expect(readFileSync(persistencePath, 'utf-8')).toContain('protected plaintext');
      expect(readFileSync(persistencePath, 'utf-8')).toContain('rejected');
    } finally {
      vi.useRealTimers();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('failed durable clearing retains the conflict until a successful retry', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ok-durability-clear-'));
    const persistencePath = join(dir, 'state.json');
    try {
      const state = new DocumentDurabilityState('main', { persistencePath });
      state.setReconciledBase('doc', 'acknowledged');
      state.recordStaleExternalWrite('doc', 'rejected');
      renameSync(persistencePath, `${persistencePath}.backup`);
      mkdirSync(persistencePath);
      expect(() => state.clearStaleExternalWrite('doc')).toThrow();
      expect(state.getStaleExternalWrite('doc')?.diskContent).toBe('rejected');
      expect(readdirSync(dir).filter((name) => name.includes('.tmp.'))).toEqual([]);
      rmSync(persistencePath, { recursive: true });
      renameSync(`${persistencePath}.backup`, persistencePath);
      const restored = new DocumentDurabilityState('main', { persistencePath });
      expect(restored.getStaleExternalWrite('doc')?.diskContent).toBe('rejected');
      state.clearStaleExternalWrite('doc');
      expect(state.getStaleExternalWrite('doc')).toBeUndefined();
      expect(
        new DocumentDurabilityState('main', { persistencePath }).getStaleExternalWrite('doc'),
      ).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test.each([
    ['{invalid', 'corrupt'],
    [JSON.stringify({ version: 2, branches: {} }), 'incompatible'],
    [JSON.stringify({ version: 1, branches: { main: [{ docName: 'bad' }] } }), 'corrupt'],
  ])('preserves invalid recovery state and fails with actionable %s diagnostics', (raw, kind) => {
    const dir = mkdtempSync(join(tmpdir(), 'ok-durability-invalid-'));
    const persistencePath = join(dir, 'state.json');
    try {
      writeFileSync(persistencePath, raw);
      expect(() => new DocumentDurabilityState('main', { persistencePath })).toThrow(
        DocumentDurabilityStateError,
      );
      try {
        new DocumentDurabilityState('main', { persistencePath });
      } catch (error) {
        expect(error).toMatchObject({ kind, path: persistencePath });
        expect(error instanceof Error ? error.message : '').toContain('Do not delete');
      }
      expect(readFileSync(persistencePath, 'utf-8')).toBe(raw);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('reports an unreadable snapshot without replacing it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ok-durability-unreadable-'));
    const persistencePath = join(dir, 'state.json');
    try {
      mkdirSync(persistencePath);
      expect(() => new DocumentDurabilityState('main', { persistencePath })).toThrow(
        expect.objectContaining({ kind: 'unreadable', path: persistencePath }),
      );
      expect(statSync(persistencePath).isDirectory()).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test.each([
    ['EACCES', 'permissions'],
    ['EPERM', 'permissions'],
    ['EISDIR', 'regular file'],
    ['EIO', 'filesystem'],
  ])('unreadable %s diagnostics name the filesystem problem', (code, guidance) => {
    const cause = Object.assign(new Error('read failed'), { code });
    const error = new DocumentDurabilityStateError('/project/state.json', 'unreadable', cause);
    expect(error.message).toContain(code);
    expect(error.message).toContain(guidance);
    expect(error.message).not.toContain('Restore this snapshot from a known-good backup');
    expect(error.cause).toBe(cause);
  });

  test('incompatible diagnostics do not claim an unrecorded writer version is known', () => {
    const error = new DocumentDurabilityStateError('/project/state.json', 'incompatible');
    expect(error.message).not.toContain('version that wrote');
    expect(error.message).toContain('schema');
  });

  test('a tracked target is re-derived from docName rather than trusted from the snapshot', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ok-durability-target-'));
    const persistencePath = join(dir, 'state.json');
    try {
      const state = new DocumentDurabilityState('main', { persistencePath });
      state.setReconciledBase('protected', 'acknowledged');
      state.recordStaleExternalWrite('protected', 'old');
      const tampered = readFileSync(persistencePath, 'utf-8').replace(
        '"file":"protected.md"',
        '"file":"unrelated.md"',
      );
      writeFileSync(persistencePath, tampered);
      const restored = new DocumentDurabilityState('main', { persistencePath });
      expect(restored.getStaleExternalWrite('protected')?.file).toBe('protected.md');
      expect(restored.listStaleExternalWrites().map((entry) => entry.file)).toEqual([
        'protected.md',
      ]);
      expect(readFileSync(persistencePath, 'utf-8')).toBe(tampered);
      const invalidPath = new Error('document path escapes content directory');
      expect(
        () =>
          new DocumentDurabilityState('main', {
            persistencePath,
            fileForDocName: () => {
              throw invalidPath;
            },
          }),
      ).toThrow(expect.objectContaining({ kind: 'corrupt', cause: invalidPath }));
      expect(readFileSync(persistencePath, 'utf-8')).toBe(tampered);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('re-recording the same disk hash with a new retained edit does not count a new conflict', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ok-durability-recount-'));
    const persistencePath = join(dir, 'state.json');
    try {
      const state = new DocumentDurabilityState('main', { persistencePath });
      state.setReconciledBase('doc', 'acknowledged');
      const beforeCount = getMetrics().staleExternalWriteRefused;
      state.recordStaleExternalWrite('doc', 'old');
      expect(getMetrics().staleExternalWriteRefused).toBe(beforeCount + 1);
      const first = state.getStaleExternalWrite('doc');
      state.recordStaleExternalWrite('doc', 'old', 'a pending edit');
      expect(getMetrics().staleExternalWriteRefused).toBe(beforeCount + 1);
      expect(state.getStaleExternalWrite('doc')?.retainedContent).toBe('a pending edit');
      expect(state.getStaleExternalWrite('doc')?.detectedAt).toBe(first?.detectedAt);
      state.recordStaleExternalWrite('doc', 'newer disk bytes');
      expect(getMetrics().staleExternalWriteRefused).toBe(beforeCount + 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('an .mdx document restored before the watcher scan resolves to its .mdx file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ok-durability-mdx-'));
    const persistencePath = join(dir, 'state.json');
    const options = {
      persistencePath,
      fileForDocName: docNameToRelativePath,
      hasResolvedExtension: isRegisteredMarkdownDocName,
    };
    try {
      _resetDocExtensionsForTests();
      registerDocExtension('notes/guide', '.mdx');
      const state = new DocumentDurabilityState('main', options);
      state.setReconciledBase('notes/guide', 'acknowledged');
      state.recordStaleExternalWrite('notes/guide', 'old');
      expect(state.getStaleExternalWrite('notes/guide')?.file).toBe('notes/guide.mdx');

      _resetDocExtensionsForTests();
      const booting = new DocumentDurabilityState('main', options);
      expect(booting.getStaleExternalWrite('notes/guide')?.file).toBe('notes/guide.mdx');
      expect(booting.listStaleExternalWrites().map((entry) => entry.file)).toEqual([
        'notes/guide.mdx',
      ]);
    } finally {
      _resetDocExtensionsForTests();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a scan that observes .md displaces an .mdx snapshot instead of being outranked by it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ok-durability-mdx-renamed-'));
    const persistencePath = join(dir, 'state.json');
    const options = {
      persistencePath,
      fileForDocName: docNameToRelativePath,
      hasResolvedExtension: isRegisteredMarkdownDocName,
    };
    try {
      _resetDocExtensionsForTests();
      registerDocExtension('notes/guide', '.mdx');
      const state = new DocumentDurabilityState('main', options);
      state.setReconciledBase('notes/guide', 'acknowledged');
      state.recordStaleExternalWrite('notes/guide', 'old');
      expect(state.getStaleExternalWrite('notes/guide')?.file).toBe('notes/guide.mdx');

      _resetDocExtensionsForTests();
      const booting = new DocumentDurabilityState('main', options);
      expect(registerDocExtension('notes/guide', '.md')).toEqual({
        effective: '.md',
        changed: true,
        shadowed: null,
      });
      expect(booting.getStaleExternalWrite('notes/guide')?.file).toBe('notes/guide.md');
    } finally {
      _resetDocExtensionsForTests();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a restored file naming an extension the registry rejects still opens the project', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ok-durability-mmd-'));
    const persistencePath = join(dir, 'state.json');
    const options = {
      persistencePath,
      fileForDocName: docNameToRelativePath,
      hasResolvedExtension: isRegisteredMarkdownDocName,
    };
    try {
      _resetDocExtensionsForTests();
      const state = new DocumentDurabilityState('main', options);
      state.setReconciledBase('flow.mmd', 'acknowledged');
      state.recordStaleExternalWrite('flow.mmd', 'old');
      expect(state.getStaleExternalWrite('flow.mmd')?.file).toBe('flow.mmd');

      _resetDocExtensionsForTests();
      const booting = new DocumentDurabilityState('main', options);
      expect(booting.getStaleExternalWrite('flow.mmd')?.file).toBe('flow.mmd');
    } finally {
      _resetDocExtensionsForTests();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a conflict file is re-derived from the resolver on every read, never replayed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ok-durability-moved-'));
    const persistencePath = join(dir, 'state.json');
    try {
      const state = new DocumentDurabilityState('main', {
        persistencePath,
        fileForDocName: (docName) => `sub/${docName}.md`,
      });
      state.setReconciledBase('guide', 'acknowledged');
      state.recordStaleExternalWrite('guide', 'old');
      expect(state.getStaleExternalWrite('guide')?.file).toBe('sub/guide.md');

      const moved = new DocumentDurabilityState('main', {
        persistencePath,
        fileForDocName: (docName) => `moved/${docName}.md`,
      });
      expect(moved.getStaleExternalWrite('guide')?.file).toBe('moved/guide.md');
      expect(moved.listStaleExternalWrites().map((entry) => entry.file)).toEqual([
        'moved/guide.md',
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('an unrelated mutation on a document whose conflict file moved does not re-notify', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ok-durability-renotify-'));
    const persistencePath = join(dir, 'state.json');
    const changed = vi.fn();
    let prefix = 'sub';
    try {
      const state = new DocumentDurabilityState('main', {
        persistencePath,
        fileForDocName: (docName) => `${prefix}/${docName}.md`,
        onStaleExternalWriteChange: changed,
      });
      state.setReconciledBase('guide', 'acknowledged');
      state.recordStaleExternalWrite('guide', 'old');
      expect(changed).toHaveBeenCalledTimes(1);

      prefix = 'moved';
      expect(state.getStaleExternalWrite('guide')?.file).toBe('moved/guide.md');
      state.setReconciledBase('guide', 'a later acknowledgement');
      expect(changed).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('ordinary clears and branch switches create no snapshot, and restore does not rewrite one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ok-durability-noop-'));
    const persistencePath = join(dir, 'state.json');
    try {
      const state = new DocumentDurabilityState('main', { persistencePath });
      state.setReconciledBase('ordinary', 'content');
      state.clearStaleExternalWrite('ordinary');
      state.clearDisplacedVersions('ordinary');
      state.deleteReconciledBase('ordinary');
      state.switchReconciledBaseScope('feature');
      expect(existsSync(persistencePath)).toBe(false);
      state.setReconciledBase('protected', 'content');
      state.recordDisplacedVersion('protected', 'old');
      utimesSync(persistencePath, 1, 1);
      const before = statSync(persistencePath);
      new DocumentDurabilityState('feature', { persistencePath });
      expect(statSync(persistencePath).mtimeMs).toBe(before.mtimeMs);
      if (process.platform !== 'win32') expect(before.mode & 0o777).toBe(0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('all persisted mutators retain their previous state when the atomic replacement fails', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ok-durability-atomic-'));
    const persistencePath = join(dir, 'state.json');
    const changed = vi.fn();
    try {
      const state = new DocumentDurabilityState('main', {
        persistencePath,
        onStaleExternalWriteChange: changed,
      });
      state.setReconciledBase('doc', 'acknowledged');
      state.recordDisplacedVersion('doc', 'old');
      const beforeCount = getMetrics().staleExternalWriteRefused;
      state.recordStaleExternalWrite('doc', 'old');
      state.recordStaleExternalWrite('doc', 'old');
      expect(getMetrics().staleExternalWriteRefused).toBe(beforeCount + 1);
      expect(changed).toHaveBeenCalledTimes(1);
      renameSync(persistencePath, `${persistencePath}.backup`);
      mkdirSync(persistencePath);
      for (const mutate of [
        () => state.setReconciledBase('doc', 'changed'),
        () => state.recordDisplacedVersion('doc', 'another'),
        () => state.clearDisplacedVersions('doc'),
        () => state.recordStaleExternalWrite('doc', 'another'),
        () => state.clearStaleExternalWrite('doc'),
        () => state.deleteReconciledBase('doc'),
      ]) {
        expect(mutate).toThrow();
        expect(state.getReconciledBase('doc')).toBe('acknowledged');
        expect(state.getStaleExternalWrite('doc')?.diskContent).toBe('old');
        expect(state.isDisplacedVersion('doc', 'old')).toBe(true);
        expect(state.isDisplacedVersion('doc', 'another')).toBe(false);
        expect(changed).toHaveBeenCalledTimes(1);
        expect(getMetrics().staleExternalWriteRefused).toBe(beforeCount + 1);
        expect(readdirSync(dir).filter((name) => name.includes('.tmp.'))).toEqual([]);
      }
      rmSync(persistencePath, { recursive: true });
      renameSync(`${persistencePath}.backup`, persistencePath);
      const restored = new DocumentDurabilityState('main', {
        persistencePath,
        onStaleExternalWriteChange: changed,
      });
      expect(changed).toHaveBeenCalledTimes(1);
      restored.clearStaleExternalWrite('doc');
      expect(changed).toHaveBeenCalledTimes(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('keeps the original replacement failure when temporary-file cleanup also fails', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ok-durability-cleanup-'));
    const persistencePath = join(dir, 'state.json');
    let originalError: unknown;
    const state = new DocumentDurabilityState('main', { persistencePath });
    state.setReconciledBase('doc', 'acknowledged');
    mkdirSync(persistencePath);
    const renameSpy = vi.spyOn(tracedFs, 'tracedRenameSync').mockImplementation((from, to) => {
      try {
        renameSync(from, to);
      } catch (cause) {
        originalError = cause;
        rmSync(from);
        mkdirSync(from);
        throw cause;
      }
    });
    const warnSpy = vi.spyOn(getLogger('document-durability-state'), 'warn');
    try {
      let actualError: unknown;
      try {
        state.recordDisplacedVersion('doc', 'old');
      } catch (cause) {
        actualError = cause;
      }
      expect(originalError).toBeInstanceOf(Error);
      expect(actualError).toBe(originalError);
      expect(state.isDisplacedVersion('doc', 'old')).toBe(false);
      const payload = (warnSpy.mock.calls[0]?.[0] ?? {}) as { writeError?: unknown };
      expect(payload.writeError).toBe((originalError as Error).message);
      expect(JSON.stringify(payload.writeError)).not.toBe('{}');
    } finally {
      warnSpy.mockRestore();
      renameSpy.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a different rejected version preserves the retained candidate across restart', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ok-durability-retained-'));
    const persistencePath = join(dir, 'state.json');
    try {
      const state = new DocumentDurabilityState('main', { persistencePath });
      state.setReconciledBase('doc', 'acknowledged');
      state.recordDisplacedVersion('doc', 'old A');
      state.recordDisplacedVersion('doc', 'old Z');
      state.recordStaleExternalWrite('doc', 'old A', 'retained C');
      state.recordStaleExternalWrite('doc', 'old Z');
      const restored = new DocumentDurabilityState('main', { persistencePath });
      expect(restored.getStaleExternalWrite('doc')).toMatchObject({
        diskContent: 'old Z',
        retainedContent: 'retained C',
      });
      restored.recordStaleExternalWrite('doc', 'old A', '');
      expect(restored.getStaleExternalWrite('doc')?.retainedContent).toBe('');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('store publish generation primitives', () => {
  test('beginStoreAttempt issues monotonically increasing tokens per document', () => {
    const state = new DocumentDurabilityState();
    expect(state.beginStoreAttempt('doc')).toEqual({ docName: 'doc', generation: 1 });
    expect(state.beginStoreAttempt('doc')).toEqual({ docName: 'doc', generation: 2 });
    expect(state.beginStoreAttempt('doc')).toEqual({ docName: 'doc', generation: 3 });
    expect(state.beginStoreAttempt('other')).toEqual({ docName: 'other', generation: 1 });
  });

  test('tryPublishStore refuses a stale token without publishing and without moving the published watermark', () => {
    const state = new DocumentDurabilityState();
    const first = state.beginStoreAttempt('doc');
    const second = state.beginStoreAttempt('doc');
    let publishCalls = 0;
    expect(
      state.tryPublishStore(second, () => {
        publishCalls += 1;
      }),
    ).toBe('published');
    expect(publishCalls).toBe(1);
    expect(
      state.tryPublishStore(first, () => {
        publishCalls += 1;
      }),
    ).toBe('stale');
    expect(publishCalls).toBe(1);
    expect(
      state.tryPublishStore(first, () => {
        publishCalls += 1;
      }),
    ).toBe('stale');
    expect(publishCalls).toBe(1);
  });

  test('tryPublishStore refuses an already-published token and advances the watermark only on publish', () => {
    const state = new DocumentDurabilityState();
    const first = state.beginStoreAttempt('doc');
    const second = state.beginStoreAttempt('doc');
    const third = state.beginStoreAttempt('doc');
    let publishCalls = 0;
    expect(
      state.tryPublishStore(second, () => {
        publishCalls += 1;
      }),
    ).toBe('published');
    expect(
      state.tryPublishStore(second, () => {
        publishCalls += 1;
      }),
    ).toBe('stale');
    expect(
      state.tryPublishStore(first, () => {
        publishCalls += 1;
      }),
    ).toBe('stale');
    expect(
      state.tryPublishStore(third, () => {
        publishCalls += 1;
      }),
    ).toBe('published');
    expect(
      state.tryPublishStore(second, () => {
        publishCalls += 1;
      }),
    ).toBe('stale');
    expect(
      state.tryPublishStore(third, () => {
        publishCalls += 1;
      }),
    ).toBe('stale');
    expect(publishCalls).toBe(2);
  });

  test('tryPublishStore invokes the publish callback synchronously before returning', () => {
    const state = new DocumentDurabilityState();
    const token = state.beginStoreAttempt('doc');
    let committed = false;
    const accepted = state.tryPublishStore(token, () => {
      committed = true;
    });
    expect(accepted).toBe('published');
    expect(committed).toBe(true);
  });

  test('tryPublishStore rejects a publish callback that returns a thenable instead of publishing synchronously', () => {
    const state = new DocumentDurabilityState();
    const token = state.beginStoreAttempt('doc');
    let renamed = false;
    expect(() =>
      state.tryPublishStore(token, async () => {
        await Promise.resolve();
        renamed = true;
      }),
    ).toThrow(TypeError);
    expect(renamed).toBe(false);
    expect(
      state.tryPublishStore(token, () => {
        renamed = true;
      }),
    ).toBe('published');
    expect(renamed).toBe(true);
  });

  test('a rejecting async publish callback throws without leaking an unhandled rejection', async () => {
    const state = new DocumentDurabilityState();
    const token = state.beginStoreAttempt('doc');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(() =>
        state.tryPublishStore(token, async () => {
          await Promise.reject(new Error('in-flight rename failed'));
        }),
      ).toThrow(TypeError);
      await new Promise((resolve) => setImmediate(resolve));
      const events = warnSpy.mock.calls
        .map((call) => call.map(String).join(' '))
        .filter((line) => line.includes('"event":"persistence-store-publish-async-rejected"'));
      expect(events).toHaveLength(1);
      const payload = JSON.parse(events[0]) as Record<string, unknown>;
      expect(payload['doc.name']).toBe('doc');
      expect(payload.generation).toBe(1);
      expect(payload.error).toBe('in-flight rename failed');
    } finally {
      warnSpy.mockRestore();
    }
  });

  test('a non-Error rejection reason still lands the async-rejected event without crashing the handler', async () => {
    const state = new DocumentDurabilityState();
    const token = state.beginStoreAttempt('doc');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(() =>
        state.tryPublishStore(token, async () => {
          await Promise.reject({ toString: 1 });
        }),
      ).toThrow(TypeError);
      await new Promise((resolve) => setImmediate(resolve));
      const events = warnSpy.mock.calls
        .map((call) => call.map(String).join(' '))
        .filter((line) => line.includes('"event":"persistence-store-publish-async-rejected"'));
      expect(events).toHaveLength(1);
      const payload = JSON.parse(events[0]) as Record<string, unknown>;
      expect(payload['doc.name']).toBe('doc');
      expect(payload.generation).toBe(1);
      expect(typeof payload.error).toBe('string');
      expect(payload.error).not.toBe('');
    } finally {
      warnSpy.mockRestore();
    }
  });

  test('an Error cause carrying a non-string message still lands the event with a string reason', async () => {
    const state = new DocumentDurabilityState();
    const token = state.beginStoreAttempt('doc');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const hostile = new Error('placeholder');
      const circular: Record<string, unknown> = {};
      circular.self = circular;
      hostile.message = circular;
      expect(() =>
        state.tryPublishStore(token, async () => {
          await Promise.reject(hostile);
        }),
      ).toThrow(TypeError);
      await new Promise((resolve) => setImmediate(resolve));
      const events = warnSpy.mock.calls
        .map((call) => call.map(String).join(' '))
        .filter((line) => line.includes('"event":"persistence-store-publish-async-rejected"'));
      expect(events).toHaveLength(1);
      const payload = JSON.parse(events[0]) as Record<string, unknown>;
      expect(payload['doc.name']).toBe('doc');
      expect(payload.generation).toBe(1);
      expect(typeof payload.error).toBe('string');
    } finally {
      warnSpy.mockRestore();
    }
  });

  test('a sync-throwing then on a refused thenable still surfaces the TypeError contract', () => {
    const state = new DocumentDurabilityState();
    const token = state.beginStoreAttempt('doc');
    const syncThrowing = () => {};
    Reflect.set(syncThrowing, 'then', () => {
      throw new Error('then threw synchronously');
    });
    expect(() => state.tryPublishStore(token, () => syncThrowing)).toThrow(TypeError);
    expect(state.tryPublishStore(token, () => {})).toBe('published');
  });

  test('a self-resolving thenable return is refused without assimilating it into the promise machinery', () => {
    const state = new DocumentDurabilityState();
    const token = state.beginStoreAttempt('doc');
    const selfResolving = () => {};
    Reflect.set(selfResolving, 'then', (onFulfilled: (value: unknown) => void) => {
      onFulfilled(selfResolving);
    });
    expect(() => state.tryPublishStore(token, () => selfResolving)).toThrow(TypeError);
    expect(state.tryPublishStore(token, () => {})).toBe('published');
  });

  test('tryPublishStore rejects a thenable that is a function carrying a then method', () => {
    const state = new DocumentDurabilityState();
    const token = state.beginStoreAttempt('doc');
    const callableThenable = () => {};
    Reflect.set(callableThenable, 'then', () => {});
    expect(() => state.tryPublishStore(token, () => callableThenable)).toThrow(TypeError);
    expect(state.tryPublishStore(token, () => {})).toBe('published');
  });

  test('a nested publish attempt inside the gate is refused before its callback runs and the outer attempt completes', () => {
    const state = new DocumentDurabilityState();
    const stale = state.beginStoreAttempt('doc');
    const outer = state.beginStoreAttempt('doc');
    const afterOuter = state.beginStoreAttempt('doc');
    let publishCalls = 0;
    let nestedOutcome: StorePublishOutcome | undefined;
    expect(
      state.tryPublishStore(outer, () => {
        publishCalls += 1;
        nestedOutcome = state.tryPublishStore(stale, () => {
          publishCalls += 1;
        });
      }),
    ).toBe('published');
    expect(nestedOutcome).toBe('reentrant');
    expect(publishCalls).toBe(1);
    expect(
      state.tryPublishStore(outer, () => {
        publishCalls += 1;
      }),
    ).toBe('stale');
    expect(
      state.tryPublishStore(afterOuter, () => {
        publishCalls += 1;
      }),
    ).toBe('published');
    expect(publishCalls).toBe(2);
  });

  test('a reentrant attempt with a higher generation is still refused while the outer publish is in flight', () => {
    const state = new DocumentDurabilityState();
    const outer = state.beginStoreAttempt('doc');
    const nested = state.beginStoreAttempt('doc');
    let publishCalls = 0;
    let nestedOutcome: StorePublishOutcome | undefined;
    expect(
      state.tryPublishStore(outer, () => {
        publishCalls += 1;
        nestedOutcome = state.tryPublishStore(nested, () => {
          publishCalls += 1;
        });
      }),
    ).toBe('published');
    expect(nestedOutcome).toBe('reentrant');
    expect(publishCalls).toBe(1);
    expect(
      state.tryPublishStore(outer, () => {
        publishCalls += 1;
      }),
    ).toBe('stale');
    expect(
      state.tryPublishStore(nested, () => {
        publishCalls += 1;
      }),
    ).toBe('published');
    expect(publishCalls).toBe(2);
  });

  test('an in-flight publish for one document does not refuse a nested publish for another document', () => {
    const state = new DocumentDurabilityState();
    const docToken = state.beginStoreAttempt('doc');
    const otherToken = state.beginStoreAttempt('other');
    let docPublishCalls = 0;
    let otherPublishCalls = 0;
    let nestedOtherOutcome: StorePublishOutcome | undefined;
    let docReentryOutcome: StorePublishOutcome | undefined;
    expect(
      state.tryPublishStore(docToken, () => {
        docPublishCalls += 1;
        nestedOtherOutcome = state.tryPublishStore(otherToken, () => {
          otherPublishCalls += 1;
        });
        docReentryOutcome = state.tryPublishStore(docToken, () => {
          docPublishCalls += 1;
        });
      }),
    ).toBe('published');
    expect(nestedOtherOutcome).toBe('published');
    expect(otherPublishCalls).toBe(1);
    expect(docReentryOutcome).toBe('reentrant');
    expect(docPublishCalls).toBe(1);
    const otherFollowUp = state.beginStoreAttempt('other');
    expect(
      state.tryPublishStore(otherFollowUp, () => {
        otherPublishCalls += 1;
      }),
    ).toBe('published');
    expect(otherPublishCalls).toBe(2);
  });

  test('a reentrant attempt that is also stale is still refused as reentrant while the outer publish is in flight', () => {
    const state = new DocumentDurabilityState();
    const first = state.beginStoreAttempt('doc');
    expect(state.tryPublishStore(first, () => {})).toBe('published');
    const outer = state.beginStoreAttempt('doc');
    let publishCalls = 0;
    let nestedOutcome: StorePublishOutcome | undefined;
    expect(
      state.tryPublishStore(outer, () => {
        publishCalls += 1;
        nestedOutcome = state.tryPublishStore(first, () => {
          publishCalls += 1;
        });
      }),
    ).toBe('published');
    expect(nestedOutcome).toBe('reentrant');
    expect(publishCalls).toBe(1);
  });

  test('a throwing publish callback propagates without advancing the published watermark', () => {
    const state = new DocumentDurabilityState();
    const first = state.beginStoreAttempt('doc');
    expect(state.tryPublishStore(first, () => {})).toBe('published');
    const second = state.beginStoreAttempt('doc');
    expect(() =>
      state.tryPublishStore(second, () => {
        throw new Error('rename failed');
      }),
    ).toThrow('rename failed');
    expect(state.tryPublishStore(second, () => {})).toBe('published');
    const third = state.beginStoreAttempt('doc');
    expect(state.tryPublishStore(third, () => {})).toBe('published');
  });

  test('a pre-delete store token stays outranked across the delete boundary', () => {
    const state = new DocumentDurabilityState();
    const stale = state.beginStoreAttempt('doc');
    const current = state.beginStoreAttempt('doc');
    const otherFirst = state.beginStoreAttempt('other');
    const otherSecond = state.beginStoreAttempt('other');
    let publishCalls = 0;
    expect(
      state.tryPublishStore(current, () => {
        publishCalls += 1;
      }),
    ).toBe('published');
    expect(
      state.tryPublishStore(stale, () => {
        publishCalls += 1;
      }),
    ).toBe('stale');
    expect(
      state.tryPublishStore(otherSecond, () => {
        publishCalls += 1;
      }),
    ).toBe('published');

    state.deleteReconciledBase('doc');

    expect(state.beginStoreAttempt('doc')).toEqual({ docName: 'doc', generation: 3 });
    expect(
      state.tryPublishStore(stale, () => {
        publishCalls += 1;
      }),
    ).toBe('stale');
    const postDelete = state.beginStoreAttempt('doc');
    expect(postDelete).toEqual({ docName: 'doc', generation: 4 });
    expect(
      state.tryPublishStore(postDelete, () => {
        publishCalls += 1;
      }),
    ).toBe('published');
    expect(
      state.tryPublishStore(stale, () => {
        publishCalls += 1;
      }),
    ).toBe('stale');
    expect(publishCalls).toBe(3);
    expect(state.beginStoreAttempt('other')).toEqual({ docName: 'other', generation: 3 });
    expect(
      state.tryPublishStore(otherFirst, () => {
        publishCalls += 1;
      }),
    ).toBe('stale');
    expect(publishCalls).toBe(3);
  });

  test('a pre-delete store token stays outranked across a persisted delete', () => {
    const state = new DocumentDurabilityState();
    state.recordDisplacedVersion('doc', 'displaced bytes');
    const stale = state.beginStoreAttempt('doc');
    const current = state.beginStoreAttempt('doc');
    let publishCalls = 0;
    expect(
      state.tryPublishStore(current, () => {
        publishCalls += 1;
      }),
    ).toBe('published');
    expect(
      state.tryPublishStore(stale, () => {
        publishCalls += 1;
      }),
    ).toBe('stale');

    state.deleteReconciledBase('doc');

    expect(state.beginStoreAttempt('doc')).toEqual({ docName: 'doc', generation: 3 });
    expect(
      state.tryPublishStore(stale, () => {
        publishCalls += 1;
      }),
    ).toBe('stale');
    const postDelete = state.beginStoreAttempt('doc');
    expect(
      state.tryPublishStore(postDelete, () => {
        publishCalls += 1;
      }),
    ).toBe('published');
    expect(
      state.tryPublishStore(stale, () => {
        publishCalls += 1;
      }),
    ).toBe('stale');
    expect(publishCalls).toBe(2);
  });

  test('a refused-store mark does not survive an unpersisted teardown', () => {
    const state = new DocumentDurabilityState();
    state.markStoreRefused('doc');
    state.recordStoreFailure('doc', { code: 'ENOSPC', message: 'no space left on device' });
    expect(state.isStoreRefused('doc')).toBe(true);

    state.deleteReconciledBase('doc');

    expect(state.isStoreRefused('doc')).toBe(false);
    expect(state.getRefusedStoreDocNames()).toEqual([]);
    expect(state.takeStoreFailure('doc')).toBeNull();
  });

  test('a refused-store mark does not survive a persisted teardown', () => {
    const state = new DocumentDurabilityState();
    state.recordDisplacedVersion('doc', 'displaced bytes');
    state.markStoreRefused('doc');
    state.recordStoreFailure('doc', { code: 'ENOSPC', message: 'no space left on device' });
    expect(state.isStoreRefused('doc')).toBe(true);

    state.deleteReconciledBase('doc');

    expect(state.isStoreRefused('doc')).toBe(false);
    expect(state.getRefusedStoreDocNames()).toEqual([]);
    expect(state.takeStoreFailure('doc')).toBeNull();
  });

  test('tearing one document down leaves a sibling document refused', () => {
    const state = new DocumentDurabilityState();
    state.markStoreRefused('doc');
    state.markStoreRefused('sibling');

    state.deleteReconciledBase('doc');

    expect(state.isStoreRefused('sibling')).toBe(true);
    expect(state.getRefusedStoreDocNames()).toEqual(['sibling']);
  });
});

describe('DocumentDurabilityStateError names the running channel CLI', () => {
  test('Stable keeps its exact message', () => {
    vi.stubEnv('OK_CHANNEL', 'stable');
    try {
      expect(new DocumentDurabilityStateError('/p/state.json', 'corrupt').message).toBe(
        'Cannot safely open this project: its stale-write recovery snapshot is corrupt (/p/state.json). The snapshot has been preserved because it may contain the only copy of protected edits. Restore this snapshot from a known-good backup, or contact support to recover its protected edits. Run ok bug-report from the project directory to collect diagnostics without starting the server. Do not delete it to bypass recovery.',
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test('Beta names ok-beta bug-report', () => {
    vi.stubEnv('OK_CHANNEL', 'beta');
    try {
      expect(new DocumentDurabilityStateError('/p/state.json', 'corrupt').message).toContain(
        'Run ok-beta bug-report from the project directory',
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('the durable receipt follows the acknowledged base', () => {
  test('setting the base records it as agreed, a store records it as an own write, and a delete forgets it', () => {
    const state = new DocumentDurabilityState();
    state.setReconciledBase('doc', 'loaded\n');
    expect(state.getReceipt('doc')).toMatchObject({
      hash: contentHash('loaded\n'),
      via: 'agreed',
    });

    const observation = { size: 7n, mtimeNs: 5n, dev: 1n, ino: 9n };
    state.recordSuccessfulStore('doc', 'stored\n', undefined, observation);
    expect(state.getReceipt('doc')).toMatchObject({
      hash: contentHash('stored\n'),
      via: 'own-write',
      ino: '9',
    });
    expect(state.isRecentOwnWrite('doc', contentHash('loaded\n'))).toBe(false);
    expect(state.isRecentOwnWrite('doc', contentHash('stored\n'))).toBe(true);

    state.deleteReconciledBase('doc');
    expect(state.getReceipt('doc')).toBeUndefined();
  });

  test('a store that displaces an agent-acknowledged version still records the written bytes', () => {
    const state = new DocumentDurabilityState();
    state.setReconciledBase('doc', 'before\n');
    state.recordSuccessfulStore('doc', 'after\n', 'before\n');
    expect(state.getReceipt('doc')?.hash).toBe(contentHash('after\n'));
    expect(state.getReconciledBase('doc')).toBe('after\n');
  });

  test('the check at load reports a missing, unchanged or changed receipt and counts it', () => {
    resetMetrics();
    const dir = mkdtempSync(join(tmpdir(), 'ok-durability-receipts-'));
    try {
      const path = join(dir, 'receipts.jsonl');
      const before = new DocumentDurabilityState('main', {
        receipts: new DiskReceiptLog({ path }),
      });
      expect(before.checkReceiptAtLoad('doc', 'first\n')).toBe('missing');
      before.setReconciledBase('doc', 'first\n');

      const restarted = new DocumentDurabilityState('main', {
        receipts: new DiskReceiptLog({ path }),
      });
      expect(restarted.getReconciledBase('doc')).toBeUndefined();
      expect(restarted.checkReceiptAtLoad('doc', 'first\n')).toBe('unchanged');
      expect(restarted.checkReceiptAtLoad('doc', 'edited while closed\n')).toBe('changed');
      expect(getMetrics().receiptAtLoad).toEqual({ missing: 1, unchanged: 1, changed: 1 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('an outside change to a document that is not loaded refreshes the receipt it already has', () => {
    const receipts = new DiskReceiptLog();
    receipts.recordAgreed('closed', 'v1\n');
    const state = new DocumentDurabilityState('main', { receipts });

    state.refreshReceiptWithoutBase('closed', 'v2\n');
    expect(state.getReceipt('closed')?.hash).toBe(contentHash('v2\n'));

    state.refreshReceiptWithoutBase('never-loaded', 'bytes\n');
    expect(state.getReceipt('never-loaded')).toBeUndefined();

    state.setReconciledBase('loaded', 'v1\n');
    state.refreshReceiptWithoutBase('loaded', 'v2\n');
    expect(state.getReceipt('loaded')?.hash).toBe(contentHash('v1\n'));
  });
});

describe('which edits a rename outside the app carried to the new name', () => {
  function frozenDocWithCarriedAndLaterEdit() {
    const document = new Y.Doc();
    const source = document.getText('source');
    source.insert(0, 'Before the move.\n');
    const carriedEdit = writtenThroughOf(document);
    const carried = writtenThroughOf(document);
    source.insert(source.length, 'After the move.\n');
    const laterEdit = writtenThroughOf(document);
    return { carriedEdit, carried, laterEdit };
  }

  test('an edit the carry included is carried, and an edit made after it is not', () => {
    const { carriedEdit, carried, laterEdit } = frozenDocWithCarriedAndLaterEdit();
    expect(editWasCarried(carriedEdit, carried)).toBe(true);
    expect(editWasCarried(laterEdit, carried)).toBe(false);
    expect(editWasCarried(carriedEdit, null)).toBe(false);
    expect(editWasCarried(undefined, carried)).toBe(false);
    expect(editWasCarried({ ...carriedEdit, clientId: carriedEdit.clientId + 1 }, carried)).toBe(
      false,
    );
  });

  test('a write refused while the carry runs waits for it, and a failed carry answers not carried', async () => {
    const state = new DocumentDurabilityState();
    const { carried } = frozenDocWithCarriedAndLaterEdit();
    const carry = state.beginRenameCarry('notes');
    let answered = false;
    const answer = state.awaitRenameCarry('notes', carry).then((value) => {
      answered = true;
      return value;
    });
    await Promise.resolve();
    expect(answered).toBe(false);
    state.settleRenameCarry('notes', null);
    expect(await answer).toEqual({ kind: 'settled', carried: null });

    const archive = state.beginRenameCarry('archive');
    const carriedAnswer = state.awaitRenameCarry('archive', archive);
    state.settleRenameCarry('archive', carried);
    expect(await carriedAnswer).toEqual({ kind: 'settled', carried });
    expect(await state.awaitRenameCarry('archive', state.renameCarryOf('archive'))).toEqual({
      kind: 'settled',
      carried,
    });
  });

  test('a route that begins a carry and never reaches it answers not carried', async () => {
    const state = new DocumentDurabilityState();
    const carry = state.beginRenameCarry('notes');
    expect(state.beginRenameCarry('notes')).toBe(carry);
    state.abandonRenameCarry('notes');
    expect(await carry).toEqual({ kind: 'settled', carried: null });
  });

  test('a revive while the carry runs still answers the waiting write, and the late settle leaves no record', async () => {
    const state = new DocumentDurabilityState();
    const { carried } = frozenDocWithCarriedAndLaterEdit();
    const carry = state.beginRenameCarry('notes');
    state.endRenameCarry('notes');
    state.settleRenameCarry('notes', carried);
    expect(await carry).toEqual({ kind: 'settled', carried });
    expect(state.renameCarryOf('notes')).toBeUndefined();

    state.beginRenameCarry('archive');
    state.settleRenameCarry('archive', carried);
    state.endRenameCarry('archive');
    expect(state.renameCarryOf('archive')).toBeUndefined();
    state.settleRenameCarry('archive', carried);
    expect(state.renameCarryOf('archive')).toBeUndefined();
  });

  test('ending every record at shutdown answers a waiting write as stopped and leaves none', async () => {
    const state = new DocumentDurabilityState();
    const { carried } = frozenDocWithCarriedAndLaterEdit();
    const pending = state.beginRenameCarry('notes');
    state.beginRenameCarry('archive');
    state.settleRenameCarry('archive', carried);
    state.endAllRenameCarries();
    expect(await pending).toEqual({ kind: 'stopped' });
    expect(state.renameCarryOf('notes')).toBeUndefined();
    expect(state.renameCarryOf('archive')).toBeUndefined();
  });

  test("a carry that outlasts the write's remaining wait answers unsettled, never not carried", async () => {
    const state = new DocumentDurabilityState();
    const carry = state.beginRenameCarry('notes');
    const warn = vi
      .spyOn(getLogger('document-durability-state'), 'warn')
      .mockImplementation(() => {});
    try {
      const started = Date.now();
      const answer = await state.runWithinWriteWaitBudget(
        () => state.awaitRenameCarry('notes', carry),
        20,
      );
      expect(answer).toEqual({ kind: 'unsettled' });
      expect(Date.now() - started).toBeLessThan(WRITE_WAIT_BUDGET_MS);
      expect(warn).toHaveBeenCalledOnce();
    } finally {
      warn.mockRestore();
    }
  });
});

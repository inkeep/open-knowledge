import { describe, expect, test } from 'bun:test';
import {
  getMetrics,
  handleCollabSocketError,
  incrementBatch,
  incrementBranchSwitch,
  incrementBridgeMergeCheckpointCreated,
  incrementBridgeMergeContentLoss,
  incrementCollabSocketFilteredError,
  incrementConflict,
  incrementMapDrivenSpliceApplied,
  incrementMapDrivenSpliceFallback,
  incrementPark,
  incrementReconcile,
  incrementRescueBuffer,
  incrementUpstreamImport,
  resetMetrics,
} from './metrics';

describe('reconciliation metrics', () => {
  test('starts with zero counters', () => {
    resetMetrics();
    const m = getMetrics();
    expect(m.reconcileCount).toBe(0);
    expect(m.conflictCount).toBe(0);
    expect(m.batchCount).toBe(0);
    expect(m.upstreamImportCount).toBe(0);
    expect(m.rescueBufferCount).toBe(0);
    expect(m.branchSwitchCount).toBe(0);
    expect(m.parkCount).toBe(0);
    expect(m.bridgeMergeContentLoss).toBe(0);
    expect(m.bridgeMergeCheckpointCreated).toBe(0);
  });

  test('bridge-correctness counters increment independently (SPEC §6 R9)', () => {
    resetMetrics();
    incrementBridgeMergeContentLoss();
    incrementBridgeMergeContentLoss();
    incrementBridgeMergeContentLoss();
    incrementBridgeMergeCheckpointCreated();
    incrementBridgeMergeCheckpointCreated();
    const m = getMetrics();
    expect(m.bridgeMergeContentLoss).toBe(3);
    expect(m.bridgeMergeCheckpointCreated).toBe(2);
  });

  test('increments each counter independently', () => {
    resetMetrics();
    incrementReconcile();
    incrementReconcile();
    incrementConflict();
    incrementBatch();
    incrementBatch();
    incrementBatch();
    incrementUpstreamImport();
    incrementRescueBuffer();
    incrementBranchSwitch();
    incrementPark();
    incrementPark();

    const m = getMetrics();
    expect(m.reconcileCount).toBe(2);
    expect(m.conflictCount).toBe(1);
    expect(m.batchCount).toBe(3);
    expect(m.upstreamImportCount).toBe(1);
    expect(m.rescueBufferCount).toBe(1);
    expect(m.branchSwitchCount).toBe(1);
    expect(m.parkCount).toBe(2);
  });

  test('map-driven splice counters: applied increments and fallback is keyed by reason', () => {
    resetMetrics();
    incrementMapDrivenSpliceApplied();
    incrementMapDrivenSpliceApplied();
    incrementMapDrivenSpliceFallback('parse-error');
    incrementMapDrivenSpliceFallback('parse-error');
    incrementMapDrivenSpliceFallback('text-mismatch');
    incrementMapDrivenSpliceFallback('synthetic-doc');
    incrementMapDrivenSpliceFallback('missing-position');
    const m = getMetrics();
    expect(m.mapDrivenSpliceApplied).toBe(2);
    expect(m.mapDrivenSpliceFallback).toEqual({
      'parse-error': 2,
      'text-mismatch': 1,
      'synthetic-doc': 1,
      'missing-position': 1,
    });
  });

  test('getMetrics returns a snapshot (not a reference)', () => {
    resetMetrics();
    incrementReconcile();
    const snapshot = getMetrics();
    incrementReconcile();
    expect(snapshot.reconcileCount).toBe(1);
    expect(getMetrics().reconcileCount).toBe(2);
  });

  test('resetMetrics clears all counters', () => {
    incrementReconcile();
    incrementConflict();
    incrementBatch();
    incrementBranchSwitch();
    incrementPark();
    resetMetrics();
    const m = getMetrics();
    for (const [key, value] of Object.entries(m)) {
      // Map-shaped metrics reset to {} (empty record) — cc1LastSeq tracks
      // CC1 channel watermarks; bridgeToleranceApplied tracks per-class
      // tolerance counts; mapDrivenSpliceFallback tracks per-reason splice
      // fallbacks. All are populated keyed by string at runtime.
      if (
        key === 'cc1LastSeq' ||
        key === 'bridgeToleranceApplied' ||
        key === 'mapDrivenSpliceFallback'
      ) {
        expect(value).toEqual({});
      } else {
        expect(value).toBe(0);
      }
    }
  });
});

describe('collab-socket error filter (precedent §23)', () => {
  test('handleCollabSocketError filters EPIPE and increments epipe counter', () => {
    resetMetrics();
    const err = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }) as NodeJS.ErrnoException;
    const filtered = handleCollabSocketError(err);
    expect(filtered).toBe(true);
    const m = getMetrics();
    expect(m.collabSocketEpipeCount).toBe(1);
    expect(m.collabSocketEconnresetCount).toBe(0);
  });

  test('handleCollabSocketError filters ECONNRESET and increments econnreset counter', () => {
    resetMetrics();
    const err = Object.assign(new Error('read ECONNRESET'), {
      code: 'ECONNRESET',
    }) as NodeJS.ErrnoException;
    const filtered = handleCollabSocketError(err);
    expect(filtered).toBe(true);
    const m = getMetrics();
    expect(m.collabSocketEpipeCount).toBe(0);
    expect(m.collabSocketEconnresetCount).toBe(1);
  });

  test('handleCollabSocketError does NOT filter other error codes', () => {
    // Exhaustive list of codes that are NOT the known-safe kernel TCP-teardown
    // signals from precedent §23. Each one should surface (return false) so the
    // caller's normal logging path fires. Adding a new known-safe code means
    // adding it BOTH to `handleCollabSocketError` AND to this test's filtered
    // set — the contract is mechanically enforced here.
    resetMetrics();
    const codes = [
      'ETIMEDOUT',
      'ECONNABORTED',
      'ENOTCONN',
      'ECONNREFUSED',
      'EHOSTUNREACH',
      'ENETUNREACH',
      'EPROTO',
      undefined, // err.code absent entirely
    ];
    for (const code of codes) {
      const err = Object.assign(new Error(`simulated ${code ?? 'no-code'}`), {
        code,
      }) as NodeJS.ErrnoException;
      const filtered = handleCollabSocketError(err);
      expect(filtered).toBe(false);
    }
    // And none of these bumped the filtered-error counters.
    const m = getMetrics();
    expect(m.collabSocketEpipeCount).toBe(0);
    expect(m.collabSocketEconnresetCount).toBe(0);
  });

  test('handleCollabSocketError counters accumulate across multiple calls', () => {
    resetMetrics();
    for (let i = 0; i < 5; i++) {
      const err = Object.assign(new Error('EPIPE'), { code: 'EPIPE' }) as NodeJS.ErrnoException;
      handleCollabSocketError(err);
    }
    for (let i = 0; i < 3; i++) {
      const err = Object.assign(new Error('ECONNRESET'), {
        code: 'ECONNRESET',
      }) as NodeJS.ErrnoException;
      handleCollabSocketError(err);
    }
    const m = getMetrics();
    expect(m.collabSocketEpipeCount).toBe(5);
    expect(m.collabSocketEconnresetCount).toBe(3);
  });

  test('incrementCollabSocketFilteredError low-level API still works (for test harnesses)', () => {
    resetMetrics();
    incrementCollabSocketFilteredError('EPIPE');
    incrementCollabSocketFilteredError('EPIPE');
    incrementCollabSocketFilteredError('ECONNRESET');
    const m = getMetrics();
    expect(m.collabSocketEpipeCount).toBe(2);
    expect(m.collabSocketEconnresetCount).toBe(1);
  });

  test('getMetrics snapshot includes collab-socket fields (wire contract for /api/metrics/reconciliation)', () => {
    // The /api/metrics/reconciliation endpoint returns `getMetrics()` directly,
    // so this test verifies the wire contract: operators
    // querying the endpoint WILL see the two new counters with the documented
    // names. If the names change, this test fails and the endpoint's consumers
    // (dashboards, alerting) need explicit review.
    resetMetrics();
    const m = getMetrics();
    expect(m).toHaveProperty('collabSocketEpipeCount');
    expect(m).toHaveProperty('collabSocketEconnresetCount');
    expect(typeof m.collabSocketEpipeCount).toBe('number');
    expect(typeof m.collabSocketEconnresetCount).toBe('number');
  });
});

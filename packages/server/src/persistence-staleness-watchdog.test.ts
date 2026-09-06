import { normalizeBridge } from '@inkeep/open-knowledge-core';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as Y from 'yjs';
import { isPersistenceExcludedDoc } from './cc1-broadcast.ts';
import { FROZEN_LIFECYCLE_STATUSES } from './conflict-errors.ts';
import { DocumentDurabilityState } from './document-durability-state.ts';
import { getMetrics, resetMetrics } from './metrics.ts';
import {
  createPersistenceStalenessWatchdog,
  type StalenessWatchdogHandle,
  type StalenessWatchdogOptions,
  StructuralDiskReadError,
} from './persistence-staleness-watchdog.ts';

const GRACE_MS = 1_000;

interface Rig {
  watchdog: StalenessWatchdogHandle;
  docs: Map<string, Y.Doc>;
  bases: Map<string, string>;
  disk: Map<string, string>;
  txAges: Map<string, number>;
  forceCalls: string[];
  clock: { nowMs: number };
  batchActive: { value: boolean };
  inFlight: Set<string>;
  hangDocs: Set<string>;
  hangSettlers: Map<string, { resolve: () => void; reject: (err: unknown) => void }>;
  forceBehavior: {
    mode: 'advance-base' | 'no-op' | 'throw';
  };
  diskReadFault: { kind: 'transient' | 'structural' | null };
}

function makeDoc(source: string): Y.Doc {
  const doc = new Y.Doc();
  doc.getText('source').insert(0, source);
  return doc;
}

function makeRig(overrides: Partial<StalenessWatchdogOptions> = {}): Rig {
  const docs = new Map<string, Y.Doc>();
  const bases = new Map<string, string>();
  const disk = new Map<string, string>();
  const txAges = new Map<string, number>();
  const forceCalls: string[] = [];
  const clock = { nowMs: 100_000 };
  const batchActive = { value: false };
  const inFlight = new Set<string>();
  const hangDocs = new Set<string>();
  const hangSettlers = new Map<string, { resolve: () => void; reject: (err: unknown) => void }>();
  const forceBehavior: Rig['forceBehavior'] = { mode: 'advance-base' };
  const diskReadFault: Rig['diskReadFault'] = { kind: null };

  const watchdog = createPersistenceStalenessWatchdog({
    getLoadedDocuments: () => docs,
    forceStore: async (document, documentName) => {
      forceCalls.push(documentName);
      if (hangDocs.has(documentName)) {
        await new Promise<void>((resolve, reject) => {
          hangSettlers.set(documentName, { resolve, reject });
        });
      }
      if (forceBehavior.mode === 'throw') throw new Error('injected store failure');
      if (forceBehavior.mode === 'advance-base') {
        const bytes = document.getText('source').toString();
        bases.set(documentName, bytes);
        disk.set(documentName, bytes);
      }
    },
    readDiskBytes: (documentName) => {
      if (diskReadFault.kind === 'structural') {
        throw new StructuralDiskReadError('injected structural refusal');
      }
      if (diskReadFault.kind === 'transient') throw new Error('injected disk read failure');
      return disk.get(documentName) ?? null;
    },
    graceMs: GRACE_MS,
    sweepIntervalMs: 3_600_000,
    now: () => clock.nowMs,
    getBase: (documentName) => bases.get(documentName),
    isBatchActive: () => batchActive.value,
    hasInFlight: (documentName) => inFlight.has(documentName),
    msSinceLastUserTx: (doc) => {
      for (const [name, d] of docs) {
        if (d === doc) return txAges.get(name) ?? null;
      }
      return null;
    },
    ...overrides,
  });

  return {
    watchdog,
    docs,
    bases,
    disk,
    txAges,
    forceCalls,
    clock,
    batchActive,
    inFlight,
    hangDocs,
    hangSettlers,
    forceBehavior,
    diskReadFault,
  };
}

function seedWedgedDoc(rig: Rig, name: string): Y.Doc {
  const doc = makeDoc('# edited in memory\n');
  rig.docs.set(name, doc);
  rig.bases.set(name, '# old on disk\n');
  rig.disk.set(name, '# old on disk\n');
  rig.txAges.set(name, GRACE_MS * 10);
  return doc;
}

let rig: Rig;

beforeEach(() => {
  resetMetrics();
  rig = makeRig();
});

afterEach(async () => {
  await rig.watchdog.dispose();
});

describe('staleness detection and forced store', () => {
  test('force-stores a doc divergent past the grace window and counts it', async () => {
    seedWedgedDoc(rig, 'wedged-doc');

    await rig.watchdog.sweep();

    expect(rig.forceCalls).toEqual(['wedged-doc']);
    expect(getMetrics().persistenceStalenessDetected).toBe(1);
    expect(getMetrics().persistenceStalenessForcedStores).toBe(1);
    await rig.watchdog.sweep();
    expect(rig.forceCalls).toEqual(['wedged-doc']);
  });

  test('does not force while the last user transaction is younger than the grace window', async () => {
    seedWedgedDoc(rig, 'active-doc');
    rig.txAges.set('active-doc', GRACE_MS - 1);

    await rig.watchdog.sweep();

    expect(rig.forceCalls).toEqual([]);
    expect(getMetrics().persistenceStalenessDetected).toBe(0);
  });

  test('treats a null transaction age as old enough', async () => {
    seedWedgedDoc(rig, 'no-tx-doc');
    rig.txAges.delete('no-tx-doc');

    await rig.watchdog.sweep();

    expect(rig.forceCalls).toEqual(['no-tx-doc']);
  });

  test('ignores docs whose memory matches the reconciled base', async () => {
    const doc = makeDoc('# same\n');
    rig.docs.set('clean-doc', doc);
    rig.bases.set('clean-doc', '# same\n');
    rig.disk.set('clean-doc', '# same\n');
    rig.txAges.set('clean-doc', GRACE_MS * 10);

    await rig.watchdog.sweep();

    expect(rig.forceCalls).toEqual([]);
  });

  test('classifies frontmatter-carrying docs with the store spine comparator', async () => {
    const fmBase = '---\ntitle: x\n---\n\n# body\n\n\n';
    const doc = makeDoc('---\ntitle: x\n---\n\n# body\n');
    rig.docs.set('fm-doc', doc);
    rig.bases.set('fm-doc', fmBase);
    rig.disk.set('fm-doc', fmBase);
    rig.txAges.set('fm-doc', GRACE_MS * 10);

    await rig.watchdog.sweep();
    expect(rig.forceCalls).toEqual([]);

    doc.getText('source').delete(0, doc.getText('source').length);
    doc.getText('source').insert(0, '---\ntitle: y\n---\n\n# body\n');
    await rig.watchdog.sweep();
    expect(rig.forceCalls).toEqual(['fm-doc']);
  });

  test('rescues a blank run the normalized comparator cannot see', async () => {
    const base = 'Above.\n\nBelow.\n';
    const widened = 'Above.\n\n\n\nBelow.\n';
    expect(normalizeBridge(base)).toBe(normalizeBridge(widened));

    const doc = makeDoc(widened);
    rig.docs.set('blank-run-doc', doc);
    rig.bases.set('blank-run-doc', base);
    rig.disk.set('blank-run-doc', base);
    rig.txAges.set('blank-run-doc', GRACE_MS * 10);

    await rig.watchdog.sweep();
    expect(rig.forceCalls).toEqual(['blank-run-doc']);

    await rig.watchdog.sweep();
    expect(rig.forceCalls).toEqual(['blank-run-doc']);
  });

  test('leaves a doc alone when the base carries the wider run', async () => {
    const doc = makeDoc('- a\n\n- b\n');
    rig.docs.set('collapsed-doc', doc);
    rig.bases.set('collapsed-doc', '- a\n\n\n- b\n');
    rig.disk.set('collapsed-doc', '- a\n\n\n- b\n');
    rig.txAges.set('collapsed-doc', GRACE_MS * 10);

    await rig.watchdog.sweep();
    expect(rig.forceCalls).toEqual([]);
  });

  test('materializes a never-persisted doc with content and no disk file', async () => {
    const doc = makeDoc('# brand new\n');
    rig.docs.set('new-doc', doc);
    rig.txAges.set('new-doc', GRACE_MS * 10);

    await rig.watchdog.sweep();

    expect(rig.forceCalls).toEqual(['new-doc']);
  });
});

describe('exclusions', () => {
  test('isPersistenceExcludedDoc admits exactly the dedicated-store-path doc classes', () => {
    for (const name of [
      '__system__',
      '__config__/project',
      '__user__/config.yml',
      '__local__/project',
      '__skill__/project/foo',
      '__template__/notes/weekly',
      'diagram.mmd',
      'assets/flow.mermaid',
      'src/util.ts',
      'config.json',
      'styles.css',
    ]) {
      expect(isPersistenceExcludedDoc(name)).toBe(true);
    }
    for (const name of ['notes', 'folder/doc', 'README', 'docs/getting-started.mdx']) {
      expect(isPersistenceExcludedDoc(name)).toBe(false);
    }
  });

  test('skips system, config, managed-artifact, and mermaid docs', async () => {
    for (const name of [
      '__system__',
      '__config__/project',
      '__user__/config.yml',
      '__local__/project',
      '__skill__/project/foo',
      '__template__/notes/weekly',
      'diagram.mmd',
    ]) {
      const doc = makeDoc('# divergent\n');
      rig.docs.set(name, doc);
      rig.bases.set(name, '# other\n');
      rig.txAges.set(name, GRACE_MS * 10);
    }

    await rig.watchdog.sweep();

    expect(rig.forceCalls).toEqual([]);
    expect(getMetrics().persistenceStalenessDetected).toBe(0);
  });

  test('skips docs frozen by lifecycle status', async () => {
    for (const status of FROZEN_LIFECYCLE_STATUSES) {
      const doc = seedWedgedDoc(rig, `lifecycle-${status}`);
      doc.getMap('lifecycle').set('status', status);
    }

    await rig.watchdog.sweep();

    expect(rig.forceCalls).toEqual([]);
  });

  test('skips the whole sweep while a coordinated batch is active', async () => {
    seedWedgedDoc(rig, 'batch-doc');
    rig.batchActive.value = true;

    await rig.watchdog.sweep();
    expect(rig.forceCalls).toEqual([]);

    rig.batchActive.value = false;
    await rig.watchdog.sweep();
    expect(rig.forceCalls).toEqual(['batch-doc']);
  });

  test('a batch activating mid-sweep does not decline the parked store', async () => {
    const parkingRig = makeRig({
      forceStore: async (_document, documentName) => {
        parkingRig.forceCalls.push(documentName);
        parkingRig.batchActive.value = true;
      },
    });
    try {
      seedWedgedDoc(parkingRig, 'parked-doc');

      await parkingRig.watchdog.sweep();
      expect(parkingRig.forceCalls).toEqual(['parked-doc']);

      parkingRig.batchActive.value = false;
      parkingRig.clock.nowMs += GRACE_MS + 1;
      await parkingRig.watchdog.sweep();
      expect(parkingRig.forceCalls).toEqual(['parked-doc', 'parked-doc']);
    } finally {
      await parkingRig.watchdog.dispose();
    }
  });

  test('skips a doc whose flush is currently mid-commit', async () => {
    seedWedgedDoc(rig, 'inflight-doc');
    rig.inFlight.add('inflight-doc');

    await rig.watchdog.sweep();

    expect(rig.forceCalls).toEqual([]);
  });

  test('is a no-op after dispose', async () => {
    seedWedgedDoc(rig, 'late-doc');
    await rig.watchdog.dispose();

    await rig.watchdog.sweep();

    expect(rig.forceCalls).toEqual([]);
  });

  test('dispose drains an in-flight sweep and stops it before the next doc', async () => {
    let releaseFirstStore: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseFirstStore = resolve;
    });
    const blockingRig = makeRig({
      forceStore: async (_document, documentName) => {
        blockingRig.forceCalls.push(documentName);
        await gate;
      },
    });
    try {
      seedWedgedDoc(blockingRig, 'doc-a');
      seedWedgedDoc(blockingRig, 'doc-b');

      const sweepPromise = blockingRig.watchdog.sweep();
      const disposePromise = blockingRig.watchdog.dispose();
      releaseFirstStore?.();
      await disposePromise;
      await sweepPromise;

      expect(blockingRig.forceCalls).toEqual(['doc-a']);
    } finally {
      releaseFirstStore?.();
      await blockingRig.watchdog.dispose();
    }
  });
});

describe('external-edit stand-down (disk authority)', () => {
  test('does not overwrite disk bytes the base does not account for', async () => {
    seedWedgedDoc(rig, 'external-doc');
    rig.disk.set('external-doc', '# external native edit\n');

    await rig.watchdog.sweep();

    expect(rig.forceCalls).toEqual([]);
    expect(getMetrics().persistenceStalenessDetected).toBe(1);
    expect(getMetrics().persistenceStalenessForcedStores).toBe(0);
    expect(getMetrics().persistenceStalenessStoodDown).toBe(1);
    expect(rig.disk.get('external-doc')).toBe('# external native edit\n');

    await rig.watchdog.sweep();
    expect(getMetrics().persistenceStalenessStoodDown).toBe(1);
  });

  test('does not resurrect a file deleted out-of-band', async () => {
    seedWedgedDoc(rig, 'deleted-doc');
    rig.disk.delete('deleted-doc');

    await rig.watchdog.sweep();

    expect(rig.forceCalls).toEqual([]);
    expect(getMetrics().persistenceStalenessStoodDown).toBe(1);
  });

  test('does not overwrite an on-disk file the doc never loaded', async () => {
    const doc = makeDoc('# memory only\n');
    rig.docs.set('never-loaded', doc);
    rig.disk.set('never-loaded', '# unread disk bytes\n');
    rig.txAges.set('never-loaded', GRACE_MS * 10);

    await rig.watchdog.sweep();

    expect(rig.forceCalls).toEqual([]);
  });

  test('stands down when the disk read fails, then retries after another grace window', async () => {
    seedWedgedDoc(rig, 'unreadable-doc');
    rig.diskReadFault.kind = 'transient';

    await rig.watchdog.sweep();
    expect(rig.forceCalls).toEqual([]);

    await rig.watchdog.sweep();
    expect(rig.forceCalls).toEqual([]);

    rig.diskReadFault.kind = null;
    rig.clock.nowMs += GRACE_MS + 1;
    await rig.watchdog.sweep();
    expect(rig.forceCalls).toEqual(['unreadable-doc']);
  });

  test('a structural read refusal declines until content changes', async () => {
    const doc = seedWedgedDoc(rig, 'refused-doc');
    rig.diskReadFault.kind = 'structural';

    await rig.watchdog.sweep();
    expect(rig.forceCalls).toEqual([]);
    expect(getMetrics().persistenceStalenessStoodDown).toBe(1);

    rig.clock.nowMs += GRACE_MS * 3;
    await rig.watchdog.sweep();
    rig.clock.nowMs += GRACE_MS * 3;
    await rig.watchdog.sweep();
    expect(rig.forceCalls).toEqual([]);
    expect(getMetrics().persistenceStalenessStoodDown).toBe(1);

    rig.diskReadFault.kind = null;
    doc.getText('source').insert(0, 'more ');
    rig.clock.nowMs += GRACE_MS + 1;
    await rig.watchdog.sweep();
    expect(rig.forceCalls).toEqual(['refused-doc']);
  });

  test('a stand-down re-arms when the memory content changes', async () => {
    const doc = seedWedgedDoc(rig, 'rearm-doc');
    rig.disk.set('rearm-doc', '# external native edit\n');

    await rig.watchdog.sweep();
    await rig.watchdog.sweep();
    expect(rig.forceCalls).toEqual([]);
    expect(getMetrics().persistenceStalenessDetected).toBe(1);

    rig.bases.set('rearm-doc', '# external native edit\n');
    doc.getText('source').delete(0, doc.getText('source').length);
    doc.getText('source').insert(0, '# newer memory edit\n');

    await rig.watchdog.sweep();

    expect(rig.forceCalls).toEqual(['rearm-doc']);
    expect(getMetrics().persistenceStalenessDetected).toBe(2);
  });
});

describe('retry and suppression discipline', () => {
  test('a store that completes without clearing divergence suppresses until content changes', async () => {
    rig.forceBehavior.mode = 'no-op';
    const doc = seedWedgedDoc(rig, 'noop-doc');

    await rig.watchdog.sweep();
    expect(rig.forceCalls).toEqual(['noop-doc']);

    rig.clock.nowMs += GRACE_MS * 5;
    await rig.watchdog.sweep();
    expect(rig.forceCalls).toEqual(['noop-doc']);

    doc.getText('source').insert(0, 'more ');
    rig.clock.nowMs += GRACE_MS * 5;
    await rig.watchdog.sweep();
    expect(rig.forceCalls).toEqual(['noop-doc', 'noop-doc']);
  });

  test('a failed store retries only after another full grace window', async () => {
    rig.forceBehavior.mode = 'throw';
    seedWedgedDoc(rig, 'failing-doc');

    await rig.watchdog.sweep();
    expect(rig.forceCalls).toEqual(['failing-doc']);

    await rig.watchdog.sweep();
    expect(rig.forceCalls).toEqual(['failing-doc']);

    rig.clock.nowMs += GRACE_MS + 1;
    rig.forceBehavior.mode = 'advance-base';
    await rig.watchdog.sweep();
    expect(rig.forceCalls).toEqual(['failing-doc', 'failing-doc']);
    await rig.watchdog.sweep();
    expect(rig.forceCalls).toEqual(['failing-doc', 'failing-doc']);
  });

  test('drops bookkeeping for docs that unloaded', async () => {
    rig.forceBehavior.mode = 'no-op';
    seedWedgedDoc(rig, 'transient-doc');

    await rig.watchdog.sweep();
    expect(rig.forceCalls).toEqual(['transient-doc']);

    const doc = rig.docs.get('transient-doc');
    rig.docs.delete('transient-doc');
    await rig.watchdog.sweep();
    if (doc) rig.docs.set('transient-doc', doc);
    rig.clock.nowMs += GRACE_MS * 2;

    await rig.watchdog.sweep();
    expect(rig.forceCalls).toEqual(['transient-doc', 'transient-doc']);
  });
});

describe('in-flight suppression against the real durability state', () => {
  test('a fresh record suppresses the sweep and an expired one stops suppressing it', async () => {
    vi.useFakeTimers();
    const durabilityState = new DocumentDurabilityState();
    const local = makeRig({
      hasInFlight: (documentName) => durabilityState.inFlightFlushCount(documentName) > 0,
    });
    try {
      seedWedgedDoc(local, 'in-flight-doc');
      durabilityState.beginInFlightFlush('in-flight-doc', 'bytes-never-settled');

      await local.watchdog.sweep();
      expect(local.forceCalls).toEqual([]);

      vi.advanceTimersByTime(61_000);

      await local.watchdog.sweep();
      expect(local.forceCalls).toEqual(['in-flight-doc']);
      expect(getMetrics().inFlightFlushExpired).toBe(1);
    } finally {
      await local.watchdog.dispose();
      vi.useRealTimers();
    }
  });
});

describe('a stalled forced store does not wedge the sweep', () => {
  test('a store that never settles times out, is suppressed, and later documents still sweep', async () => {
    const local = makeRig({ forceStoreTimeoutMs: 50 });
    try {
      seedWedgedDoc(local, 'a-stalled-doc');
      seedWedgedDoc(local, 'b-healthy-doc');
      local.hangDocs.add('a-stalled-doc');

      await local.watchdog.sweep();

      expect(local.forceCalls).toEqual(['a-stalled-doc', 'b-healthy-doc']);
      expect(getMetrics().persistenceStalenessForceStoreTimeouts).toBe(1);
      expect(local.bases.get('b-healthy-doc')).toBe('# edited in memory\n');

      local.clock.nowMs += GRACE_MS * 2;
      await local.watchdog.sweep();

      expect(local.forceCalls).toEqual(['a-stalled-doc', 'b-healthy-doc']);
    } finally {
      await local.watchdog.dispose();
    }
  });

  test('a store that times out and then fails is retried once it settles', async () => {
    const local = makeRig({ forceStoreTimeoutMs: 50 });
    try {
      seedWedgedDoc(local, 'late-failing-doc');
      local.hangDocs.add('late-failing-doc');

      await local.watchdog.sweep();
      expect(local.forceCalls).toEqual(['late-failing-doc']);

      local.clock.nowMs += GRACE_MS * 2;
      await local.watchdog.sweep();
      expect(local.forceCalls).toEqual(['late-failing-doc']);

      local.hangDocs.delete('late-failing-doc');
      local.hangSettlers.get('late-failing-doc')?.reject(new Error('injected late EIO'));
      await new Promise((resolve) => setImmediate(resolve));

      local.clock.nowMs += GRACE_MS * 2;
      await local.watchdog.sweep();
      expect(local.forceCalls).toEqual(['late-failing-doc', 'late-failing-doc']);
      expect(getMetrics().persistenceStalenessDetected).toBe(1);
    } finally {
      await local.watchdog.dispose();
    }
  });

  test('a re-armed document still waits a grace window before it is forced again', async () => {
    const local = makeRig({ forceStoreTimeoutMs: 50 });
    try {
      seedWedgedDoc(local, 'backoff-doc');
      local.hangDocs.add('backoff-doc');

      await local.watchdog.sweep();
      expect(local.forceCalls).toEqual(['backoff-doc']);

      local.hangDocs.delete('backoff-doc');
      local.hangSettlers.get('backoff-doc')?.reject(new Error('injected late EIO'));
      await new Promise((resolve) => setImmediate(resolve));

      await local.watchdog.sweep();
      expect(local.forceCalls).toEqual(['backoff-doc']);

      local.clock.nowMs += GRACE_MS * 2;
      await local.watchdog.sweep();
      expect(local.forceCalls).toEqual(['backoff-doc', 'backoff-doc']);
    } finally {
      await local.watchdog.dispose();
    }
  });

  test('a timed-out store that later succeeds without clearing divergence is retried after a grace window', async () => {
    const local = makeRig({ forceStoreTimeoutMs: 50 });
    try {
      local.forceBehavior.mode = 'no-op';
      seedWedgedDoc(local, 'late-landing-doc');
      local.hangDocs.add('late-landing-doc');

      await local.watchdog.sweep();
      expect(local.forceCalls).toEqual(['late-landing-doc']);

      local.hangDocs.delete('late-landing-doc');
      local.hangSettlers.get('late-landing-doc')?.resolve();
      await new Promise((resolve) => setImmediate(resolve));

      await local.watchdog.sweep();
      expect(local.forceCalls).toEqual(['late-landing-doc']);

      local.clock.nowMs += GRACE_MS * 2;
      await local.watchdog.sweep();
      expect(local.forceCalls).toEqual(['late-landing-doc', 'late-landing-doc']);
    } finally {
      await local.watchdog.dispose();
    }
  });

  test('a forceStore that throws synchronously does not abort the sweep and is retried after a grace window', async () => {
    const syncThrowCalls: string[] = [];
    const syncThrowingForceStore = (_document: Y.Doc, documentName: string): Promise<void> => {
      syncThrowCalls.push(documentName);
      throw new Error('injected synchronous store failure');
    };
    const local = makeRig({ forceStore: syncThrowingForceStore });
    try {
      const throwingDoc = seedWedgedDoc(local, 'sync-throw-doc');
      seedWedgedDoc(local, 'later-doc');

      await local.watchdog.sweep();

      expect(syncThrowCalls).toEqual(['sync-throw-doc', 'later-doc']);
      expect(getMetrics().persistenceStalenessForcedStores).toBe(2);
      expect(getMetrics().persistenceStalenessForceStoreTimeouts).toBe(0);

      local.clock.nowMs += GRACE_MS * 2;
      await local.watchdog.sweep();

      expect(syncThrowCalls).toEqual([
        'sync-throw-doc',
        'later-doc',
        'sync-throw-doc',
        'later-doc',
      ]);

      expect(() => syncThrowingForceStore(throwingDoc, 'premise-probe')).toThrow(
        'injected synchronous store failure',
      );
    } finally {
      await local.watchdog.dispose();
    }
  });

  test('a late-settling old store does not clobber a newer attempt carrying the same fingerprint', async () => {
    const local = makeRig({ forceStoreTimeoutMs: 50 });
    try {
      const doc = seedWedgedDoc(local, 'reloaded-doc');
      local.hangDocs.add('reloaded-doc');

      await local.watchdog.sweep();
      const settlerA = local.hangSettlers.get('reloaded-doc');
      expect(local.forceCalls).toEqual(['reloaded-doc']);

      local.docs.delete('reloaded-doc');
      await local.watchdog.sweep();

      local.docs.set('reloaded-doc', doc);
      local.clock.nowMs += GRACE_MS * 2;
      await local.watchdog.sweep();
      expect(local.forceCalls).toEqual(['reloaded-doc', 'reloaded-doc']);

      expect(getMetrics().persistenceStalenessForceStoreTimeouts).toBe(2);

      settlerA?.reject(new Error('injected late EIO'));
      await new Promise((resolve) => setImmediate(resolve));

      local.clock.nowMs += GRACE_MS * 2;
      await local.watchdog.sweep();
      expect(local.forceCalls).toEqual(['reloaded-doc', 'reloaded-doc']);
    } finally {
      await local.watchdog.dispose();
    }
  });
});

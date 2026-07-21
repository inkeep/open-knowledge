import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import * as Y from 'yjs';
import { isPersistenceExcludedDoc } from './cc1-broadcast.ts';
import { FROZEN_LIFECYCLE_STATUSES } from './conflict-errors.ts';
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
  /** Per-doc ms-since-last-user-tx; missing entry → null (never observed). */
  txAges: Map<string, number>;
  forceCalls: string[];
  clock: { nowMs: number };
  batchActive: { value: boolean };
  inFlight: Map<string, string>;
  /** Behavior of the injected forceStore. */
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
  const inFlight = new Map<string, string>();
  const forceBehavior: Rig['forceBehavior'] = { mode: 'advance-base' };
  const diskReadFault: Rig['diskReadFault'] = { kind: null };

  const watchdog = createPersistenceStalenessWatchdog({
    getLoadedDocuments: () => docs,
    forceStore: async (document, documentName) => {
      forceCalls.push(documentName);
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
    // Interval never fires inside a test; sweeps are driven manually.
    sweepIntervalMs: 3_600_000,
    now: () => clock.nowMs,
    getBase: (documentName) => bases.get(documentName),
    isBatchActive: () => batchActive.value,
    peekInFlight: (documentName) => inFlight.get(documentName),
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
    forceBehavior,
    diskReadFault,
  };
}

/** A doc whose memory diverged from base+disk long ago — the wedge shape. */
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
    // Base advanced by the store; the next sweep sees convergence and stays quiet.
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
    // Byte-unequal but normalize-equal (trailing newlines): the shared
    // `normalizedSourceForm` derivation must read this as converged even
    // through the frontmatter strip/prepend round-trip — the same verdict
    // the store's no-op skip would reach.
    const fmBase = '---\ntitle: x\n---\n\n# body\n\n\n';
    const doc = makeDoc('---\ntitle: x\n---\n\n# body\n');
    rig.docs.set('fm-doc', doc);
    rig.bases.set('fm-doc', fmBase);
    rig.disk.set('fm-doc', fmBase);
    rig.txAges.set('fm-doc', GRACE_MS * 10);

    await rig.watchdog.sweep();
    expect(rig.forceCalls).toEqual([]);

    // A frontmatter-only edit IS a divergence and must be rescued.
    doc.getText('source').delete(0, doc.getText('source').length);
    doc.getText('source').insert(0, '---\ntitle: y\n---\n\n# body\n');
    await rig.watchdog.sweep();
    expect(rig.forceCalls).toEqual(['fm-doc']);
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
    // One representative per dedicated-store-path class dispatched in
    // persistence's onLoadDocument/onStoreDocument. A fifth doc class
    // added to that dispatch must be added here (and to the predicate) or
    // the watchdog would force it through the markdown L1 spine.
    for (const name of [
      '__system__',
      '__config__/project',
      '__user__/config.yml',
      '__local__/project',
      '__skill__/project/foo',
      '__template__/notes/weekly',
      'diagram.mmd',
      'assets/flow.mermaid',
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
    // Driven from the registry so a newly added frozen status is covered
    // here automatically.
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
    // A batch starting inside the forceStore await means persistence PARKED
    // the store (deferStore) rather than running it — the doc stays
    // divergent with unchanged content, which must not be classified as a
    // declined no-op (that would suppress retries even if the batch replay
    // later drops the parked entry).
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

      // Batch over, base still stale, content unchanged: the next grace
      // window must retry rather than treat the doc as suppressed.
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
    rig.inFlight.set('inflight-doc', 'anything');

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
    // Two wedged docs; block the first forceStore so dispose lands mid-sweep.
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

      // The in-flight sweep finished its current store but never reached
      // the second doc.
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
    // Detected and counted as a stand-down, but not forced.
    expect(getMetrics().persistenceStalenessDetected).toBe(1);
    expect(getMetrics().persistenceStalenessForcedStores).toBe(0);
    expect(getMetrics().persistenceStalenessStoodDown).toBe(1);
    expect(rig.disk.get('external-doc')).toBe('# external native edit\n');

    // Verified external state suppresses until content changes — a second
    // sweep must not re-count the same stand-down.
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

    // Still failing, still inside the retry pace: no hammering.
    await rig.watchdog.sweep();
    expect(rig.forceCalls).toEqual([]);

    // The read fault clears (transient EMFILE/EACCES class): unlike the
    // verified external-state stand-downs, the doc must NOT stay suppressed.
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

    // A refusal that never clears (symlink-escape / oversized file) must
    // not inflate the alertable counter or retry across grace windows.
    rig.clock.nowMs += GRACE_MS * 3;
    await rig.watchdog.sweep();
    rig.clock.nowMs += GRACE_MS * 3;
    await rig.watchdog.sweep();
    expect(rig.forceCalls).toEqual([]);
    expect(getMetrics().persistenceStalenessStoodDown).toBe(1);

    // Only a content change re-arms the doc.
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

    // External state reconciled (watcher caught up: base = disk), then a new
    // memory edit wedges again.
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

    // Same content, later sweeps — even past another grace window: no retry.
    rig.clock.nowMs += GRACE_MS * 5;
    await rig.watchdog.sweep();
    expect(rig.forceCalls).toEqual(['noop-doc']);

    // Content changed — re-armed.
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

    // Immediately after: no hammering.
    await rig.watchdog.sweep();
    expect(rig.forceCalls).toEqual(['failing-doc']);

    // A grace window later: retried; a recovered disk then clears it.
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

    // Unload, then reload in the same wedged shape: suppression must not
    // survive the unload (a fresh load re-reads disk and re-bases anyway).
    const doc = rig.docs.get('transient-doc');
    rig.docs.delete('transient-doc');
    await rig.watchdog.sweep();
    if (doc) rig.docs.set('transient-doc', doc);
    rig.clock.nowMs += GRACE_MS * 2;

    await rig.watchdog.sweep();
    expect(rig.forceCalls).toEqual(['transient-doc', 'transient-doc']);
  });
});

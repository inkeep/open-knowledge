import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import type { Hocuspocus } from '@hocuspocus/server';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  type BridgeDeriveLossReporter,
  createBridgeDeriveLossReporter,
  DERIVE_LOSS_SITE_AGENT_UNDO,
  DERIVE_LOSS_SITE_AGENT_WRITE_INTAKE,
  DERIVE_LOSS_SITE_FILE_WATCHER_INTAKE,
} from './bridge-loss-detector.ts';
import { DocumentDurabilityState } from './document-durability-state.ts';
import { applyExternalChange } from './external-change.ts';
import {
  type LossCaptureEvent,
  LossCaptureRing,
  lossCaptureCurrentPath,
  parseLossCaptureLines,
} from './loss-capture.ts';
import {
  createWiredPreDrainRig,
  WIRED_PENDING_LINE,
  type WiredPreDrainRig,
} from './pre-drain-wired.test-helper.ts';
import { shadowOpGateFor } from './shadow-op-gate.ts';
import { initShadowRepo, type ShadowHandle, shadowGit } from './shadow-repo.ts';
import { getDocumentHistory } from './timeline-query.ts';

const lossAppendHold = vi.hoisted(() => ({
  path: null as string | null,
  release: null as Promise<void> | null,
  onEntered: null as (() => void) | null,
  onWritten: null as (() => void) | null,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    writeFile: (async (...args: Parameters<typeof actual.writeFile>) => {
      if (String(args[0]) !== lossAppendHold.path) return actual.writeFile(...args);
      const release = lossAppendHold.release;
      if (!release) throw new Error('loss append hold is not configured');
      lossAppendHold.onEntered?.();
      await release;
      await actual.writeFile(...args);
      lossAppendHold.onWritten?.();
    }) as typeof actual.writeFile,
  };
});

interface FloorHarness {
  readonly wired: WiredPreDrainRig;
  readonly shadow: ShadowHandle;
  readonly ring: LossCaptureRing;
  readonly docName: string;
  deferCount(): number;
  stageDeferredKeystroke(): void;
  awaitDetectorTrip(): Promise<LossCaptureEvent | undefined>;
  cleanup(): Promise<void>;
}

interface FloorCleanupSignals {
  afterWiredCleanup?(): void;
  beforeRemove?(): Promise<void> | void;
}

async function createFloorHarness(
  docName: string,
  cleanupSignals: FloorCleanupSignals = {},
): Promise<FloorHarness> {
  const tmpDir = await mkdtemp(resolve(tmpdir(), 'ok-defer-floor-'));
  const projectRoot = resolve(tmpDir, 'project');
  const shadow = await initShadowRepo(projectRoot);
  const ring = new LossCaptureRing({ projectDir: projectRoot, maxBytes: 1_000_000 });
  const reporter: BridgeDeriveLossReporter = createBridgeDeriveLossReporter({
    shadow: () => shadow,
    ring,
    getBranch: () => 'main',
    contentRoot: '',
  });
  let defers = 0;
  const wired = await createWiredPreDrainRig({
    docName,
    reporter,
    setupOverrides: {
      onDeriveTimingDefer: () => {
        defers += 1;
      },
    },
  });

  async function drainCheckpoint(): Promise<void> {
    await nextTurn();
    await shadowOpGateFor(shadow).drain();
    await nextTurn();
    await ring.drain();
  }

  return {
    wired,
    shadow,
    ring,
    docName,
    deferCount: () => defers,
    stageDeferredKeystroke: () => {
      wired.stageUnpropagatedKeystroke();
      const before = defers;
      wired.rig.externalYtextEdit(
        'source-write',
        (yt) => yt.insert(yt.length, '\nAnother source line.\n'),
        { advanceFreshness: false },
      );
      expect(defers).toBeGreaterThan(before);
      expect(wired.serializeFragment()).toContain(WIRED_PENDING_LINE);
      expect(wired.ytextString()).not.toContain(WIRED_PENDING_LINE);
    },
    awaitDetectorTrip: async () => {
      await drainCheckpoint();
      const events = parseLossCaptureLines(
        readFileSync(lossCaptureCurrentPath(projectRoot), 'utf-8'),
      );
      return events.find((e) => e.event === 'detector-trip' && Boolean(e.checkpointSha));
    },
    cleanup: async () => {
      await wired.cleanup();
      cleanupSignals.afterWiredCleanup?.();
      await drainCheckpoint();
      await cleanupSignals.beforeRemove?.();
      await rm(tmpDir, { recursive: true, force: true });
    },
  };
}

async function expectRestorableFloorCheckpoint(
  h: FloorHarness,
  expectedSite: string,
): Promise<void> {
  const trip = await h.awaitDetectorTrip();
  expect(trip).toBeDefined();
  expect(trip?.site).toBe(expectedSite);
  expect(typeof trip?.lostLen).toBe('number');
  expect(JSON.stringify(trip)).not.toContain(WIRED_PENDING_LINE);

  const blob = (
    await shadowGit(h.shadow).raw('show', `${trip?.checkpointSha}:${h.docName}`)
  ).toString();
  expect(blob).toContain(WIRED_PENDING_LINE);

  const hist = await getDocumentHistory(h.shadow, { docName: h.docName }, '');
  const row = hist.entries.find((e) => e.sha === trip?.checkpointSha);
  expect(row?.checkpoint?.kind).toBe('bridge-derive-loss');
}

describe('checkpoint floor after a derive-timing defer', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_000_000);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test('agent append: the deferred keystroke lands on the floor, restorable', async () => {
    const h = await createFloorHarness('floor-agent-append');
    try {
      h.stageDeferredKeystroke();

      h.wired.agentWriteWithPreDrain('An appended agent paragraph.', 'append');

      expect(h.wired.ytextString()).not.toContain(WIRED_PENDING_LINE);
      expect(h.wired.serializeFragment()).not.toContain(WIRED_PENDING_LINE);
      await expectRestorableFloorCheckpoint(h, DERIVE_LOSS_SITE_AGENT_WRITE_INTAKE);
    } finally {
      await h.cleanup();
    }
  });

  test('agent replace: the deferred keystroke lands on the floor, restorable', async () => {
    const h = await createFloorHarness('floor-agent-replace');
    try {
      h.stageDeferredKeystroke();

      h.wired.agentWriteWithPreDrain('## Replaced\n\nBrand new body.\n', 'replace');

      expect(h.wired.ytextString()).not.toContain(WIRED_PENDING_LINE);
      expect(h.wired.serializeFragment()).not.toContain(WIRED_PENDING_LINE);
      await expectRestorableFloorCheckpoint(h, DERIVE_LOSS_SITE_AGENT_WRITE_INTAKE);
    } finally {
      await h.cleanup();
    }
  });

  test('agent undo of a single frame: the deferred keystroke lands on the floor, restorable', async () => {
    const h = await createFloorHarness('floor-agent-undo');
    try {
      h.wired.agentWrite('Agent appended line.', 'append');
      expect(h.wired.ytextString()).toContain('Agent appended line.');

      h.stageDeferredKeystroke();

      expect(h.wired.agentUndo('last')).toBe(true);

      expect(h.wired.ytextString()).not.toContain('Agent appended line.');
      expect(h.wired.ytextString()).not.toContain(WIRED_PENDING_LINE);
      expect(h.wired.serializeFragment()).not.toContain(WIRED_PENDING_LINE);
      await expectRestorableFloorCheckpoint(h, DERIVE_LOSS_SITE_AGENT_UNDO);
    } finally {
      await h.cleanup();
    }
  });

  test('agent undo checkpoint finishes before its shadow fixture is removed', async () => {
    const wiredCleaned = Promise.withResolvers<void>();
    const releaseWriter = Promise.withResolvers<void>();
    let writerFinished = false;
    let removedBeforeWriterFinished = false;
    let gate: ReturnType<typeof shadowOpGateFor>;
    const h = await createFloorHarness('floor-agent-undo-cleanup', {
      afterWiredCleanup: wiredCleaned.resolve,
      beforeRemove: async () => {
        removedBeforeWriterFinished = !writerFinished;
        await releaseWriter.promise;
        await gate.drain();
      },
    });
    gate = shadowOpGateFor(h.shadow);
    const writerEntered = Promise.withResolvers<void>();
    const realWithMutator = gate.withMutator.bind(gate);
    const mutatorSpy = vi.spyOn(gate, 'withMutator').mockImplementation((fn) =>
      realWithMutator(async () => {
        writerEntered.resolve();
        await releaseWriter.promise;
        const result = await fn();
        writerFinished = true;
        return result;
      }),
    );
    let cleanup: Promise<void> | undefined;
    try {
      h.wired.agentWrite('Agent appended line.', 'append');
      h.stageDeferredKeystroke();
      expect(h.wired.agentUndo('last')).toBe(true);
      await writerEntered.promise;

      cleanup = h.cleanup();
      await wiredCleaned.promise;
      releaseWriter.resolve();
      await cleanup;

      expect(writerFinished).toBe(true);
      expect(removedBeforeWriterFinished).toBe(false);
    } finally {
      releaseWriter.resolve();
      try {
        await gate.drain();
        if (cleanup) await cleanup;
        else await h.cleanup();
      } finally {
        mutatorSpy.mockRestore();
      }
    }
  });

  test('agent undo loss event finishes appending before its shadow fixture is removed', async () => {
    const wiredCleaned = Promise.withResolvers<void>();
    const appendEntered = Promise.withResolvers<void>();
    const releaseAppend = Promise.withResolvers<void>();
    const appendWritten = Promise.withResolvers<void>();
    let appendFinished = false;
    let removedBeforeLossWriteFinished = false;
    let eventBeforeRemove: LossCaptureEvent | undefined;
    let h: FloorHarness;
    h = await createFloorHarness('floor-agent-undo-loss-append', {
      afterWiredCleanup: wiredCleaned.resolve,
      beforeRemove: async () => {
        removedBeforeLossWriteFinished = !appendFinished;
        await releaseAppend.promise;
        await h.ring.drain();
        const events = parseLossCaptureLines(
          readFileSync(lossCaptureCurrentPath(h.shadow.workTree), 'utf-8'),
        );
        eventBeforeRemove = events.find(
          (event) => event.event === 'detector-trip' && event.docName === h.docName,
        );
      },
    });
    const gate = shadowOpGateFor(h.shadow);
    lossAppendHold.path = lossCaptureCurrentPath(h.shadow.workTree);
    lossAppendHold.release = releaseAppend.promise;
    lossAppendHold.onEntered = appendEntered.resolve;
    lossAppendHold.onWritten = () => {
      appendFinished = true;
      appendWritten.resolve();
    };
    let cleanup: Promise<void> | undefined;
    try {
      h.wired.agentWrite('Agent appended line.', 'append');
      h.stageDeferredKeystroke();
      expect(h.wired.agentUndo('last')).toBe(true);
      cleanup = h.cleanup();

      await wiredCleaned.promise;
      await appendEntered.promise;
      releaseAppend.resolve();
      await appendWritten.promise;
      await cleanup;

      expect(eventBeforeRemove?.checkpointSha).toBeDefined();
      expect(eventBeforeRemove?.site).toBe(DERIVE_LOSS_SITE_AGENT_UNDO);
      expect(removedBeforeLossWriteFinished).toBe(false);
    } finally {
      releaseAppend.resolve();
      try {
        await gate.drain();
        await h.ring.drain();
        if (cleanup) await cleanup;
        else await h.cleanup();
      } finally {
        lossAppendHold.path = null;
        lossAppendHold.release = null;
        lossAppendHold.onEntered = null;
        lossAppendHold.onWritten = null;
      }
    }
  });

  test('file-watcher change: the deferred keystroke lands on the floor, restorable', async () => {
    const h = await createFloorHarness('floor-file-watcher');
    try {
      h.stageDeferredKeystroke();

      const hocuspocus = {
        documents: new Map([[h.docName, h.wired.doc]]),
      } as unknown as Hocuspocus;
      applyExternalChange(
        new DocumentDurabilityState(),
        hocuspocus,
        h.docName,
        '## Guide\n\nRewritten from disk.\n',
        undefined,
        undefined,
        createBridgeDeriveLossReporter({
          shadow: () => h.shadow,
          ring: h.ring,
          getBranch: () => 'main',
          contentRoot: '',
        }),
      );

      expect(h.wired.ytextString()).not.toContain(WIRED_PENDING_LINE);
      expect(h.wired.serializeFragment()).not.toContain(WIRED_PENDING_LINE);
      await expectRestorableFloorCheckpoint(h, DERIVE_LOSS_SITE_FILE_WATCHER_INTAKE);
    } finally {
      await h.cleanup();
    }
  });
});

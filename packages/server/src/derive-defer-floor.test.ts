import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
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
import { initShadowRepo, type ShadowHandle, shadowGit } from './shadow-repo.ts';
import { getDocumentHistory } from './timeline-query.ts';

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

async function createFloorHarness(docName: string): Promise<FloorHarness> {
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
      let trip: LossCaptureEvent | undefined;
      for (let i = 0; i < 100 && !trip; i++) {
        await ring.drain();
        try {
          const events = parseLossCaptureLines(
            readFileSync(lossCaptureCurrentPath(projectRoot), 'utf-8'),
          );
          trip = events.find((e) => e.event === 'detector-trip' && Boolean(e.checkpointSha));
        } catch {}
        if (!trip) await new Promise((r) => setTimeout(r, 10));
      }
      return trip;
    },
    cleanup: async () => {
      await wired.cleanup();
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

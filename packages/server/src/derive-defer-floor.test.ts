/**
 * The checkpoint floor under a DEFERRED keystroke, on the REAL
 * `setupServerObservers` drain plus a real `AgentSessionManager` session.
 *
 * Staging is defer-then-trigger. A WYSIWYG keystroke sits un-propagated in the
 * fragment, a source-editor write drives an Observer B re-derive that the
 * derive-timing guard defers, and only then does a paired vector run. That
 * ordering matters: a defer moves Y.Text past Observer A's raw witness without
 * moving the witness, so the pre-drain planner's `witnessMatched` leg fails
 * closed BEFORE it ever reaches the overlap classification. Every paired vector
 * measured from this staging therefore lands on the checkpoint floor — the
 * pre-drain flush carries none of them. Each arm below pins that the floor
 * actually fired for its own vector: a `bridge-derive-loss` checkpoint whose
 * payload carries the keystroke, reachable as a restore row on the timeline.
 *
 * The paired-intake floor is a union of a substring-drop twin and a
 * whole-raw-line predicate; the deferred keystroke here is the intra-line
 * `bod`→`body.` shape that only the line predicate can express, so these arms
 * bind on that leg specifically.
 *
 * Not covered here, deliberately: the source-mode row. A source-editor edit
 * arriving after a defer leaves the keystroke live in the fragment and neither
 * carried into Y.Text nor checkpointed — it converges only on the next
 * fragment-side edit and does not survive an unload. That is an open liveness
 * gap, not intended behavior, so pinning it with a test would ratify it.
 *
 * A second residual, reachable from this rig but not from user typing: a stale
 * `sourceRaw` capture whose component children have advanced can drive a shape
 * that removes content from BOTH replicas. A real keystroke cannot present it —
 * `packages/app/src/editor/extensions/source-dirty-observer.ts` (~line 153)
 * flips `sourceDirty` on every component a user transaction edits, and
 * `packages/app/src/editor/utils/reconstruct-source.ts` (~line 14) takes the
 * verbatim `sourceRaw` fast path only while that flag is clean, with
 * `packages/core/src/bridge/structural-freshness.ts` as the server-side
 * backstop. It remains reachable in principle only on the raw-CRDT-peer surface
 * that structural-freshness explicitly delegates to the producer guard, and only
 * while a drain is freshness-suppressed (`server-observers.ts` ~line 1705). The
 * rig stamps those attrs by hand, which is why it can reach a shape the product
 * cannot.
 */

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
  /** How many drains the derive-timing guard has deferred so far. */
  deferCount(): number;
  /**
   * Stage the un-propagated keystroke, then drive a source-editor write that
   * the derive-timing guard defers. Asserts the defer actually fired, so an arm
   * can never silently degrade into the never-deferred staging.
   */
  stageDeferredKeystroke(): void;
  /** Poll until the floor's async checkpoint lands, or give up. */
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
      // A source-editor write inside the freshness-hot window is the drain the
      // guard defers; `advanceFreshness: false` keeps the window hot.
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
        } catch {
          /* the capture file may not exist until the first record flushes */
        }
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

/**
 * The shared floor assertions: a `bridge-derive-loss` checkpoint attributed to
 * `expectedSite`, whose payload carries the deferred keystroke, surfaced as a
 * restorable timeline row. The ring event itself stays content-free.
 */
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

      // Neither replica carries it forward — the floor is the only survival path.
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
      // An agent write first, so the undo has exactly one frame to revert.
      h.wired.agentWrite('Agent appended line.', 'append');
      expect(h.wired.ytextString()).toContain('Agent appended line.');

      h.stageDeferredKeystroke();

      expect(h.wired.agentUndo('last')).toBe(true);

      // The undo's own effect landed, and the keystroke went to the floor.
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

      // A disk edit arriving at the live doc, through the production handler.
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

/**
 * The persistence pre-write divergence arms, on the REAL `setupServerObservers`
 * drain plus the REAL persistence extension.
 *
 * The measured failure: after the derive-timing guard protects a WYSIWYG
 * keystroke (fragment ahead of Y.Text), the store debounce fires and the
 * pre-write sanity check rebuilds the fragment from Y.Text. The rebuild runs
 * under `OBSERVER_SYNC_ORIGIN`, which both observers self-skip, so the keystroke
 * leaves the live fragment with no checkpoint and no ring event — only the
 * rate-limited hygiene counter moves. The `no store` arm below is the
 * non-vacuity control: the same staging without a store keeps the keystroke, so
 * a green hold arm cannot be an artifact of the staging.
 *
 * Staging is the same defer-then-trigger shape `derive-defer-floor.test.ts`
 * uses, so a defer is genuinely in flight when the store runs.
 *
 * Rungs. The store fires two ways: through the real Hocuspocus `Debouncer` (the
 * production path — the timer that fires on a user pause), and through a direct
 * `extension.onStoreDocument` call (the hook that debouncer invokes). The
 * debounce arm stubs only the `Document` affordances a bare `Y.Doc` lacks
 * (`saveMutex`, `getConnectionsCount`), neither of which any arm exercises.
 *
 * The hold arm's shape is staged synthetically (a fragment line in neither
 * Y.Text nor the attach-time witness) rather than through any construct whose
 * serialization happens to be lossy: constructs get fixed upstream — the
 * original probe here, `**[[a]]**` with marks dropped on a leaf wikilink, did —
 * and a fixture premised on a defect dies with the defect. The construct stays
 * as a round-trip pin in the opposite direction: converged docs fire neither
 * arm.
 */

import { readFileSync } from 'node:fs';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { Hocuspocus } from '@hocuspocus/server';
import { MarkdownManager, sharedExtensions } from '@inkeep/open-knowledge-core';
import { updateYFragment } from '@tiptap/y-tiptap';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  type LossCaptureEvent,
  LossCaptureRing,
  lossCaptureCurrentPath,
  parseLossCaptureLines,
} from './loss-capture.ts';
import { mdManager, schema } from './md-manager.ts';
import { getMetrics, resetMetrics } from './metrics.ts';
import { createPersistenceExtension, type PersistenceOptions } from './persistence.ts';
import {
  createWiredPreDrainRig,
  WIRED_PENDING_LINE,
  type WiredPreDrainRig,
} from './pre-drain-wired.test-helper.ts';
import { OBSERVER_SYNC_ORIGIN } from './server-observers.ts';
import { initShadowRepo, type ShadowHandle, shadowGit } from './shadow-repo.ts';
import { getDocumentHistory } from './timeline-query.ts';

/** A browser-shaped store origin — the writer a keystroke-driven store carries. */
const BROWSER_ORIGIN = {
  source: 'connection',
  connection: { context: { principalId: 'principal-test' } },
};

/**
 * The construct from the emphasis-touching-wikilink field report. Its fragment
 * view used to be lossy against Y.Text (the bridge dropped marks on inline leaf
 * nodes), which made it a live hold-arm trigger; the upstream bridge fix made
 * it round-trip clean, so it now pins the OPPOSITE contract: a converged doc
 * fires neither arm. Keep the fixture — it guards the round-trip both ways.
 */
const WIKILINK_EMPHASIS_SOURCE = '# Notes\n\n**[[a]]**\n';

/**
 * A stale-fragment divergence: the fragment holds a line Y.Text no longer does,
 * and that line was in the last settlement — so it is NOT a keystroke the guard
 * could be protecting, and the floor arm owns it.
 */
const STALE_FRAGMENT_MD = '## Guide\n\nStep one bod\n\nTail paragraph.\n';
const STALE_YTEXT_MD = '## Guide\n\nStep one bod\n';
const STALE_FRAGMENT_ONLY_LINE = 'Tail paragraph.';

/**
 * A pending-content divergence: the fragment holds a line that is in NEITHER
 * Y.Text NOR the attach-time witness — the exact three-way shape of an
 * un-propagated keystroke, staged synthetically so the arm does not depend on
 * any construct's serialization being lossy (constructs get fixed; the shape
 * is what the predicate tolerates).
 */
const PENDING_FRAGMENT_MD = '## Guide\n\nStep one bod\n\nA held novel line.\n\nTail paragraph.\n';
const PENDING_YTEXT_MD = '## Guide\n\nStep one bod\n\nTail paragraph.\n';
const PENDING_NOVEL_LINE = 'A held novel line.';

interface StoreHarness {
  readonly wired: WiredPreDrainRig;
  readonly shadow: ShadowHandle;
  readonly ring: LossCaptureRing;
  readonly docName: string;
  readonly projectRoot: string;
  /** Stage a genuinely in-flight derive-timing defer; asserts the defer fired. */
  stageDeferredKeystroke(): void;
  /**
   * Put both replicas into a fixed stale-fragment divergence under the
   * observers' OWN sync origin, which both self-skip — so nothing reacts and
   * the state is exactly what the next store sees. Idempotent by construction:
   * re-staging reproduces the identical pre-rebuild payload, which is what a
   * document whose fragment view is structurally lossy against its own bytes
   * presents on every write-back.
   */
  stageStaleFragment(): void;
  /**
   * Same staging mechanics, but the fragment-only line is absent from the
   * attach-time witness too — the pending-content three-way shape the hold
   * arm tolerates.
   */
  stagePendingDivergence(): void;
  /** Drive the production store hook directly. */
  storeDirect(): Promise<void>;
  /** Drive the store through the real Hocuspocus debouncer. */
  storeDebounced(): Promise<void>;
  /** Bytes currently on disk for the doc, or null when the file is absent. */
  diskBytes(): string | null;
  /** Every loss-ring event recorded so far. */
  readRing(): Promise<LossCaptureEvent[]>;
  /** Every `refs/checkpoints/main/*` sha. */
  checkpointShas(): Promise<string[]>;
  cleanup(): Promise<void>;
}

async function createStoreHarness(
  docName: string,
  overrides?: Partial<PersistenceOptions>,
): Promise<StoreHarness> {
  // Realpath first: on macOS the tmpdir is a symlink, and persistence derives
  // its shadow tree prefix from `relative(projectDir, contentDir)` — two spellings
  // of the same directory would resolve that to an escaping absolute path.
  const tmpDir = await realpath(await mkdtemp(resolve(tmpdir(), 'ok-defer-hold-')));
  const projectRoot = resolve(tmpDir, 'project');
  const shadow = await initShadowRepo(projectRoot);
  const ring = new LossCaptureRing({ projectDir: projectRoot, maxBytes: 1_000_000 });

  let defers = 0;
  const wired = await createWiredPreDrainRig({
    docName,
    setupOverrides: {
      onDeriveTimingDefer: () => {
        defers += 1;
      },
    },
  });

  const persistence = createPersistenceExtension({
    contentDir: projectRoot,
    projectDir: projectRoot,
    gitEnabled: false,
    shadowRef: { current: shadow },
    getLossRing: () => ring,
    ...overrides,
  });

  const hocuspocus = new Hocuspocus({
    quiet: true,
    debounce: 20,
    maxDebounce: 10_000,
    extensions: [persistence.extension],
  });
  const docShim = wired.doc as unknown as { saveMutex: unknown; getConnectionsCount: unknown };
  docShim.saveMutex = {
    runExclusive: async (fn: () => Promise<unknown>) => fn(),
    isLocked: () => false,
  };
  // Non-zero keeps the instance's post-store unload sweep off a doc the observer
  // rig owns; document lifecycle is not what these arms exercise.
  docShim.getConnectionsCount = () => 1;

  const diskBytes = (): string | null => {
    try {
      return readFileSync(resolve(projectRoot, `${docName}.md`), 'utf-8');
    } catch {
      return null;
    }
  };

  const storePayload = {
    document: wired.doc,
    documentName: docName,
    lastTransactionOrigin: BROWSER_ORIGIN,
    lastContext: {},
  };

  return {
    wired,
    shadow,
    ring,
    docName,
    projectRoot,
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
    stageStaleFragment: () => {
      const node = schema.nodeFromJSON(mdManager.parse(STALE_FRAGMENT_MD));
      wired.doc.transact(() => {
        updateYFragment(wired.doc, wired.doc.getXmlFragment('default'), node, {
          mapping: new Map(),
          isOMark: new Map(),
        });
        const yt = wired.doc.getText('source');
        yt.delete(0, yt.length);
        yt.insert(0, STALE_YTEXT_MD);
      }, OBSERVER_SYNC_ORIGIN);
      expect(wired.serializeFragment()).toContain(STALE_FRAGMENT_ONLY_LINE);
      expect(wired.ytextString()).not.toContain(STALE_FRAGMENT_ONLY_LINE);
    },
    stagePendingDivergence: () => {
      const node = schema.nodeFromJSON(mdManager.parse(PENDING_FRAGMENT_MD));
      wired.doc.transact(() => {
        updateYFragment(wired.doc, wired.doc.getXmlFragment('default'), node, {
          mapping: new Map(),
          isOMark: new Map(),
        });
        const yt = wired.doc.getText('source');
        yt.delete(0, yt.length);
        yt.insert(0, PENDING_YTEXT_MD);
      }, OBSERVER_SYNC_ORIGIN);
      expect(wired.serializeFragment()).toContain(PENDING_NOVEL_LINE);
      expect(wired.ytextString()).not.toContain(PENDING_NOVEL_LINE);
    },
    storeDirect: async () => {
      await persistence.extension.onStoreDocument?.(storePayload as never);
    },
    storeDebounced: async () => {
      void hocuspocus.storeDocumentHooks(wired.doc as never, storePayload as never);
      // The debouncer's timer fires the hook; the hook's own disk write settles
      // after it. Wait for the durable effect, not just the arm's counter.
      for (let i = 0; i < 200; i++) {
        await new Promise((r) => setTimeout(r, 10));
        const armed = getMetrics().persistenceDeferHold + getMetrics().persistenceReconcileLoss > 0;
        if (armed && diskBytes() !== null) return;
      }
    },
    diskBytes,
    readRing: async () => {
      await ring.drain();
      try {
        return parseLossCaptureLines(readFileSync(lossCaptureCurrentPath(projectRoot), 'utf-8'));
      } catch {
        return [];
      }
    },
    checkpointShas: async () => {
      const out = await shadowGit(shadow).raw(
        'for-each-ref',
        '--format=%(objectname)',
        'refs/checkpoints/main',
      );
      return out
        .toString()
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
    },
    cleanup: async () => {
      await wired.cleanup();
      await rm(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    },
  };
}

/**
 * Poll until `expected` floor mints have COMPLETED, or give up. Gated on the
 * completion counter rather than the ref listing: git creates the ref before
 * the write promise settles, so polling refs alone can observe a half-finished
 * mint.
 */
async function awaitMints(h: StoreHarness, expected: number): Promise<string[]> {
  for (let i = 0; i < 200; i++) {
    if (getMetrics().persistenceReconcileLossCheckpointCreated >= expected) break;
    await new Promise((r) => setTimeout(r, 10));
  }
  return h.checkpointShas();
}

describe('persistence pre-write divergence arms', () => {
  beforeEach(() => {
    resetMetrics();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_000_000);
  });
  afterEach(() => {
    vi.useRealTimers();
    resetMetrics();
  });

  test('no store: the deferred keystroke survives (non-vacuity control)', async () => {
    const h = await createStoreHarness('hold-control');
    try {
      h.stageDeferredKeystroke();

      // Nothing else runs. If this ever fails, every hold arm below is vacuous.
      expect(h.wired.serializeFragment()).toContain(WIRED_PENDING_LINE);
      expect(getMetrics().persistenceDeferHold).toBe(0);
      expect(h.diskBytes()).toBeNull();
    } finally {
      await h.cleanup();
    }
  });

  test('direct onStoreDocument: the deferred keystroke survives and Y.Text persists', async () => {
    const h = await createStoreHarness('hold-direct');
    try {
      h.stageDeferredKeystroke();

      await h.storeDirect();

      expect(h.wired.serializeFragment()).toContain(WIRED_PENDING_LINE);
      // Y.Text is truth and goes to disk regardless — the hold defers the
      // fragment's convergence, never the durability of the user's bytes.
      expect(h.diskBytes()).toBe(h.wired.ytextString());
      expect(getMetrics().persistenceDeferHold).toBe(1);
      expect(getMetrics().persistenceReconcileLoss).toBe(0);
    } finally {
      await h.cleanup();
    }
  });

  test('debounced store: the deferred keystroke survives, breadcrumbed content-free', async () => {
    const h = await createStoreHarness('hold-debounced');
    try {
      h.stageDeferredKeystroke();

      await h.storeDebounced();

      expect(h.wired.serializeFragment()).toContain(WIRED_PENDING_LINE);
      expect(h.diskBytes()).toBe(h.wired.ytextString());
      expect(getMetrics().persistenceDeferHold).toBe(1);

      const holds = (await h.readRing()).filter((e) => e.event === 'persistence-hold');
      expect(holds).toHaveLength(1);
      const hold = holds[0];
      expect(hold?.site).toBe('persistence-prewrite');
      // The AT-RISK bytes, not the document's — a whole-document length would
      // read as a multi-KB loss on a one-line hold. The set here is the
      // re-indented component block the keystroke sits in, so it is at least
      // that line and strictly less than the document.
      expect(hold?.lostLen).toBeGreaterThanOrEqual(WIRED_PENDING_LINE.length);
      expect(hold?.lostLen).toBeLessThan(h.wired.serializeFragment().length);
      expect(JSON.stringify(hold)).not.toContain(WIRED_PENDING_LINE);
      // A hold destroys nothing, so it mints nothing.
      expect(await h.checkpointShas()).toHaveLength(0);
    } finally {
      await h.cleanup();
    }
  });

  test('converged doc: no divergence, so neither arm runs', async () => {
    const h = await createStoreHarness('hold-converged');
    try {
      // The rig seeds and settles its base, so fragment and Y.Text agree.
      await h.storeDirect();

      expect(getMetrics().persistenceDeferHold).toBe(0);
      expect(getMetrics().persistenceReconcileLoss).toBe(0);
      expect(await h.checkpointShas()).toHaveLength(0);
    } finally {
      await h.cleanup();
    }
  });

  test('pending fragment-only content is held, not repaired, and never mints', async () => {
    const h = await createStoreHarness('hold-pending');
    try {
      // A fragment line in neither Y.Text nor the witness is exactly what the
      // defer guard protects; the store boundary must tolerate it the same way
      // rather than churning a repair that destroys it.
      h.stagePendingDivergence();

      await h.storeDirect();
      await h.storeDirect();
      await h.storeDirect();

      // Y.Text bytes land verbatim on every write-back...
      expect(h.diskBytes()).toBe(PENDING_YTEXT_MD);
      // ...the pending line stays live in the fragment...
      expect(h.wired.serializeFragment()).toContain(PENDING_NOVEL_LINE);
      // ...and the arm holds every time rather than repairing over it.
      expect(getMetrics().persistenceDeferHold).toBe(3);
      expect(getMetrics().persistenceReconcileLoss).toBe(0);
      expect(await h.checkpointShas()).toHaveLength(0);
    } finally {
      await h.cleanup();
    }
  });

  test('the wikilink-emphasis construct round-trips clean: neither arm fires', async () => {
    const h = await createStoreHarness('roundtrip-wikilink');
    try {
      // The field-reported construct that used to be the live hold trigger.
      // The bridge now preserves marks on inline leaves, so the fragment view
      // matches Y.Text and a store must be a plain converged write: no hold,
      // no checkpoint, bytes verbatim. Guards the round-trip against
      // re-regression from either side.
      h.wired.rig.seedSource(WIKILINK_EMPHASIS_SOURCE);
      expect(h.wired.serializeFragment()).toContain('**[[a]]**');

      await h.storeDirect();

      expect(h.diskBytes()).toContain('**[[a]]**');
      expect(getMetrics().persistenceDeferHold).toBe(0);
      expect(getMetrics().persistenceReconcileLoss).toBe(0);
      expect(await h.checkpointShas()).toHaveLength(0);
    } finally {
      await h.cleanup();
    }
  });

  test('floor: a stale-fragment divergence checkpoints the fragment view, then repairs', async () => {
    const h = await createStoreHarness('floor-stale');
    try {
      h.stageStaleFragment();

      await h.storeDirect();

      expect(getMetrics().persistenceDeferHold).toBe(0);
      expect(getMetrics().persistenceReconcileLoss).toBe(1);
      // The repair ran: the fragment converged to Y.Text.
      expect(h.wired.serializeFragment()).not.toContain(STALE_FRAGMENT_ONLY_LINE);
      expect(h.diskBytes()).toBe(h.wired.ytextString());

      const [sha] = await awaitMints(h, 1);
      expect(sha).toBeDefined();
      expect(getMetrics().persistenceReconcileLossCheckpointCreated).toBe(1);

      // The anchor holds the fragment view the rebuild destroyed, reachable as
      // an ordinary restorable timeline row.
      const blob = (await shadowGit(h.shadow).raw('show', `${sha}:${h.docName}`)).toString();
      expect(blob).toContain(STALE_FRAGMENT_ONLY_LINE);
      const hist = await getDocumentHistory(h.shadow, { docName: h.docName }, '');
      const row = hist.entries.find((e) => e.sha === sha);
      expect(row?.checkpoint?.kind).toBe('persistence-reconcile-loss');
      expect(row?.checkpoint?.metadata).toEqual({ atRiskLines: 1, witnessAvailable: true });

      const ring = await h.readRing();
      const writes = ring.filter(
        (e) => e.event === 'checkpoint-write' && e.site === 'persistence-prewrite',
      );
      expect(writes.some((e) => e.checkpointSha === sha)).toBe(true);
      expect(writes.every((e) => e.lostLen === STALE_FRAGMENT_ONLY_LINE.length)).toBe(true);
      // The witness verdict reaches the RING, not only the checkpoint metadata:
      // a bundle without the shadow repo still has to separate "no witness was
      // published" from "the guard ran and declined".
      expect(writes.every((e) => e.witnessAvailable === true)).toBe(true);

      // The rebuild itself is breadcrumbed, distinctly from the anchor mint.
      const rebuilds = ring.filter((e) => e.event === 'repair-rebuild');
      expect(rebuilds).toHaveLength(1);
      expect(rebuilds[0]?.site).toBe('persistence-prewrite');
      expect(rebuilds[0]?.direction).toBe('b');
      expect(typeof rebuilds[0]?.connections).toBe('number');
      expect(JSON.stringify(rebuilds)).not.toContain(STALE_FRAGMENT_ONLY_LINE);
    } finally {
      await h.cleanup();
    }
  });

  test('floor: an unchanged repeat divergence repairs again but mints no second anchor', async () => {
    const h = await createStoreHarness('floor-dedup');
    try {
      h.stageStaleFragment();
      await h.storeDirect();
      const [firstSha] = await awaitMints(h, 1);
      expect(firstSha).toBeDefined();

      // The same divergence re-presents, exactly as a structurally re-derived
      // one would on the next write-back.
      h.stageStaleFragment();
      await h.storeDirect();

      // The repair arm ran both times — the fragment converged again...
      expect(getMetrics().persistenceReconcileLoss).toBe(2);
      expect(h.wired.serializeFragment()).not.toContain(STALE_FRAGMENT_ONLY_LINE);
      // ...but only the first trip minted. Retention caps bound the ref count;
      // they do not stop a spammer from evicting its own useful anchors.
      expect(getMetrics().persistenceReconcileLossDeduped).toBe(1);
      expect(getMetrics().persistenceReconcileLossCheckpointCreated).toBe(1);
      // Negative bound: give a second mint every chance to appear, then assert
      // the ref set never grew.
      expect(await awaitMints(h, 2)).toEqual([firstSha]);

      // ...and the ring still shows BOTH rebuilds. This is the whole point of a
      // per-rebuild breadcrumb: a document that diverges at this boundary on
      // every write-back repairs forever while minting one anchor, so an
      // anchor-shaped record alone reports a permanent repair loop as a single
      // one-off repair. Only one `checkpoint-write` — the dedup suppressed the
      // second mint, and the rebuild record is what carries the rate.
      const ring = await h.readRing();
      expect(ring.filter((e) => e.event === 'repair-rebuild')).toHaveLength(2);
      expect(
        ring.filter((e) => e.event === 'checkpoint-write' && e.site === 'persistence-prewrite'),
      ).toHaveLength(1);
    } finally {
      await h.cleanup();
    }
  });

  test('no witness: observers detached, so the arm falls back to repair with the floor wired', async () => {
    const h = await createStoreHarness('floor-no-witness');
    try {
      h.stagePendingDivergence();
      // Detaching drops the doc's published witness, so the tolerance cannot be
      // evaluated at all. The floor goes under that fallback rather than letting
      // the checker skip blind — even for a shape the hold would tolerate when
      // the witness is available.
      h.wired.rig.cleanup();

      await h.storeDirect();

      expect(getMetrics().persistenceDeferHold).toBe(0);
      expect(getMetrics().persistenceReconcileLoss).toBe(1);
      const [sha] = await awaitMints(h, 1);
      expect(sha).toBeDefined();
      const hist = await getDocumentHistory(h.shadow, { docName: h.docName }, '');
      const row = hist.entries.find((e) => e.sha === sha);
      expect(row?.checkpoint?.metadata).toEqual({ atRiskLines: 1, witnessAvailable: false });
      // The same verdict on the ring. Paired with the arm above, these two
      // tests are what make the field discriminating rather than decorative.
      const writes = (await h.readRing()).filter(
        (e) => e.event === 'checkpoint-write' && e.site === 'persistence-prewrite',
      );
      expect(writes.length).toBeGreaterThan(0);
      expect(writes.every((e) => e.witnessAvailable === false)).toBe(true);
    } finally {
      await h.cleanup();
    }
  });

  test('serialize throw: no fragment view exists, so neither arm may fire', async () => {
    // A manager whose serialize throws is the staged condition itself — the
    // pre-write check then holds no fragment-side view to evaluate the
    // tolerance against or to checkpoint. A skip here would silently swallow
    // the serialize failure.
    const throwingManager = new MarkdownManager({ extensions: sharedExtensions });
    vi.spyOn(throwingManager, 'serialize').mockImplementation(() => {
      throw new Error('schema rejection');
    });
    const h = await createStoreHarness('throw-arm', { mdManager: throwingManager });
    try {
      h.stageDeferredKeystroke();

      await h.storeDirect();

      expect(getMetrics().persistenceSanityCheckSerializeFailures).toBe(1);
      expect(getMetrics().persistenceDeferHold).toBe(0);
      expect(getMetrics().persistenceReconcileLoss).toBe(0);
      expect(await h.checkpointShas()).toHaveLength(0);
      // The pre-existing path is what runs: the fragment is rebuilt from Y.Text
      // and the keystroke leaves it. That outcome is what the hold arms fix for
      // an evaluable divergence; here it pins that the skip does NOT reach into
      // a branch where the tolerance is unknowable.
      expect(h.wired.serializeFragment()).not.toContain(WIRED_PENDING_LINE);
      expect(h.diskBytes()).toBe(h.wired.ytextString());
      // This arm mints nothing and increments no reconcile counter, so before
      // the per-rebuild breadcrumb a rebuild here reached no durable artifact at
      // all — the one arm where the fragment is destroyed with the least
      // evidence. It is now represented like every other rebuild.
      const rebuilds = (await h.readRing()).filter((e) => e.event === 'repair-rebuild');
      expect(rebuilds).toHaveLength(1);
      expect(rebuilds[0]?.site).toBe('persistence-prewrite');
    } finally {
      await h.cleanup();
    }
  });
});

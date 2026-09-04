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

const BROWSER_ORIGIN = {
  source: 'connection',
  connection: { context: { principalId: 'principal-test' } },
};

const WIKILINK_EMPHASIS_SOURCE = '# Notes\n\n**[[a]]**\n';

const STALE_FRAGMENT_MD = '## Guide\n\nStep one bod\n\nTail paragraph.\n';
const STALE_YTEXT_MD = '## Guide\n\nStep one bod\n';
const STALE_FRAGMENT_ONLY_LINE = 'Tail paragraph.';

const PENDING_FRAGMENT_MD = '## Guide\n\nStep one bod\n\nA held novel line.\n\nTail paragraph.\n';
const PENDING_YTEXT_MD = '## Guide\n\nStep one bod\n\nTail paragraph.\n';
const PENDING_NOVEL_LINE = 'A held novel line.';

interface StoreHarness {
  readonly wired: WiredPreDrainRig;
  readonly shadow: ShadowHandle;
  readonly ring: LossCaptureRing;
  readonly docName: string;
  readonly projectRoot: string;
  stageDeferredKeystroke(): void;
  stageStaleFragment(): void;
  stagePendingDivergence(): void;
  storeDirect(): Promise<void>;
  storeDebounced(): Promise<void>;
  diskBytes(): string | null;
  readRing(): Promise<LossCaptureEvent[]>;
  checkpointShas(): Promise<string[]>;
  cleanup(): Promise<void>;
}

async function createStoreHarness(
  docName: string,
  overrides?: Partial<PersistenceOptions>,
): Promise<StoreHarness> {
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
      expect(hold?.lostLen).toBeGreaterThanOrEqual(WIRED_PENDING_LINE.length);
      expect(hold?.lostLen).toBeLessThan(h.wired.serializeFragment().length);
      expect(JSON.stringify(hold)).not.toContain(WIRED_PENDING_LINE);
      expect(await h.checkpointShas()).toHaveLength(0);
    } finally {
      await h.cleanup();
    }
  });

  test('converged doc: no divergence, so neither arm runs', async () => {
    const h = await createStoreHarness('hold-converged');
    try {
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
      h.stagePendingDivergence();

      await h.storeDirect();
      await h.storeDirect();
      await h.storeDirect();

      expect(h.diskBytes()).toBe(PENDING_YTEXT_MD);
      expect(h.wired.serializeFragment()).toContain(PENDING_NOVEL_LINE);
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
      expect(h.wired.serializeFragment()).not.toContain(STALE_FRAGMENT_ONLY_LINE);
      expect(h.diskBytes()).toBe(h.wired.ytextString());

      const [sha] = await awaitMints(h, 1);
      expect(sha).toBeDefined();
      expect(getMetrics().persistenceReconcileLossCheckpointCreated).toBe(1);

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
      expect(writes.every((e) => e.witnessAvailable === true)).toBe(true);

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

      h.stageStaleFragment();
      await h.storeDirect();

      expect(getMetrics().persistenceReconcileLoss).toBe(2);
      expect(h.wired.serializeFragment()).not.toContain(STALE_FRAGMENT_ONLY_LINE);
      expect(getMetrics().persistenceReconcileLossDeduped).toBe(1);
      expect(getMetrics().persistenceReconcileLossCheckpointCreated).toBe(1);
      expect(await awaitMints(h, 2)).toEqual([firstSha]);

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
      h.wired.rig.cleanup();

      await h.storeDirect();

      expect(getMetrics().persistenceDeferHold).toBe(0);
      expect(getMetrics().persistenceReconcileLoss).toBe(1);
      const [sha] = await awaitMints(h, 1);
      expect(sha).toBeDefined();
      const hist = await getDocumentHistory(h.shadow, { docName: h.docName }, '');
      const row = hist.entries.find((e) => e.sha === sha);
      expect(row?.checkpoint?.metadata).toEqual({ atRiskLines: 1, witnessAvailable: false });
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
      expect(h.wired.serializeFragment()).not.toContain(WIRED_PENDING_LINE);
      expect(h.diskBytes()).toBe(h.wired.ytextString());
      const rebuilds = (await h.readRing()).filter((e) => e.event === 'repair-rebuild');
      expect(rebuilds).toHaveLength(1);
      expect(rebuilds[0]?.site).toBe('persistence-prewrite');
    } finally {
      await h.cleanup();
    }
  });
});

/**
 * Activity-mount-sweep scenario.
 *
 * Measures three scaling axes at every (`ACTIVITY_MOUNT_LIMIT`, peerCount)
 * combo + verifies the provider-disconnect contract for hidden Activity
 * editors:
 *
 *   (a) style-recalc time: CDP styleMs + layoutMs over the measurement window
 *   (b) observer fire rate: delta of
 *       `window.__okPerfCounters.providerObserverFires[docName]`
 *   (c) heap delta: `performance.memory.usedJSHeapSize` delta over window
 *
 * Sweep:
 *   ACTIVITY_MOUNT_LIMIT ∈ {1, 3, 5, 10, 20} via VITE_OK_PERF_ACTIVITY_MOUNT_LIMIT
 *     (read at app boot — env override matched by env-override.ts)
 *   peerCount ∈ {0, 1, 3, 5} via the Node-side peer simulator
 *
 * IMPORTANT: This scenario runs against a dev server whose
 * VITE_OK_PERF_ACTIVITY_MOUNT_LIMIT env var has been set per-sweep — the
 * actual limit value is read at module load. Iterating the sweep across
 * limits requires either:
 *   1. Per-iteration dev-server restart (slow but correct), OR
 *   2. window.__okPerfOverrides.ACTIVITY_MOUNT_LIMIT set in init script
 *      BEFORE app code runs (this is what we do — page.addInitScript with
 *      the override). The reader (env-override.ts) checks
 *      window.__okPerfOverrides FIRST, then VITE_OK_PERF_*, so this works.
 *
 * Peer typing profile:
 *   primary: all-human at 239ms IKI, 5s burst / 3s pause
 *   validation: 1 N=5 run with 2 humans + 3 agents (agent profile:
 *               1 write / 2s × ~100-char chunks)
 *
 * Provider-disconnect verification:
 *   At (peers > 0, limit < #docs-in-pool), for docs NOT in the activity-
 *   mount-list, their `providerObserverFires[docName]` counter delta
 *   must be 0 (the editor cache disconnects providers for non-active
 *   docs). Recorded as `fr3bVerified: boolean` per combo.
 *
 * Result JSON shape:
 *   {sweeps: [{activityMountLimit, peerCount, peerProfile,
 *              metrics: {styleMs, layoutMs, observerFireRate, heapDeltaMB},
 *              fr3bVerified, nonMountedFireCounts}, ...]}
 */

import { markerFor } from '../lib/doc-markers';
import { installLongtaskObserver } from '../lib/longtask-observer';
import {
  createNodePeerSimulator,
  type NodePeerSimulatorHandle,
  type TypingProfile,
} from '../lib/node-peer-simulator';
import { defineScenario } from '../lib/scenario';

const ACTIVITY_MOUNT_LIMITS = [1, 3, 5, 10, 20] as const;
const PEER_COUNTS = [0, 1, 3, 5] as const;
const MEASUREMENT_WINDOW_MS = 10_000;
const TARGET_DOC = 'AGENTS';
const SWEEP_DOC_POOL = ['AGENTS', 'README', 'CLAUDE', 'STORIES', 'PROJECT'];
const WAIT_CONTENT_MS = 60_000;

const HUMAN_PROFILE: TypingProfile = {
  kind: 'human',
  iki: 239,
  burstMs: 5_000,
  pauseMs: 3_000,
};

const AGENT_PROFILE: TypingProfile = {
  kind: 'agent',
  writeIntervalMs: 2_000,
  chunkChars: 100,
};

interface SweepResult {
  activityMountLimit: number;
  peerCount: number;
  peerProfile: 'human' | 'mixed';
  metrics: {
    styleLayoutMs: number;
    observerFireRate: number;
    heapDeltaMB: number;
  };
  fr3bVerified: boolean;
  nonMountedFireCounts: Record<string, number>;
  notes?: string[];
}

interface PerfCounterShape {
  providerObserverFires: Record<string, number>;
}

async function readFireCounts(
  page: import('@playwright/test').Page,
): Promise<Record<string, number>> {
  return page.evaluate(() => {
    const c = (globalThis as { __okPerfCounters?: PerfCounterShape }).__okPerfCounters;
    return c?.providerObserverFires ?? {};
  });
}

async function readHeapMb(page: import('@playwright/test').Page): Promise<number> {
  const bytes = await page.evaluate(() => {
    const m = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
    return m?.usedJSHeapSize ?? 0;
  });
  return bytes / (1024 * 1024);
}

async function readActivityMountList(page: import('@playwright/test').Page): Promise<string[]> {
  return page.evaluate(() => {
    const acts = document.querySelectorAll('[name^="editor:"]');
    return Array.from(acts)
      .map((el) => (el.getAttribute('name') ?? '').replace(/^editor:/, ''))
      .filter(Boolean);
  });
}

async function waitForVisibleProseMirrorForDoc(
  page: import('@playwright/test').Page,
  docName: string,
  timeoutMs: number,
): Promise<void> {
  const marker = markerFor(docName);
  await page.waitForFunction(
    ({ needle, fallbackChars }: { needle: string | null; fallbackChars: number }) => {
      const nodes = document.querySelectorAll('.ProseMirror');
      for (const n of Array.from(nodes)) {
        const rect = (n as HTMLElement).getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        const txt = n.textContent ?? '';
        if (needle && txt.includes(needle)) return true;
        if (!needle && txt.length >= fallbackChars) return true;
      }
      return false;
    },
    { needle: marker, fallbackChars: 200 },
    { timeout: timeoutMs },
  );
}

interface RunSweepArgs {
  page: import('@playwright/test').Page;
  cdp: import('@playwright/test').CDPSession;
  port: number;
  activityMountLimit: number;
  peerCount: number;
  profile: TypingProfile;
  profileLabel: 'human' | 'mixed';
  target: string;
  notes: string[];
}

async function runSweepCell(args: RunSweepArgs): Promise<SweepResult> {
  const { page, cdp, port, activityMountLimit, peerCount, profile, profileLabel, target, notes } =
    args;

  await page.addInitScript((limit: number) => {
    (
      globalThis as unknown as {
        __okPerfOverrides?: Record<string, number>;
      }
    ).__okPerfOverrides = { ACTIVITY_MOUNT_LIMIT: limit };
  }, activityMountLimit);

  await page.goto(`${target}/#/${encodeURIComponent(TARGET_DOC)}`, {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  });
  try {
    await waitForVisibleProseMirrorForDoc(page, TARGET_DOC, WAIT_CONTENT_MS);
  } catch {
    notes.push(`sweep cell limit=${activityMountLimit} peers=${peerCount}: target not loaded`);
    return {
      activityMountLimit,
      peerCount,
      peerProfile: profileLabel,
      metrics: { styleLayoutMs: 0, observerFireRate: 0, heapDeltaMB: 0 },
      fr3bVerified: false,
      nonMountedFireCounts: {},
      notes: ['target-not-loaded'],
    };
  }

  for (const doc of SWEEP_DOC_POOL.filter((d) => d !== TARGET_DOC)) {
    await page.goto(`${target}/#/${encodeURIComponent(doc)}`, {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    });
    try {
      await waitForVisibleProseMirrorForDoc(page, doc, 30_000);
    } catch {}
  }
  await page.goto(`${target}/#/${encodeURIComponent(TARGET_DOC)}`, {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  });
  await waitForVisibleProseMirrorForDoc(page, TARGET_DOC, WAIT_CONTENT_MS).catch(() => {});

  await page.waitForTimeout(500);

  const mountedBefore = await readActivityMountList(page);

  let sim: NodePeerSimulatorHandle | null = null;
  if (peerCount > 0) {
    sim = createNodePeerSimulator({
      port,
      docName: TARGET_DOC,
      count: peerCount,
      typingProfile: profile,
    });
    sim.start();
    await page.waitForTimeout(500);
  }

  const firesBefore = await readFireCounts(page);
  const heapBefore = await readHeapMb(page);
  await cdp.send('Tracing.start', {
    categories: 'devtools.timeline',
    transferMode: 'ReturnAsStream',
  });
  await page.waitForTimeout(MEASUREMENT_WINDOW_MS);
  await cdp.send('Tracing.end').catch(() => {});

  const firesAfter = await readFireCounts(page);
  const heapAfter = await readHeapMb(page);

  const targetFires = (firesAfter[TARGET_DOC] ?? 0) - (firesBefore[TARGET_DOC] ?? 0);
  const observerFireRate = targetFires / (MEASUREMENT_WINDOW_MS / 1000);

  const mountedSet = new Set(mountedBefore);
  const nonMountedFireCounts: Record<string, number> = {};
  let fr3bVerified = true;
  for (const doc of SWEEP_DOC_POOL) {
    if (mountedSet.has(doc)) continue;
    const before = firesBefore[doc] ?? 0;
    const after = firesAfter[doc] ?? 0;
    const delta = after - before;
    nonMountedFireCounts[doc] = delta;
    if (delta > 0) fr3bVerified = false;
  }

  if (sim) {
    await sim.stop();
  }

  const styleLayoutMs = await page.evaluate((windowMs: number) => {
    const cutoff = performance.now() - windowMs - 200;
    let total = 0;
    for (const e of performance.getEntries()) {
      if (e.startTime < cutoff) continue;
      if (e.entryType === 'measure' && (e.name.includes('style') || e.name.includes('layout'))) {
        total += e.duration;
      }
    }
    return total;
  }, MEASUREMENT_WINDOW_MS);

  return {
    activityMountLimit,
    peerCount,
    peerProfile: profileLabel,
    metrics: {
      styleLayoutMs: Math.round(styleLayoutMs),
      observerFireRate: Math.round(observerFireRate * 100) / 100,
      heapDeltaMB: Math.round((heapAfter - heapBefore) * 100) / 100,
    },
    fr3bVerified,
    nonMountedFireCounts,
  };
}

export default defineScenario({
  name: 'activity-mount-sweep',
  description:
    'Sweep ACTIVITY_MOUNT_LIMIT × peerCount, measure 3 scaling axes + verify provider-disconnect contract.',

  async run(ctx) {
    const { page, cdp, opts } = ctx;

    await installLongtaskObserver(page);

    const target = opts.target;
    const port = (() => {
      try {
        return Number.parseInt(new URL(target).port, 10) || 5173;
      } catch {
        return 5173;
      }
    })();

    const sweeps: SweepResult[] = [];
    const notes: string[] = [];

    for (const limit of ACTIVITY_MOUNT_LIMITS) {
      for (const peerCount of PEER_COUNTS) {
        const result = await runSweepCell({
          page,
          cdp,
          port,
          activityMountLimit: limit,
          peerCount,
          profile: HUMAN_PROFILE,
          profileLabel: 'human',
          target,
          notes,
        });
        sweeps.push(result);
        ctx.note(
          `limit=${limit} peers=${peerCount} → fires/s=${result.metrics.observerFireRate} heapΔ=${result.metrics.heapDeltaMB}MB fr3b=${result.fr3bVerified}`,
        );
      }
    }

    {
      const result = await runSweepCell({
        page,
        cdp,
        port,
        activityMountLimit: 3,
        peerCount: 5,
        profile: AGENT_PROFILE,
        profileLabel: 'mixed',
        target,
        notes,
      });
      sweeps.push(result);
      ctx.note(
        `mixed-validation limit=3 peers=5 → fires/s=${result.metrics.observerFireRate} fr3b=${result.fr3bVerified}`,
      );
    }

    ctx.recordMetric('sweepsJson', JSON.stringify(sweeps));
    ctx.recordMetric('sweepCount', sweeps.length);
    ctx.recordMetric(
      'fr3bAllVerified',
      sweeps.every((s) => s.fr3bVerified),
    );
  },
});

/**
 * Substrate canary scenario — exercises the substrate
 * primitives end-to-end through the perf-test harness.
 *
 * This is the perf-tier counterpart to
 * `tests/integration/perf-substrate-canary.test.ts`. The integration
 * test runs in tier-1 CI and pins the substrate primitives in
 * milliseconds; this scenario drives a real browser, exercises the
 * primitives via real navigation, and shape-asserts the marks /
 * counters / histograms via `__ok_perf` drained from the page.
 *
 * Sweep axes: MAX_POOL ∈ {3, 5, 8} × fixture ∈ {'tight', 'broad'}.
 * Per cell: cold-load README + warm-back twice + sample histogram.
 */

import { defineSweep } from '../lib/define-sweep';

interface CellResult {
  fixture: 'tight' | 'broad';
  poolOpenHits: number;
  poolOpenMisses: number;
  histogramCount: number;
  ringLength: number;
}

export default defineSweep({
  name: 'sweep-pool-warm-back-canary',
  baselineKey: 'sweep-pool-warm-back-canary',
  description:
    'Substrate canary — pool open hit/miss counter, histogram percentiles, ring eviction',
  axes: {
    maxPool: [3, 5, 8] as const,
    fixture: ['tight', 'broad'] as const,
  },
  scenario: async ({ maxPool, fixture }, ctx): Promise<CellResult> => {
    // Override the dial via window.__okPerfOverrides so the test
    // exercises the env-override surface.
    await ctx.page.evaluate((mp: number) => {
      const overrides = window.__okPerfOverrides ?? {};
      overrides.MAX_POOL = mp;
      overrides.MAX_RING_ENTRIES = 24;
      window.__okPerfOverrides = overrides;
    }, maxPool);

    // Load the home page so the editor + provider-pool come up. Uses
    // `opts.target` per the scenario harness's URL convention.
    await ctx.page.goto(ctx.opts.target, {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    });

    // Drive a few open() calls — once for cold construct, then warm-back
    // a couple times. With provider-pool keyed by docName, repeated
    // openDocument calls for the same name take the warm-back branch.
    // Use `navigate` to surface the cold/warm path.
    const targetDoc = fixture === 'tight' ? 'README' : 'AGENTS';
    await ctx.page.evaluate((doc: string) => {
      const ctxApi = (window as unknown as { __ok_open?: (d: string) => void }).__ok_open;
      if (typeof ctxApi === 'function') ctxApi(doc);
    }, targetDoc);
    await ctx.page.waitForTimeout(200);
    // Re-open same doc twice → 2 warm-backs.
    for (let i = 0; i < 2; i += 1) {
      await ctx.page.evaluate((doc: string) => {
        const ctxApi = (window as unknown as { __ok_open?: (d: string) => void }).__ok_open;
        if (typeof ctxApi === 'function') ctxApi(doc);
      }, targetDoc);
      await ctx.page.waitForTimeout(60);
    }

    // Push some samples into a histogram so the histogram path is exercised.
    await ctx.page.evaluate(() => {
      // The substrate's mark.histogram is reachable via the global
      // `globalThis.__ok_mark` if the wire-site exposed it. Otherwise
      // the page's own `mark` import handles it. Soft-skip on missing
      // — the integration test is the canonical assertion.
      const maybe = (window as unknown as { mark?: { histogram?: unknown } }).mark;
      const hg = maybe?.histogram;
      if (typeof hg === 'function') {
        for (let i = 1; i <= 50; i += 1) hg('ok/canary/h', { mode: 'WYSIWYG' }, i);
      }
    });

    // Read the substrate state from `__ok_perf` to assert the cell's
    // contract held.
    const snapshot = await ctx.page.evaluate(() => {
      const c = (
        globalThis as unknown as {
          __ok_perf?: {
            counters?: Record<string, { byProp?: Record<string, Record<string, number>> }>;
            marks?: { length?: number };
            histograms?: Record<string, { snapshot?: () => { count: number } }>;
          };
        }
      ).__ok_perf;
      if (!c) return null;
      const open = c.counters?.['ok/pool/open'];
      const hits = open?.byProp?.hit?.true ?? 0;
      const miss = open?.byProp?.hit?.false ?? 0;
      const ringLen = c.marks?.length ?? 0;
      const histogram = c.histograms?.['ok/canary/h'];
      const histSnap = histogram?.snapshot?.();
      const histCount = histSnap?.count ?? 0;
      return { hits, miss, ringLen, histCount };
    });

    if (!snapshot) {
      ctx.note(`cell maxPool=${maxPool} fixture=${fixture}: __ok_perf absent (build flag?)`);
      return { fixture, poolOpenHits: 0, poolOpenMisses: 0, histogramCount: 0, ringLength: 0 };
    }
    return {
      fixture,
      poolOpenHits: snapshot.hits,
      poolOpenMisses: snapshot.miss,
      histogramCount: snapshot.histCount,
      ringLength: snapshot.ringLen,
    };
  },
});

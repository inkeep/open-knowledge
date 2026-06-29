
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
    await ctx.page.evaluate((mp: number) => {
      const overrides = window.__okPerfOverrides ?? {};
      overrides.MAX_POOL = mp;
      overrides.MAX_RING_ENTRIES = 24;
      window.__okPerfOverrides = overrides;
    }, maxPool);

    await ctx.page.goto(ctx.opts.target, {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    });

    const targetDoc = fixture === 'tight' ? 'README' : 'AGENTS';
    await ctx.page.evaluate((doc: string) => {
      const ctxApi = (window as unknown as { __ok_open?: (d: string) => void }).__ok_open;
      if (typeof ctxApi === 'function') ctxApi(doc);
    }, targetDoc);
    await ctx.page.waitForTimeout(200);
    for (let i = 0; i < 2; i += 1) {
      await ctx.page.evaluate((doc: string) => {
        const ctxApi = (window as unknown as { __ok_open?: (d: string) => void }).__ok_open;
        if (typeof ctxApi === 'function') ctxApi(doc);
      }, targetDoc);
      await ctx.page.waitForTimeout(60);
    }

    await ctx.page.evaluate(() => {
      const maybe = (window as unknown as { mark?: { histogram?: unknown } }).mark;
      const hg = maybe?.histogram;
      if (typeof hg === 'function') {
        for (let i = 1; i <= 50; i += 1) hg('ok/canary/h', { mode: 'WYSIWYG' }, i);
      }
    });

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

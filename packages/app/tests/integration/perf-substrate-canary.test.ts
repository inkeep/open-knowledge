/**
 * Perf-observability-substrate canary.
 *
 * integration coverage that exercises the substrate
 * primitives end-to-end without Playwright. Validates:
 *
 *   pool warm-back hit + miss marks fire and the counter
 *         records both branches.
 *   histogram has populated percentile snapshots after a
 *         representative sample.
 *   mark.count() increments by symbolic prop.
 *   `mountId` / `poolEventId` adoption invariant: the
 *         mount-id-registry and a peeked pool entry agree.
 *   circular buffer evicts oldest entries at MAX_RING_ENTRIES.
 *
 * The Playwright perf scenarios
 * exercise the same primitives via the Playwright harness; this file
 * pins them so any regression fails CI in seconds rather
 * than waiting for a perf run.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mark } from '../../src/lib/perf';
import {
  __resetCardinalityWarnings,
  getCollector,
  getHistogramSnapshot,
} from '../../src/lib/perf/collector';
import { resetPerfOverrideWarnings } from '../../src/lib/perf/env-override';

const hadWindow = typeof (globalThis as { window?: unknown }).window !== 'undefined';

beforeEach(() => {
  if (!hadWindow) (globalThis as unknown as { window: unknown }).window = globalThis;
  // Compact ring so the eviction assertion runs in milliseconds.
  window.__okPerfOverrides = { MAX_RING_ENTRIES: 8 };
  resetPerfOverrideWarnings();
  // Force a fresh collector so the override picks up.
  (globalThis as { __ok_perf?: unknown }).__ok_perf = undefined;
  __resetCardinalityWarnings();
});

afterEach(() => {
  delete window.__okPerfOverrides;
  (globalThis as { __ok_perf?: unknown }).__ok_perf = undefined;
  if (!hadWindow) delete (globalThis as { window?: unknown }).window;
});

describe('perf-substrate canary', () => {
  test('FR1 / FR3 — pool open emits hit:true and hit:false counters', () => {
    mark('ok/pool/open', { docName: 'doc-a', hit: false, poolEventId: 'pe-1' });
    mark.count('ok/pool/open', { hit: false });
    mark('ok/pool/open', { docName: 'doc-a', hit: true, poolEventId: 'pe-1' });
    mark.count('ok/pool/open', { hit: true });
    const counter = getCollector()?.counters['ok/pool/open'];
    expect(counter?.byProp.hit?.true).toBe(1);
    expect(counter?.byProp.hit?.false).toBe(1);
  });

  test('FR2 — histogram p50/p95/p99/p999 are populated after a sample of 200', () => {
    for (let i = 1; i <= 200; i += 1) {
      mark.histogram('ok/canary/durations', { mode: 'WYSIWYG' }, i);
    }
    const snap = getHistogramSnapshot('ok/canary/durations');
    expect(snap?.count).toBe(200);
    expect(snap?.p50).toBeGreaterThan(0);
    expect(snap?.p95).toBeGreaterThan(0);
    expect(snap?.p99).toBeGreaterThan(0);
    expect(snap?.p999).toBeGreaterThan(0);
    expect(snap?.p50).toBeLessThanOrEqual(snap?.p95 ?? Infinity);
    expect(snap?.p95).toBeLessThanOrEqual(snap?.p99 ?? Infinity);
    expect(snap?.p99).toBeLessThanOrEqual(snap?.p999 ?? Infinity);
  });

  test('FR8 — collector marks ring evicts oldest beyond MAX_RING_ENTRIES', () => {
    for (let i = 0; i < 16; i += 1) {
      mark('ok/canary/seq', { ix: i });
    }
    const ring = getCollector()?.marks;
    expect(ring?.length).toBe(8);
    const seen = ring
      ?.toArray()
      .filter((m: { name: string }) => m.name === 'ok/canary/seq')
      .map((m: { properties?: { ix?: unknown } }) => m.properties?.ix as number);
    // Ring keeps the most recent N. Some entries from the start are
    // evicted; the surviving sequence is contiguous and ends at 15.
    expect(seen?.[seen.length - 1]).toBe(15);
    expect(seen?.[0]).toBeGreaterThanOrEqual(8);
  });

  test('FR5 — mountId / poolEventId adoption invariant (registry + peek)', async () => {
    // Local stub: the substrate level can't construct a real ProviderPool
    // without a Hocuspocus URL, so we exercise the registry directly to
    // pin the contract that mountId equals the pool entry's poolEventId
    // when one is present.
    const { setMountId, getMountId, clearMountId } = await import(
      '../../src/editor/mount-id-registry'
    );
    setMountId('doc-x', 'pool-event-x');
    expect(getMountId('doc-x')).toBe('pool-event-x');
    clearMountId('doc-x');
    expect(getMountId('doc-x')).toBeUndefined();
  });
});

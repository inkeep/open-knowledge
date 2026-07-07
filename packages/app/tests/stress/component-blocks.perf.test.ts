/**
 * Performance benchmarks for Component Blocks v2.
 *
 * Runs as Bun stress tests. Lives via turbo task `test:perf`.
 *
 * Rendering-performance benchmarks require a React/DOM env to measure render
 * counts. CRDT-level performance benchmarks can run as pure Bun unit tests.
 *
 * Calibration: this benchmark asserts a relative regression bound (p95 of the
 * steady-state tail ≤ `REGRESSION_RATIO` × p95 of the warm-up tail, plus
 * an absolute sanity ceiling) rather than absolute-ms thresholds. The
 * perf-gate calibration rule is `max(2× p99 variance, 10% absolute floor)`:
 * absolute-ms in a Bun tier-1 path is CI-runner-speed-sensitive and under
 * `failOnFlakyTests: false` silently retries to green (eroding signal);
 * under a future policy flip it would produce PR-red on correct code.
 */

import { describe, expect, test } from 'bun:test';
import * as Y from 'yjs';
import { sharedExtensions } from '../../../../packages/core/src/extensions/shared.ts';
import { MarkdownManager } from '../../../../packages/core/src/markdown/index.ts';

const mdManager = new MarkdownManager({ extensions: sharedExtensions });

// ── PF03: Observer B parseWithFallback cycle time ──────────────

/**
 * Regression bound: steady-state p95 must not exceed `REGRESSION_RATIO` ×
 * warm-up p95. Chosen to catch any ≥3× slowdown on the hot path (the class
 * of regression the test exists to surface) while tolerating per-keystroke
 * variance from GC / JIT tiering / CI runner noise.
 */
const REGRESSION_RATIO = 3;
/**
 * Absolute sanity ceiling — absurdly slow parse would indicate catastrophic
 * breakage (stack overflow recovery, pathological recursion, unbounded log
 * emission). Chosen loose enough to be CI-runner-agnostic; any value below
 * this is evidence the hot path is not catastrophically broken.
 */
const MAX_CATASTROPHIC_MS = 500;

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[idx] ?? 0;
}

describe('PF03: parseWithFallback cycle time under load', () => {
  test('500 keystrokes on doc with 20 jsxComponents — steady-state p95 within 3× warm-up', () => {
    // Build a realistic document with 20 jsxComponents (mix of registered + broken)
    const components = Array.from({ length: 15 }, (_, i) =>
      [
        `<Callout type="${i % 2 === 0 ? 'warning' : 'info'}">`,
        '',
        `Content block ${i + 1} with some **bold** and *italic* text.`,
        '',
        '</Callout>',
      ].join('\n'),
    );

    // Add 5 broken components
    const broken = Array.from({ length: 5 }, (_, i) =>
      [`<BrokenComponent${i} attr="`, '', `Some content that won't parse cleanly`, ''].join('\n'),
    );

    const baseDoc = [...components, ...broken, '# Clean heading', '', 'Some paragraph text.'].join(
      '\n\n',
    );

    // Simulate 500 keystrokes by progressively editing the clean paragraph.
    // First 50 are warm-up (JIT tiering, GC pressure normalizes). Remaining
    // 450 are steady-state; compare p95 of each to establish regression ratio.
    const WARM_UP = 50;
    const TOTAL = 500;
    const timings: number[] = [];
    let doc = baseDoc;

    for (let i = 0; i < TOTAL; i++) {
      // Append a character to the clean paragraph area
      doc = `${doc}${String.fromCharCode(97 + (i % 26))}`;

      const start = performance.now();
      const result = mdManager.parseWithFallback(doc);
      const elapsed = performance.now() - start;
      timings.push(elapsed);

      // Verify result is always a valid PM doc (parseWithFallback never throws)
      expect(result).toBeDefined();
      expect(result.type).toBe('doc');
    }

    const warmUpSorted = timings.slice(0, WARM_UP).sort((a, b) => a - b);
    const steadySorted = timings.slice(WARM_UP).sort((a, b) => a - b);
    const warmUpP95 = percentile(warmUpSorted, 0.95);
    const steadyP95 = percentile(steadySorted, 0.95);
    const maxVal = Math.max(...timings);

    console.log(
      `PF03 results: warmUpP95=${warmUpP95.toFixed(2)}ms, steadyP95=${steadyP95.toFixed(2)}ms, max=${maxVal.toFixed(2)}ms`,
    );

    // (1) Relative regression bound. Absent pathological slowdown, steady-state
    //     is typically AT or below warm-up (JIT advantage). A 3× drift indicates
    //     genuine regression on the parseWithFallback hot path.
    expect(steadyP95).toBeLessThan(Math.max(warmUpP95 * REGRESSION_RATIO, 1));

    // (2) Absolute sanity ceiling. Any parseWithFallback call taking more than
    //     half a second is catastrophically broken (stack overflow recovery,
    //     unbounded retry, pathological recursion) regardless of runner speed.
    expect(maxVal).toBeLessThan(MAX_CATASTROPHIC_MS);
  });
});

// ── PF05: Y.Item count growth under typing in jsxInline ───────

describe('PF05: Y.Item growth under jsxInline typing', () => {
  test('100-keystroke typing in jsxInline content — Y.Item delta ≤ keystroke_count + constant', () => {
    const ydoc = new Y.Doc();
    const ytext = ydoc.getText('source');

    // Initial content with a jsxInline node
    const initialContent = 'Hello <Icon name="check" /> world';
    ytext.insert(0, initialContent);

    // Count initial items
    const countItems = (yt: Y.Text): number => {
      let count = 0;
      let item = yt._start;
      while (item !== null) {
        if (!item.deleted) count++;
        item = item.right;
      }
      return count;
    };

    const initialItems = countItems(ytext);
    const KEYSTROKE_COUNT = 100;

    // Simulate 100 keystrokes appended after the jsxInline
    for (let i = 0; i < KEYSTROKE_COUNT; i++) {
      const insertPos = ytext.toString().length;
      ydoc.transact(() => {
        ytext.insert(insertPos, String.fromCharCode(97 + (i % 26)));
      });
    }

    const finalItems = countItems(ytext);
    const itemDelta = finalItems - initialItems;

    console.log(
      `PF05 results: initialItems=${initialItems}, finalItems=${finalItems}, delta=${itemDelta}, keystrokes=${KEYSTROKE_COUNT}`,
    );

    // Y.Item delta should be ≤ keystroke_count + small constant overhead
    // Each character insert creates at most 1 Y.Item. Constant overhead accounts
    // for initial content structure items.
    const CONSTANT_OVERHEAD = 10;
    expect(itemDelta).toBeLessThanOrEqual(KEYSTROKE_COUNT + CONSTANT_OVERHEAD);

    // Verify no super-linear growth (which would indicate Y.XmlElement churn)
    expect(itemDelta).toBeLessThan(KEYSTROKE_COUNT * 2);
  });
});

// Context Bridge store throughput benchmark removed: the Context Bridge
// infrastructure it benchmarked (packages/app/src/editor/context-bridge/,
// bridge-id-plugin.ts) was deleted as dormant. Compound components use the
// DOM data-attribute pattern and do not go through a publish/subscribe
// store. When the Context Bridge architecture is revived for accessible
// Radix bridging, restore this benchmark alongside the store.

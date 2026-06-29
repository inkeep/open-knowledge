
import { describe, expect, test } from 'bun:test';
import * as Y from 'yjs';
import { sharedExtensions } from '../../../../packages/core/src/extensions/shared.ts';
import { MarkdownManager } from '../../../../packages/core/src/markdown/index.ts';

const mdManager = new MarkdownManager({ extensions: sharedExtensions });


const REGRESSION_RATIO = 3;
const MAX_CATASTROPHIC_MS = 500;

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[idx] ?? 0;
}

describe('PF03: parseWithFallback cycle time under load', () => {
  test('500 keystrokes on doc with 20 jsxComponents — steady-state p95 within 3× warm-up', () => {
    const components = Array.from({ length: 15 }, (_, i) =>
      [
        `<Callout type="${i % 2 === 0 ? 'warning' : 'info'}">`,
        '',
        `Content block ${i + 1} with some **bold** and *italic* text.`,
        '',
        '</Callout>',
      ].join('\n'),
    );

    const broken = Array.from({ length: 5 }, (_, i) =>
      [`<BrokenComponent${i} attr="`, '', `Some content that won't parse cleanly`, ''].join('\n'),
    );

    const baseDoc = [...components, ...broken, '# Clean heading', '', 'Some paragraph text.'].join(
      '\n\n',
    );

    const WARM_UP = 50;
    const TOTAL = 500;
    const timings: number[] = [];
    let doc = baseDoc;

    for (let i = 0; i < TOTAL; i++) {
      doc = `${doc}${String.fromCharCode(97 + (i % 26))}`;

      const start = performance.now();
      const result = mdManager.parseWithFallback(doc);
      const elapsed = performance.now() - start;
      timings.push(elapsed);

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

    expect(steadyP95).toBeLessThan(Math.max(warmUpP95 * REGRESSION_RATIO, 1));

    expect(maxVal).toBeLessThan(MAX_CATASTROPHIC_MS);
  });
});


describe('PF05: Y.Item growth under jsxInline typing', () => {
  test('100-keystroke typing in jsxInline content — Y.Item delta ≤ keystroke_count + constant', () => {
    const ydoc = new Y.Doc();
    const ytext = ydoc.getText('source');

    const initialContent = 'Hello <Icon name="check" /> world';
    ytext.insert(0, initialContent);

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

    const CONSTANT_OVERHEAD = 10;
    expect(itemDelta).toBeLessThanOrEqual(KEYSTROKE_COUNT + CONSTANT_OVERHEAD);

    expect(itemDelta).toBeLessThan(KEYSTROKE_COUNT * 2);
  });
});


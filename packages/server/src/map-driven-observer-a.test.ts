/**
 * Integration tests for the map-driven Observer A Path A write surface —
 * the default Path A: an XmlFragment edit that changes only one (or a
 * contiguous range of) top-level block(s) must produce a SINGLE Y.Text
 * splice covering exactly that range — bytes outside the splice survive
 * byte-identically (the byte-granular property at the bridge layer).
 *
 * The harness mirrors `server-observers.test.ts` — synthetic `Y.Doc` (no
 * Hocuspocus), populate XmlFragment via `updateYFragment`, observe the
 * Y.Text delta to assert splice shape directly.
 */
import { describe, expect, spyOn, test } from 'bun:test';
import { MarkdownManager, sharedExtensions } from '@inkeep/open-knowledge-core';
import { getSchema } from '@tiptap/core';
import { updateYFragment } from '@tiptap/y-tiptap';
import * as Y from 'yjs';
import { AGENT_WRITE_ORIGIN } from './agent-sessions.ts';
import { composeAndWriteRawBody } from './bridge-intake.ts';
import { computeMapDrivenBodySplice } from './map-driven-splice.ts';
import { getMetrics } from './metrics.ts';
import {
  __resetMapDrivenParseErrorWarnForTests,
  OBSERVER_SYNC_ORIGIN,
  setupServerObservers,
} from './server-observers.ts';

const mdManager = new MarkdownManager({ extensions: sharedExtensions });
const schema = getSchema(sharedExtensions);

function createTestDoc() {
  const doc = new Y.Doc();
  const xmlFragment = doc.getXmlFragment('default');
  const ytext = doc.getText('source');
  return { doc, xmlFragment, ytext };
}

function populateFragment(doc: Y.Doc, xmlFragment: Y.XmlFragment, md: string): void {
  const json = mdManager.parse(md);
  const pmNode = schema.nodeFromJSON(json);
  const meta = { mapping: new Map(), isOMark: new Map() };
  updateYFragment(doc, xmlFragment, pmNode, meta);
}

interface CapturedDelta {
  readonly origin: unknown;
  readonly ops: ReadonlyArray<{ retain?: number; insert?: string | unknown[]; delete?: number }>;
}

function captureYTextDeltas(ytext: Y.Text): CapturedDelta[] {
  const captured: CapturedDelta[] = [];
  const handler = (event: Y.YTextEvent, transaction: Y.Transaction): void => {
    captured.push({ origin: transaction.origin, ops: event.changes.delta });
  };
  ytext.observe(handler);
  return captured;
}

describe('map-driven Observer A — default Path A behavior', () => {
  test('(a) single-block edit produces narrow splice covering only the edited block', () => {
    const { doc, xmlFragment, ytext } = createTestDoc();
    populateFragment(doc, xmlFragment, '# Heading\n\nFirst paragraph.\n\nSecond paragraph.\n');
    const cleanup = setupServerObservers({ doc, xmlFragment, ytext, mdManager, schema });

    const before = ytext.toString();
    const deltas = captureYTextDeltas(ytext);

    populateFragment(
      doc,
      xmlFragment,
      '# Heading\n\nFirst paragraph EDITED.\n\nSecond paragraph.\n',
    );

    const observerWrites = deltas.filter((d) => d.origin === OBSERVER_SYNC_ORIGIN);
    expect(observerWrites.length).toBeGreaterThanOrEqual(1);
    const mapDrivenWrite = observerWrites[observerWrites.length - 1];

    const retainOps = mapDrivenWrite.ops.filter((op) => op.retain !== undefined);
    const insertOps = mapDrivenWrite.ops.filter((op) => op.insert !== undefined);
    const deleteOps = mapDrivenWrite.ops.filter((op) => op.delete !== undefined);

    expect(retainOps.length).toBeLessThanOrEqual(2);
    expect(insertOps.length + deleteOps.length).toBeGreaterThanOrEqual(1);

    const headingEnd = before.indexOf('# Heading') + '# Heading'.length;
    const secondParaStart = before.indexOf('Second paragraph');

    const leadingRetain = mapDrivenWrite.ops[0]?.retain ?? 0;
    expect(leadingRetain).toBeGreaterThanOrEqual(headingEnd);
    expect(leadingRetain).toBeLessThanOrEqual(before.indexOf('First paragraph') + 1);

    let cursorAfterWrite = leadingRetain;
    for (const op of mapDrivenWrite.ops.slice(1)) {
      if (op.delete !== undefined) cursorAfterWrite += op.delete;
    }
    expect(cursorAfterWrite).toBeLessThanOrEqual(secondParaStart);

    cleanup();
  });

  test('(b) untouched bytes outside the splice are byte-identical pre→post (AC1)', () => {
    const { doc, xmlFragment, ytext } = createTestDoc();
    populateFragment(doc, xmlFragment, '# Heading\n\nFirst.\n\nUntouched bytes here.\n');
    const cleanup = setupServerObservers({ doc, xmlFragment, ytext, mdManager, schema });

    const before = ytext.toString();
    const untouchedSnippet = 'Untouched bytes here.';
    const untouchedStartBefore = before.indexOf(untouchedSnippet);
    expect(untouchedStartBefore).toBeGreaterThanOrEqual(0);
    const tailBefore = before.slice(untouchedStartBefore);

    populateFragment(doc, xmlFragment, '# Heading\n\nEDITED first.\n\nUntouched bytes here.\n');

    const after = ytext.toString();
    const untouchedStartAfter = after.indexOf(untouchedSnippet);
    expect(untouchedStartAfter).toBeGreaterThanOrEqual(0);
    expect(after.slice(untouchedStartAfter)).toBe(tailBefore);

    cleanup();
  });

  test('(c) contiguous multi-block edit produces splice union covering both edited blocks', () => {
    const { doc, xmlFragment, ytext } = createTestDoc();
    populateFragment(doc, xmlFragment, 'first.\n\nsecond.\n\nthird.\n');
    const cleanup = setupServerObservers({ doc, xmlFragment, ytext, mdManager, schema });

    const before = ytext.toString();
    const deltas = captureYTextDeltas(ytext);

    populateFragment(doc, xmlFragment, 'first EDITED.\n\nsecond EDITED.\n\nthird.\n');

    const observerWrites = deltas.filter((d) => d.origin === OBSERVER_SYNC_ORIGIN);
    const mapDrivenWrite = observerWrites[observerWrites.length - 1];

    const leadingRetain = mapDrivenWrite.ops[0]?.retain ?? 0;
    let cursorAfterDeletes = leadingRetain;
    for (const op of mapDrivenWrite.ops.slice(1)) {
      if (op.delete !== undefined) cursorAfterDeletes += op.delete;
    }
    const thirdStart = before.indexOf('third.');
    expect(cursorAfterDeletes).toBeLessThanOrEqual(thirdStart);

    const after = ytext.toString();
    expect(after).toContain('first EDITED.');
    expect(after).toContain('second EDITED.');
    expect(after.slice(after.indexOf('third.'))).toBe(before.slice(thirdStart));

    cleanup();
  });

  test('(d) synthetic-doc name short-circuits to fallback path (no map-driven splice attempted)', () => {
    const { doc, xmlFragment, ytext } = createTestDoc();
    populateFragment(doc, xmlFragment, 'A.\n\nB.\n');
    const cleanup = setupServerObservers({
      doc,
      xmlFragment,
      ytext,
      mdManager,
      schema,
      docName: '__system__',
    });

    populateFragment(doc, xmlFragment, 'A EDITED.\n\nB.\n');

    expect(ytext.toString()).toContain('A EDITED.');
    expect(ytext.toString()).toContain('B.');

    cleanup();
  });

  test('(e) edit in paragraph containing ==highlight== degrades to block granularity (documented sub-block limitation)', () => {
    const { doc, xmlFragment, ytext } = createTestDoc();
    populateFragment(doc, xmlFragment, 'Para with ==highlight== inside.\n\nUntouched after.\n');
    const cleanup = setupServerObservers({ doc, xmlFragment, ytext, mdManager, schema });

    const before = ytext.toString();
    const untouchedSnippet = 'Untouched after.';
    const tailBefore = before.slice(before.indexOf(untouchedSnippet));

    populateFragment(
      doc,
      xmlFragment,
      'Para with ==highlight== inside EDITED.\n\nUntouched after.\n',
    );

    const after = ytext.toString();
    const untouchedStartAfter = after.indexOf(untouchedSnippet);
    expect(untouchedStartAfter).toBeGreaterThanOrEqual(0);
    expect(after.slice(untouchedStartAfter)).toBe(tailBefore);

    cleanup();
  });

  test('(f) map-driven splice is the default — active with no env configuration', () => {
    // A splice-discriminating shape: the row without a trailing pipe still
    // canonicalizes under serialize(parse), so its bytes survive an edit in
    // ANOTHER block only via block-splice preservation — the whole-body
    // incremental line diff rewrites it. No env var is set here.
    expect(process.env.OK_MAP_DRIVEN_OBSERVER_A).toBeUndefined();

    const raw = '# Notes\n\n| a | b |\n| - | - |\n| 1 | 2\n';
    const { doc, xmlFragment, ytext } = createTestDoc();
    const cleanup = setupServerObservers({ doc, xmlFragment, ytext, mdManager, schema });
    doc.transact(() => {
      composeAndWriteRawBody(doc, raw, 'agent');
    }, AGENT_WRITE_ORIGIN);
    expect(ytext.toString()).toBe(raw);

    populateFragment(doc, xmlFragment, raw.replace('# Notes', '# Notes EDITED'));

    expect(ytext.toString()).toContain('# Notes EDITED');
    expect(ytext.toString()).toContain('| 1 | 2\n');

    cleanup();
  });

  test('(g) fallback: an offset-less block (comment block) falls back to applyIncrementalDiff and still converges', () => {
    // Comment blocks parse to position-less mdast nodes, so the splice is
    // not computable and Path A must fall back to the incremental line
    // diff — the bridge always makes progress.
    const { doc, xmlFragment, ytext } = createTestDoc();
    populateFragment(doc, xmlFragment, '<!-- note -->\n\nOriginal.\n');
    const cleanup = setupServerObservers({ doc, xmlFragment, ytext, mdManager, schema });

    populateFragment(doc, xmlFragment, '<!-- note -->\n\nOriginal.\n\nAdded.\n');

    expect(ytext.toString()).toContain('Original.');
    expect(ytext.toString()).toContain('Added.');

    cleanup();
  });

  describe('dash-count tripwire — concurrent source-form table edits are detected + spliced, never silently dropped', () => {
    // The structural block comparison must stay data-aware: a delimiter-row
    // padding change arrives ONLY as a data.source* difference (the cell
    // contents are identical). A comparison that strips `data` judges the
    // tables equal, skips the splice, and silently drops the user's edit —
    // a P0 table-padding loss. These tests go RED if anyone re-introduces
    // that data-strip shortcut.
    const narrowDashBody = 'before\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\nafter\n';
    const wideDashBody = 'before\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\nafter\n';

    test('computeMapDrivenBodySplice detects a dash-count-only change and emits the splice', () => {
      const splice = computeMapDrivenBodySplice(
        narrowDashBody,
        mdManager.parse(wideDashBody),
        mdManager,
      );

      expect(splice).not.toBeNull();
      if (!splice) throw new Error('unreachable');
      const applied =
        narrowDashBody.slice(0, splice.spliceStart) +
        splice.newSlice +
        narrowDashBody.slice(splice.spliceEnd);
      expect(applied).toBe(wideDashBody);
    });

    test('Observer A applies a dash-count-only fragment change to Y.Text (detected + spliced, blocks outside untouched)', () => {
      const { doc, xmlFragment, ytext } = createTestDoc();
      populateFragment(doc, xmlFragment, narrowDashBody);
      const cleanup = setupServerObservers({ doc, xmlFragment, ytext, mdManager, schema });
      expect(ytext.toString()).toBe(narrowDashBody);

      populateFragment(doc, xmlFragment, wideDashBody);

      expect(ytext.toString()).toBe(wideDashBody);

      cleanup();
    });
  });

  describe('splice-path observability — applied vs fallback(reason) counters', () => {
    // The map-driven splice is the default byte-preserving path; every drain
    // it cannot serve silently routes through the lossier incremental-diff /
    // merge fallbacks. These tests pin that the dispatch records applied vs
    // fallback-with-reason, so a systemic regression (e.g. a parser bump that
    // starts throwing) is visible in /api/metrics/reconciliation instead of
    // looking identical to normal operation. Deltas, not absolutes — the
    // metrics module is process-global and other tests in this file fire
    // observers too.
    function fallbackTotal(m: ReturnType<typeof getMetrics>): number {
      return Object.values(m.mapDrivenSpliceFallback).reduce((a, b) => a + (b ?? 0), 0);
    }

    test('a successful map-driven splice increments mapDrivenSpliceApplied (no fallback)', () => {
      const raw = '# Heading\n\nFirst.\n\nSecond.\n';
      const { doc, xmlFragment, ytext } = createTestDoc();
      const cleanup = setupServerObservers({ doc, xmlFragment, ytext, mdManager, schema });
      doc.transact(() => {
        composeAndWriteRawBody(doc, raw, 'agent');
      }, AGENT_WRITE_ORIGIN);
      expect(ytext.toString()).toBe(raw);

      const before = getMetrics();
      populateFragment(doc, xmlFragment, raw.replace('First.', 'First EDITED.'));
      const after = getMetrics();

      expect(after.mapDrivenSpliceApplied - before.mapDrivenSpliceApplied).toBe(1);
      expect(fallbackTotal(after) - fallbackTotal(before)).toBe(0);

      cleanup();
    });

    test('a synthetic-doc drain increments fallback reason synthetic-doc, not applied', () => {
      const raw = 'A.\n\nB.\n';
      const { doc, xmlFragment, ytext } = createTestDoc();
      const cleanup = setupServerObservers({
        doc,
        xmlFragment,
        ytext,
        mdManager,
        schema,
        docName: '__system__',
      });
      doc.transact(() => {
        composeAndWriteRawBody(doc, raw, 'agent');
      }, AGENT_WRITE_ORIGIN);

      const before = getMetrics();
      populateFragment(doc, xmlFragment, 'A EDITED.\n\nB.\n');
      const after = getMetrics();

      expect(
        (after.mapDrivenSpliceFallback['synthetic-doc'] ?? 0) -
          (before.mapDrivenSpliceFallback['synthetic-doc'] ?? 0),
      ).toBe(1);
      expect(after.mapDrivenSpliceApplied - before.mapDrivenSpliceApplied).toBe(0);

      cleanup();
    });

    test('an offset-less block drain increments fallback reason missing-position', () => {
      const raw = '<!-- note -->\n\nOriginal.\n';
      const { doc, xmlFragment, ytext } = createTestDoc();
      const cleanup = setupServerObservers({ doc, xmlFragment, ytext, mdManager, schema });
      doc.transact(() => {
        composeAndWriteRawBody(doc, raw, 'agent');
      }, AGENT_WRITE_ORIGIN);

      const before = getMetrics();
      populateFragment(doc, xmlFragment, '<!-- note -->\n\nOriginal.\n\nAdded.\n');
      const after = getMetrics();

      expect(
        (after.mapDrivenSpliceFallback['missing-position'] ?? 0) -
          (before.mapDrivenSpliceFallback['missing-position'] ?? 0),
      ).toBe(1);
      expect(after.mapDrivenSpliceApplied - before.mapDrivenSpliceApplied).toBe(0);

      cleanup();
    });

    test('a parse/serialize throw inside the splice reports parse-error instead of vanishing', () => {
      const throwingManager = {
        parseToMdast: () => {
          throw new Error('synthetic parser regression');
        },
        serialize: () => '',
      } as unknown as MarkdownManager;
      const reasons: string[] = [];

      const splice = computeMapDrivenBodySplice(
        'A.\n',
        mdManager.parse('A.\n'),
        throwingManager,
        (reason) => {
          reasons.push(reason);
        },
      );

      expect(splice).toBeNull();
      expect(reasons).toEqual(['parse-error']);
    });

    test('a sustained parse-error fallback warns once with the error message, then stays counter-only', () => {
      const raw = '# Heading\n\nFirst.\n\nSecond.\n';
      const { doc, xmlFragment, ytext } = createTestDoc();
      // Real manager except parseToMdast — only the splice computation uses
      // parseToMdast, so the drain itself (serialize + the incremental-diff
      // fallback) still completes while every splice attempt throws.
      const throwingManager = new Proxy(mdManager, {
        get(target, prop) {
          if (prop === 'parseToMdast') {
            return () => {
              throw new Error('synthetic parser regression');
            };
          }
          const value = Reflect.get(target, prop, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      __resetMapDrivenParseErrorWarnForTests();
      const warnSpy = spyOn(console, 'warn');
      const cleanup = setupServerObservers({
        doc,
        xmlFragment,
        ytext,
        mdManager: throwingManager,
        schema,
      });
      doc.transact(() => {
        composeAndWriteRawBody(doc, raw, 'agent');
      }, AGENT_WRITE_ORIGIN);

      const before = getMetrics();
      populateFragment(doc, xmlFragment, raw.replace('First.', 'First EDITED.'));
      populateFragment(doc, xmlFragment, raw.replace('First.', 'First EDITED TWICE.'));
      const after = getMetrics();

      // Both drains landed via the incremental-diff fallback and counted...
      expect(ytext.toString()).toContain('First EDITED TWICE.');
      expect(
        (after.mapDrivenSpliceFallback['parse-error'] ?? 0) -
          (before.mapDrivenSpliceFallback['parse-error'] ?? 0),
      ).toBeGreaterThanOrEqual(2);
      // ...but the breadcrumb fired exactly once, carrying the message.
      const spliceWarns = warnSpy.mock.calls.filter((args) =>
        String(args[0]).includes('Map-driven splice'),
      );
      expect(spliceWarns).toHaveLength(1);
      expect(spliceWarns[0]?.[1]).toBe('synthetic parser regression');

      warnSpy.mockRestore();
      cleanup();
    });

    test('an offset-less block reports missing-position through the pure computer', () => {
      const reasons: string[] = [];
      const splice = computeMapDrivenBodySplice(
        '<!-- note -->\n',
        mdManager.parse('<!-- note -->\n\nX.\n'),
        mdManager,
        (reason) => {
          reasons.push(reason);
        },
      );

      expect(splice).toBeNull();
      expect(reasons).toEqual(['missing-position']);
    });
  });
});

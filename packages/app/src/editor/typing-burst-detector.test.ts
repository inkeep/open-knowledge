/**
 * Tests for the typing burst detector substrate.
 *
 * The wire-site origin gate (drop programmatic / sync transactions) is
 * documented in the module docstring and exercised by the wire-site
 * tests in TiptapEditor.test.ts / SourceEditor.test.ts. This file pins
 * the substrate behavior: per-burst settle, debounce semantics, mark
 * + histogram emission, multiple-detector isolation.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { setTimeout as wait } from 'node:timers/promises';
import { getCollector, getHistogramSnapshot } from '../lib/perf/collector';
import { resetPerfOverrideWarnings } from '../lib/perf/env-override';
import { attachTypingBurstDetector } from './typing-burst-detector';

const hadWindow = typeof (globalThis as { window?: unknown }).window !== 'undefined';

beforeEach(() => {
  if (!hadWindow) (globalThis as unknown as { window: unknown }).window = globalThis;
  // Tight debounce for fast assertions.
  window.__okPerfOverrides = { BURST_DEBOUNCE_MS: 50 };
  resetPerfOverrideWarnings();
  getCollector()?.reset();
});

afterEach(() => {
  delete window.__okPerfOverrides;
  if (!hadWindow) delete (globalThis as { window?: unknown }).window;
});

describe('typing-burst-detector', () => {
  test('emits ok/typing/burst-settled exactly once after BURST_DEBOUNCE_MS of quiescence', async () => {
    const sampler = attachTypingBurstDetector({
      mode: 'WYSIWYG',
      docName: 'doc-burst',
      mountId: 'mid-1',
    });
    sampler.recordUserInput(2, 1);
    sampler.recordUserInput(3, 1);
    sampler.recordUserInput(4, 1);
    await wait(120);
    const settled = getCollector()
      ?.marks.toArray()
      .filter((m) => m.name === 'ok/typing/burst-settled' && m.properties?.docName === 'doc-burst');
    expect(settled?.length).toBe(1);
    const props = settled?.[0]?.properties;
    expect(props?.mode).toBe('WYSIWYG');
    expect(props?.mountId).toBe('mid-1');
    expect(props?.charsTyped).toBe(3);
    expect(props?.transactions).toBe(3);
    expect(typeof props?.burstDurationMs).toBe('number');
    // longestTaskMs / cumulativePmUpdateStateMs / cumulativeRenderMs were
    // trimmed from the payload — no current wire site supplies non-zero
    // durationMs (see recordUserInput JSDoc in typing-burst-detector.ts).
    // Pin the negation so a regression that re-adds them without wiring
    // a real timing source is loud here.
    expect(props?.longestTaskMs).toBeUndefined();
    expect(props?.cumulativePmUpdateStateMs).toBeUndefined();
    expect(props?.cumulativeRenderMs).toBeUndefined();
    sampler.detach();
  });

  test('emits the burst-total-ms histogram alongside the mark', async () => {
    const sampler = attachTypingBurstDetector({
      mode: 'WYSIWYG',
      docName: 'doc-h',
      mountId: 'mid-h',
    });
    sampler.recordUserInput(1, 1);
    await wait(120);
    const snap = getHistogramSnapshot('ok/typing/burst-total-ms');
    expect(snap?.count).toBe(1);
    sampler.detach();
  });

  test('consecutive bursts emit independent settle events with reset state', async () => {
    const sampler = attachTypingBurstDetector({
      mode: 'WYSIWYG',
      docName: 'doc-multi',
      mountId: 'mid-m',
    });
    sampler.recordUserInput(1, 1);
    sampler.recordUserInput(1, 1);
    await wait(120);
    sampler.recordUserInput(1, 1);
    sampler.recordUserInput(1, 1);
    sampler.recordUserInput(1, 1);
    await wait(120);
    const settled = getCollector()
      ?.marks.toArray()
      .filter((m) => m.name === 'ok/typing/burst-settled' && m.properties?.docName === 'doc-multi');
    expect(settled?.length).toBe(2);
    expect(settled?.[0]?.properties?.charsTyped).toBe(2);
    expect(settled?.[1]?.properties?.charsTyped).toBe(3);
    sampler.detach();
  });

  test('debounce window resets on each new input — no premature settle', async () => {
    const sampler = attachTypingBurstDetector({
      mode: 'Source',
      docName: 'doc-debounce',
      mountId: 'mid-d',
    });
    sampler.recordUserInput(1, 1);
    await wait(30); // less than BURST_DEBOUNCE_MS=50
    sampler.recordUserInput(1, 1);
    await wait(30);
    sampler.recordUserInput(1, 1);
    // Expected: only one final settle ~50ms after the last input.
    await wait(120);
    const settled = getCollector()
      ?.marks.toArray()
      .filter(
        (m) => m.name === 'ok/typing/burst-settled' && m.properties?.docName === 'doc-debounce',
      );
    expect(settled?.length).toBe(1);
    expect(settled?.[0]?.properties?.charsTyped).toBe(3);
    sampler.detach();
  });

  test('detach() flushes a pending settle synchronously (no debounce wait)', async () => {
    // Detach contract: if the user typed and then closed the doc / unmounted
    // the editor before the debounce timer fired, the in-flight burst is
    // flushed at detach time so short bursts stay visible in traces. A
    // detach that DROPPED accumulated burst data would silently lose data
    // for short typing sessions (the canonical "user typed a few chars and
    // navigated away" case).
    const sampler = attachTypingBurstDetector({
      mode: 'WYSIWYG',
      docName: 'doc-cancel',
      mountId: 'mid-c',
    });
    sampler.recordUserInput(1, 1);
    sampler.detach();
    // No `await wait(...)` — detach must flush synchronously.
    const settled = getCollector()
      ?.marks.toArray()
      .filter(
        (m) => m.name === 'ok/typing/burst-settled' && m.properties?.docName === 'doc-cancel',
      );
    expect(settled?.length).toBe(1);
    expect(settled?.[0]?.properties?.charsTyped).toBe(1);
  });

  test('detach() with no pending burst is a safe no-op (no settle mark emitted)', () => {
    const sampler = attachTypingBurstDetector({
      mode: 'WYSIWYG',
      docName: 'doc-empty-detach',
      mountId: 'mid-e',
    });
    sampler.detach();
    const settled = getCollector()
      ?.marks.toArray()
      .filter(
        (m) => m.name === 'ok/typing/burst-settled' && m.properties?.docName === 'doc-empty-detach',
      );
    expect(settled?.length ?? 0).toBe(0);
  });

  test('per-EditorView isolation — two detectors do not cross-contaminate', async () => {
    const a = attachTypingBurstDetector({
      mode: 'WYSIWYG',
      docName: 'doc-a',
      mountId: 'mid-a',
    });
    const b = attachTypingBurstDetector({
      mode: 'Source',
      docName: 'doc-b',
      mountId: 'mid-b',
    });
    a.recordUserInput(2, 1);
    b.recordUserInput(3, 5);
    await wait(120);
    const settled =
      getCollector()
        ?.marks.toArray()
        .filter((m) => m.name === 'ok/typing/burst-settled') ?? [];
    expect(settled.length).toBe(2);
    const aProps = settled.find((m) => m.properties?.docName === 'doc-a')?.properties;
    const bProps = settled.find((m) => m.properties?.docName === 'doc-b')?.properties;
    expect(aProps?.mountId).toBe('mid-a');
    expect(aProps?.charsTyped).toBe(1);
    expect(bProps?.mountId).toBe('mid-b');
    expect(bProps?.charsTyped).toBe(5);
    a.detach();
    b.detach();
  });

  test('charsDelta is summed by absolute value (deletes increment too)', async () => {
    const sampler = attachTypingBurstDetector({
      mode: 'WYSIWYG',
      docName: 'doc-abs',
      mountId: 'mid-abs',
    });
    sampler.recordUserInput(1, 5);
    sampler.recordUserInput(1, -3);
    await wait(120);
    const settled = getCollector()
      ?.marks.toArray()
      .find((m) => m.name === 'ok/typing/burst-settled' && m.properties?.docName === 'doc-abs');
    expect(settled?.properties?.charsTyped).toBe(8);
    sampler.detach();
  });

  test('does NOT emit when no chars were typed (transactions-only burst is a no-op)', async () => {
    const sampler = attachTypingBurstDetector({
      mode: 'WYSIWYG',
      docName: 'doc-no-chars',
      mountId: 'mid-n',
    });
    sampler.recordUserInput(1, 0);
    sampler.recordUserInput(1, 0);
    await wait(120);
    const settled = getCollector()
      ?.marks.toArray()
      .filter(
        (m) => m.name === 'ok/typing/burst-settled' && m.properties?.docName === 'doc-no-chars',
      );
    expect(settled?.length ?? 0).toBe(0);
    sampler.detach();
  });
});

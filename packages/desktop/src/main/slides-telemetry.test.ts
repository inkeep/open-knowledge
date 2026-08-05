/**
 * Main-side slides deck-open telemetry — assert `recordDeckOpen` maps an open
 * result to one bounded `ok.slides.deckOpen` span, that a failure additionally
 * increments the reason-labeled counter (so a spawn fault is separable from a
 * readiness timeout), and that the counter instrument is created lazily on first
 * failure — never at module load — and then reused.
 *
 * The desktop package has no `@opentelemetry/*` SDK dep and cannot mount an
 * `InMemorySpanExporter`, so we intercept at the `@inkeep/open-knowledge-server`
 * boundary with `vi.doMock` — the precedent set by
 * `git-preflight-handler-otel.test.ts`. `vi.resetModules()` per test gives each
 * a pristine module so the lazy counter cache never leaks across cases.
 */

import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { OkSlidesOpenResult } from '../shared/ipc-channels.ts';

const actual = await import('@inkeep/open-knowledge-server');

interface SpanCall {
  name: string;
  attributes: Record<string, unknown>;
}
interface CounterAdd {
  value: number;
  attributes: Record<string, unknown>;
}

const spanCalls: SpanCall[] = [];
const counterAdds: CounterAdd[] = [];
let getMeterCalls = 0;
let createCounterCalls = 0;

vi.doMock('@inkeep/open-knowledge-server', () => ({
  ...actual,
  withSpanSync: (
    name: string,
    options: { attributes?: Record<string, unknown> } | undefined,
    fn: (span: unknown) => unknown,
  ) => {
    spanCalls.push({ name, attributes: options?.attributes ?? {} });
    return fn({ setAttribute() {}, setAttributes() {}, end() {} });
  },
  getMeter: () => {
    getMeterCalls += 1;
    return {
      createCounter: () => {
        createCounterCalls += 1;
        return {
          add: (value: number, attributes: Record<string, unknown>) =>
            counterAdds.push({ value, attributes }),
        };
      },
    };
  },
}));

async function loadFresh() {
  // Fresh module instance so the module-level lazy counter cache starts null.
  return import('./slides-telemetry.ts');
}

beforeEach(() => {
  spanCalls.length = 0;
  counterAdds.length = 0;
  getMeterCalls = 0;
  createCounterCalls = 0;
  vi.resetModules();
});

describe('recordDeckOpen — span outcome', () => {
  test('a successful open emits one ok-outcome span and no counter', async () => {
    const { recordDeckOpen } = await loadFresh();
    recordDeckOpen({ kind: 'open', ok: true });
    expect(spanCalls).toEqual([
      { name: 'ok.slides.deckOpen', attributes: { 'ok.slides.outcome': 'ok' } },
    ]);
    expect(counterAdds).toEqual([]);
  });

  test('a timeout failure spans outcome=failure with the timeout reason', async () => {
    const { recordDeckOpen } = await loadFresh();
    recordDeckOpen({ kind: 'open', ok: false, reason: 'timeout' });
    expect(spanCalls).toEqual([
      {
        name: 'ok.slides.deckOpen',
        attributes: { 'ok.slides.outcome': 'failure', 'ok.slides.reason': 'timeout' },
      },
    ]);
  });
});

describe('recordDeckOpen — failure counter distinguishes reasons', () => {
  test('a spawn failure counts under spawn-error, not timeout', async () => {
    const { recordDeckOpen } = await loadFresh();
    recordDeckOpen({ kind: 'open', ok: false, reason: 'spawn-error' });
    expect(counterAdds).toEqual([{ value: 1, attributes: { 'ok.slides.reason': 'spawn-error' } }]);
  });

  test('a readiness timeout counts under timeout', async () => {
    const { recordDeckOpen } = await loadFresh();
    recordDeckOpen({ kind: 'open', ok: false, reason: 'timeout' });
    expect(counterAdds).toEqual([{ value: 1, attributes: { 'ok.slides.reason': 'timeout' } }]);
  });
});

describe('recordDeckOpen — lazily-cached instrument', () => {
  test('a successful open never touches the meter (no instrument at load)', async () => {
    const { recordDeckOpen } = await loadFresh();
    recordDeckOpen({ kind: 'open', ok: true });
    expect(getMeterCalls).toBe(0);
    expect(createCounterCalls).toBe(0);
  });

  test('the failure counter is created once and reused across failures', async () => {
    const { recordDeckOpen } = await loadFresh();
    const failures: OkSlidesOpenResult[] = [
      { kind: 'open', ok: false, reason: 'timeout' },
      { kind: 'open', ok: false, reason: 'exited-early' },
      { kind: 'open', ok: false, reason: 'unsupported-server' },
      { kind: 'open', ok: false, reason: 'spawn-error' },
    ];
    for (const f of failures) recordDeckOpen(f);
    expect(createCounterCalls).toBe(1);
    expect(counterAdds).toEqual([
      { value: 1, attributes: { 'ok.slides.reason': 'timeout' } },
      { value: 1, attributes: { 'ok.slides.reason': 'exited-early' } },
      { value: 1, attributes: { 'ok.slides.reason': 'unsupported-server' } },
      { value: 1, attributes: { 'ok.slides.reason': 'spawn-error' } },
    ]);
  });
});

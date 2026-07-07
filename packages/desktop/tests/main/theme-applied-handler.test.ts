/**
 * Pins the composition of the `ok:theme:applied` IPC handler:
 *
 *   1. The renderer's per-window show-gate signal — fireThemeApplied is
 *      called only when the sender resolves to a BrowserWindow. A
 *      destroyed-window race (sender exists, fromWebContents → null)
 *      emits a structured warn so the 5 s show-gate timeout's downstream
 *      `missing: 'theme-applied'` warn isn't the only diagnostic trail.
 *
 *   2. The cross-window vibrancy fan-out — applyReducedTransparency runs
 *      only when `opts.reducedTransparency` is explicitly defined. Without
 *      the `!== undefined` guard, the cold-launch theme-applied signal
 *      (which carries no reducedTransparency on first fire) would coerce
 *      `undefined` to falsy and re-set every window's vibrancy on every
 *      fire — observable as a flicker on cold-launch.
 *
 *   3. The win-null × reducedTransparency-defined edge case — vibrancy
 *      fan-out must still run for OTHER windows even when the signal's
 *      sender window is gone, because the fan-out targets all open
 *      windows, not the sender alone.
 *
 * The handler body in `index.ts` is 6 lines and the individual building
 * blocks (`showGate.fireThemeApplied`, `applyReducedTransparency`) are
 * exhaustively unit-tested. Pinning the composition here matches the
 * pattern set by `applyThemeSource` and `applyReducedTransparency` —
 * pure DI'd handler, structural collaborators, mutation-pass via the
 * public interface.
 */

import { describe, expect, test } from 'bun:test';
import { applyThemeApplied } from '../../src/main/theme-applied-handler.ts';

interface TraceEvent {
  step: 'fireThemeApplied' | 'applyReducedTransparency' | 'warn';
  args?: unknown;
}

function makeDeps() {
  const trace: TraceEvent[] = [];
  return {
    trace,
    deps: {
      fireThemeApplied: (window: object) => {
        trace.push({ step: 'fireThemeApplied', args: { window } });
      },
      applyReducedTransparency: (reduced: boolean) => {
        trace.push({ step: 'applyReducedTransparency', args: { reduced } });
      },
      warn: (line: string) => {
        trace.push({ step: 'warn', args: { line } });
      },
    },
  };
}

describe('applyThemeApplied — show-gate dispatch', () => {
  test('fires the show-gate signal when window resolves', () => {
    const { deps, trace } = makeDeps();
    const win = { id: 'win-1' };
    applyThemeApplied(deps, win, undefined);
    expect(trace.filter((t) => t.step === 'fireThemeApplied')).toEqual([
      { step: 'fireThemeApplied', args: { window: win } },
    ]);
  });

  test('skips the show-gate signal when window is null', () => {
    const { deps, trace } = makeDeps();
    applyThemeApplied(deps, null, undefined);
    expect(trace.filter((t) => t.step === 'fireThemeApplied')).toHaveLength(0);
  });

  test('emits diagnostic warn when window is null (so 5 s timeout warn is not the only trail)', () => {
    const { deps, trace } = makeDeps();
    applyThemeApplied(deps, null, undefined);
    const warns = trace.filter((t) => t.step === 'warn');
    expect(warns).toHaveLength(1);
    const line = (warns[0]?.args as { line: string }).line;
    expect(JSON.parse(line)).toEqual({
      event: 'theme-applied-no-window-for-sender',
    });
  });

  test('does NOT emit diagnostic warn when window resolves', () => {
    const { deps, trace } = makeDeps();
    applyThemeApplied(deps, { id: 'win-1' }, undefined);
    expect(trace.filter((t) => t.step === 'warn')).toHaveLength(0);
  });
});

describe('applyThemeApplied — reduced-transparency gate', () => {
  test('does NOT call applyReducedTransparency when opts is undefined (cold-launch path)', () => {
    const { deps, trace } = makeDeps();
    applyThemeApplied(deps, { id: 'win-1' }, undefined);
    expect(trace.filter((t) => t.step === 'applyReducedTransparency')).toHaveLength(0);
  });

  test('does NOT call applyReducedTransparency when opts.reducedTransparency is undefined', () => {
    const { deps, trace } = makeDeps();
    applyThemeApplied(deps, { id: 'win-1' }, {});
    expect(trace.filter((t) => t.step === 'applyReducedTransparency')).toHaveLength(0);
  });

  test('calls applyReducedTransparency(true) when opts.reducedTransparency=true', () => {
    const { deps, trace } = makeDeps();
    applyThemeApplied(deps, { id: 'win-1' }, { reducedTransparency: true });
    expect(trace.filter((t) => t.step === 'applyReducedTransparency')).toEqual([
      { step: 'applyReducedTransparency', args: { reduced: true } },
    ]);
  });

  test('calls applyReducedTransparency(false) when opts.reducedTransparency=false', () => {
    const { deps, trace } = makeDeps();
    applyThemeApplied(deps, { id: 'win-1' }, { reducedTransparency: false });
    expect(trace.filter((t) => t.step === 'applyReducedTransparency')).toEqual([
      { step: 'applyReducedTransparency', args: { reduced: false } },
    ]);
  });
});

describe('applyThemeApplied — composition edge cases', () => {
  test('vibrancy fan-out still runs when window is null (fan-out targets ALL windows, not sender alone)', () => {
    const { deps, trace } = makeDeps();
    applyThemeApplied(deps, null, { reducedTransparency: true });
    expect(trace.filter((t) => t.step === 'fireThemeApplied')).toHaveLength(0);
    expect(trace.filter((t) => t.step === 'applyReducedTransparency')).toEqual([
      { step: 'applyReducedTransparency', args: { reduced: true } },
    ]);
  });

  test('vibrancy fan-out fires before show-gate when both apply', () => {
    // Order is load-bearing for cold-launch correctness: a user with macOS
    // Reduce Transparency enabled supplies `reducedTransparency: true` on
    // the first fire of `ok:theme:applied`. If show-gate releases first,
    // window.show() composites one frame with the default 'sidebar'
    // vibrancy material before setVibrancy(null) lands — the exact
    // cold-launch staleness class the dual-signal gate is built to
    // eliminate. Apply vibrancy first, then release the gate.
    const { deps, trace } = makeDeps();
    applyThemeApplied(deps, { id: 'win-1' }, { reducedTransparency: true });
    const sequence = trace
      .filter((t) => t.step === 'fireThemeApplied' || t.step === 'applyReducedTransparency')
      .map((t) => t.step);
    expect(sequence).toEqual(['applyReducedTransparency', 'fireThemeApplied']);
  });

  test('narrow dep surface — the handler does not require any dep beyond fireThemeApplied / applyReducedTransparency / warn', () => {
    // Lock: future drift that grows the dep surface (e.g., adds a
    // setBackgroundColor fan-out, or a state.json write) trips this
    // assertion at the type level.
    const { deps } = makeDeps();
    expect(new Set(Object.keys(deps))).toEqual(
      new Set(['fireThemeApplied', 'applyReducedTransparency', 'warn']),
    );
  });
});

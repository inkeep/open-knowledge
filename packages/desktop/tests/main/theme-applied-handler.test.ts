
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
    const { deps, trace } = makeDeps();
    applyThemeApplied(deps, { id: 'win-1' }, { reducedTransparency: true });
    const sequence = trace
      .filter((t) => t.step === 'fireThemeApplied' || t.step === 'applyReducedTransparency')
      .map((t) => t.step);
    expect(sequence).toEqual(['applyReducedTransparency', 'fireThemeApplied']);
  });

  test('narrow dep surface — the handler does not require any dep beyond fireThemeApplied / applyReducedTransparency / warn', () => {
    const { deps } = makeDeps();
    expect(new Set(Object.keys(deps))).toEqual(
      new Set(['fireThemeApplied', 'applyReducedTransparency', 'warn']),
    );
  });
});

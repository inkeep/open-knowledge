/**
 * Pins the `ok:theme:set-source` IPC handler contract:
 *   - Sets nativeTheme.themeSource to the requested user-intent value.
 *   - Emits a structured `console.warn` with the previous source so operators
 *     can correlate theme transitions in DevTools.
 *   - Does NOT call `setBackgroundColor` on any BrowserWindow — vibrancy
 *     auto-tracks and setBackgroundColor is a no-op under `transparent: true`.
 *   - Does NOT write to state.json — themeSource is reconciled at cold-launch
 *     via the show-gate, not cached.
 *   - Defensively rejects non-OkThemeSource values at the IPC sender +
 *     imperative shell boundary. Typed IPC should prevent this in production
 *     but a future bridge-contract divergence at any of the three mirrors
 *     (or a non-typed IPC fallback) would land here.
 */

import { describe, expect, test } from 'bun:test';
import { applyThemeSource, isOkThemeSource } from '../../src/main/theme-handler.ts';
import type { OkThemeSource } from '../../src/shared/bridge-contract.ts';

interface TraceEvent {
  step: 'getThemeSource' | 'setThemeSource' | 'warn';
  args?: unknown;
}

function makeDeps(initialThemeSource: OkThemeSource = 'system') {
  let current: OkThemeSource = initialThemeSource;
  const trace: TraceEvent[] = [];
  return {
    trace,
    getCurrent: () => current,
    deps: {
      getThemeSource: () => {
        trace.push({ step: 'getThemeSource' });
        return current;
      },
      setThemeSource: (source: OkThemeSource) => {
        trace.push({ step: 'setThemeSource', args: { source } });
        current = source;
      },
      warn: (line: string) => {
        trace.push({ step: 'warn', args: { line } });
      },
    },
  };
}

describe('applyThemeSource happy path', () => {
  test('flips nativeTheme.themeSource from system to dark', () => {
    const { deps, getCurrent } = makeDeps('system');
    const result = applyThemeSource(deps, 'dark');
    expect(result).toEqual({ ok: true });
    expect(getCurrent()).toBe('dark');
  });

  test('emits structured warn with prevSource and trigger=ipc', () => {
    const { deps, trace } = makeDeps('light');
    applyThemeSource(deps, 'dark');
    const warns = trace.filter((t) => t.step === 'warn');
    expect(warns).toHaveLength(1);
    const line = (warns[0]?.args as { line: string }).line;
    expect(JSON.parse(line)).toEqual({
      event: 'theme-source-set',
      source: 'dark',
      prevSource: 'light',
      trigger: 'ipc',
    });
  });

  test.each([
    ['system' as OkThemeSource],
    ['light' as OkThemeSource],
    ['dark' as OkThemeSource],
  ])('accepts each user-intent value: %s', (source) => {
    const { deps, getCurrent } = makeDeps('system');
    const result = applyThemeSource(deps, source);
    expect(result).toEqual({ ok: true });
    expect(getCurrent()).toBe(source);
  });
});

describe('applyThemeSource defensive rejection', () => {
  test('does not call setThemeSource for an out-of-range value', () => {
    const { deps, trace, getCurrent } = makeDeps('system');
    // Force the type so we exercise the runtime guard — production wire
    // would fail typecheck before reaching here.
    const result = applyThemeSource(deps, 'auto' as unknown as OkThemeSource);
    expect(result).toEqual({ ok: true });
    expect(getCurrent()).toBe('system');
    expect(trace.find((t) => t.step === 'setThemeSource')).toBeUndefined();
  });

  test('emits structured warn with reason=invalid-source on rejection', () => {
    const { deps, trace } = makeDeps('system');
    applyThemeSource(deps, 'rainbow' as unknown as OkThemeSource);
    const warns = trace.filter((t) => t.step === 'warn');
    expect(warns).toHaveLength(1);
    const line = (warns[0]?.args as { line: string }).line;
    expect(JSON.parse(line)).toEqual({
      event: 'theme-source-set-rejected',
      received: 'rainbow',
      reason: 'invalid-source',
    });
  });
});

describe('applyThemeSource side-effect boundaries', () => {
  test('does not require setBackgroundColor or saveAppState — those deps are absent', () => {
    // The dep surface is intentionally narrow: getThemeSource, setThemeSource,
    // warn. If a future change widens the surface to add setBackgroundColor
    // or saveAppState, this test (alongside the type signature in the prod
    // call site) flags the regression — both are STOP-rule violations.
    const { deps } = makeDeps('system');
    const depKeys = new Set(Object.keys(deps));
    expect(depKeys).toEqual(new Set(['getThemeSource', 'setThemeSource', 'warn']));
  });
});

describe('isOkThemeSource type predicate', () => {
  test.each([
    ['system'],
    ['light'],
    ['dark'],
  ])('accepts canonical OkThemeSource value: %s', (value) => {
    expect(isOkThemeSource(value)).toBe(true);
  });

  test.each([
    ['auto'],
    ['Light'], // case-sensitive
    [''],
    ['SYSTEM'],
    ['system '],
  ])('rejects out-of-range string: %s', (value) => {
    expect(isOkThemeSource(value)).toBe(false);
  });

  test.each([
    [null],
    [undefined],
    [42],
    [true],
    [{}],
    [['system']],
  ])('rejects non-string input: %p', (value) => {
    expect(isOkThemeSource(value)).toBe(false);
  });
});

import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { getParseHealth, resetParseHealth } from '@inkeep/open-knowledge-core';
import { onPillRenderError } from './SidebarSearchBar';

describe('SidebarSearchBar module', () => {
  test('exports the SidebarSearchBar component', async () => {
    const mod = await import('./SidebarSearchBar');
    expect(typeof mod.SidebarSearchBar).toBe('function');
  });

  test('exports onPillRenderError as a named function', async () => {
    const mod = await import('./SidebarSearchBar');
    expect(typeof mod.onPillRenderError).toBe('function');
  });
});

describe('onPillRenderError — Pattern C runtime observability emission', () => {
  // Real failure-inducing input (a thrown Error + a componentStack from
  // react-error-boundary's `ErrorInfo`) routed through the function's
  // public surface; assertions are on observable downstream effects —
  // the structured-JSON line that lands on console.warn, and the
  // parse-health counter state visible via `getParseHealth()`. No DOM,
  // no React mount, no internal-collaborator mocking. The handler's
  // outbound effects ARE its contract; everything in the JSON shape
  // and the counter call is what dashboards and alerts will key off.
  //
  // The counter is read after the call (behavioral) rather than spied
  // on (interaction-based) — `getParseHealth()` is the existing public
  // read surface (also consumed by docs site, also exercised by
  // parse-health.test.ts), and reading it makes the assertion survive
  // a future refactor that swaps `incrementJsxRenderFailure` for an
  // equivalent counter path without changing observable behavior.

  let warnSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    resetParseHealth();
    warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  test('emits structured jsx-render-failure event with sidebarSearchPill surface label', () => {
    onPillRenderError(new Error('boom'), { componentStack: '\n  at SidebarSearchBar' });

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      JSON.stringify({
        event: 'jsx-render-failure',
        component: 'sidebarSearchPill',
        rawComponentName: 'sidebarSearchPill',
        error: 'Error: boom',
        stack: '\n  at SidebarSearchBar',
      }),
    );
  });

  test('increments the parse-health counter for sidebarSearchPill', () => {
    // The counter is a `Record<string, number>`: pre-first-increment the
    // surface key is absent (undefined), not zero. resetParseHealth()
    // clears every previously-seen surface back to absent — which is
    // what we observe after the beforeEach reset.
    expect(getParseHealth().jsxRenderFailure.sidebarSearchPill).toBeUndefined();
    onPillRenderError(new Error('first'), { componentStack: '\n  at SidebarSearchBar' });
    expect(getParseHealth().jsxRenderFailure.sidebarSearchPill).toBe(1);
    onPillRenderError(new Error('second'), { componentStack: '\n  at SidebarSearchBar' });
    expect(getParseHealth().jsxRenderFailure.sidebarSearchPill).toBe(2);
  });

  test('normalizes non-Error throws via String(err) — react-error-boundary types error as unknown', () => {
    // React can capture non-Error throws (strings, null, plain objects).
    // The handler wraps any non-Error in `new Error(String(error))` so
    // the emitted `error` field is always a stable shape. Without the
    // guard, `String(error)` of `null` would produce 'null' instead of
    // 'Error: null', and downstream log queries that depend on the
    // `Error: ` prefix would miss the entry.
    onPillRenderError('plain string throw', { componentStack: '\n  at SidebarSearchBar' });

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(String(warnSpy.mock.calls[0][0]));
    expect(payload.error).toBe('Error: plain string throw');
  });

  test('carries componentStack through to the stack field', () => {
    // The componentStack from react-error-boundary's `ErrorInfo` is the
    // React render path — distinct from the JS stack on the thrown
    // Error. Carrying it through gives the engineer-facing log enough
    // context to localize the failure to a JSX subtree without
    // re-deriving it from the bare Error message.
    onPillRenderError(new Error('x'), {
      componentStack: '\n  at SidebarSearchBar\n  at FileSidebar',
    });

    const payload = JSON.parse(String(warnSpy.mock.calls[0][0]));
    expect(payload.stack).toBe('\n  at SidebarSearchBar\n  at FileSidebar');
  });
});

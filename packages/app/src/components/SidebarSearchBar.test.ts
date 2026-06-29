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
    expect(getParseHealth().jsxRenderFailure.sidebarSearchPill).toBeUndefined();
    onPillRenderError(new Error('first'), { componentStack: '\n  at SidebarSearchBar' });
    expect(getParseHealth().jsxRenderFailure.sidebarSearchPill).toBe(1);
    onPillRenderError(new Error('second'), { componentStack: '\n  at SidebarSearchBar' });
    expect(getParseHealth().jsxRenderFailure.sidebarSearchPill).toBe(2);
  });

  test('normalizes non-Error throws via String(err) — react-error-boundary types error as unknown', () => {
    onPillRenderError('plain string throw', { componentStack: '\n  at SidebarSearchBar' });

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(String(warnSpy.mock.calls[0][0]));
    expect(payload.error).toBe('Error: plain string throw');
  });

  test('carries componentStack through to the stack field', () => {
    onPillRenderError(new Error('x'), {
      componentStack: '\n  at SidebarSearchBar\n  at FileSidebar',
    });

    const payload = JSON.parse(String(warnSpy.mock.calls[0][0]));
    expect(payload.stack).toBe('\n  at SidebarSearchBar\n  at FileSidebar');
  });
});

import { getParseHealth, resetParseHealth } from '@inkeep/open-knowledge-core';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { onPillRenderError } from './HeaderSearchBar';

describe('HeaderSearchBar module', () => {
  test('exports the HeaderSearchBar component', async () => {
    const mod = await import('./HeaderSearchBar');
    expect(typeof mod.HeaderSearchBar).toBe('function');
  });

  test('exports onPillRenderError as a named function', async () => {
    const mod = await import('./HeaderSearchBar');
    expect(typeof mod.onPillRenderError).toBe('function');
  });
});

describe('onPillRenderError — Pattern C runtime observability emission', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    resetParseHealth();
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  test('emits structured jsx-render-failure event with headerSearchPill surface label', () => {
    onPillRenderError(new Error('boom'), { componentStack: '\n  at HeaderSearchBar' });

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      JSON.stringify({
        event: 'jsx-render-failure',
        component: 'headerSearchPill',
        rawComponentName: 'headerSearchPill',
        error: 'Error: boom',
        stack: '\n  at HeaderSearchBar',
      }),
    );
  });

  test('increments the parse-health counter for headerSearchPill', () => {
    expect(getParseHealth().jsxRenderFailure.headerSearchPill).toBeUndefined();
    onPillRenderError(new Error('first'), { componentStack: '\n  at HeaderSearchBar' });
    expect(getParseHealth().jsxRenderFailure.headerSearchPill).toBe(1);
    onPillRenderError(new Error('second'), { componentStack: '\n  at HeaderSearchBar' });
    expect(getParseHealth().jsxRenderFailure.headerSearchPill).toBe(2);
  });

  test('normalizes non-Error throws via String(err) — react-error-boundary types error as unknown', () => {
    onPillRenderError('plain string throw', { componentStack: '\n  at HeaderSearchBar' });

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(String(warnSpy.mock.calls[0][0]));
    expect(payload.error).toBe('Error: plain string throw');
  });

  test('carries componentStack through to the stack field', () => {
    onPillRenderError(new Error('x'), {
      componentStack: '\n  at HeaderSearchBar\n  at FileSidebar',
    });

    const payload = JSON.parse(String(warnSpy.mock.calls[0][0]));
    expect(payload.stack).toBe('\n  at HeaderSearchBar\n  at FileSidebar');
  });
});

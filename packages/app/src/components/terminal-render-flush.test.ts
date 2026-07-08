import { describe, expect, mock, test } from 'bun:test';
import { createSameFrameRepaint, type RepaintableTerminal } from './terminal-render-flush';

function makeTerm(withDebouncer: boolean) {
  const refresh = mock((_start: number, _end: number) => {});
  const innerRefresh = mock(() => {});
  const term = {
    rows: 24,
    refresh,
    ...(withDebouncer
      ? { _core: { _renderService: { _renderDebouncer: { _innerRefresh: innerRefresh } } } }
      : {}),
  } as unknown as RepaintableTerminal;
  return { term, refresh, innerRefresh };
}

describe('createSameFrameRepaint', () => {
  test('queues a full-viewport refresh then flushes the render debouncer synchronously', () => {
    const { term, refresh, innerRefresh } = makeTerm(true);
    const warn = mock((_m: string) => {});
    const repaint = createSameFrameRepaint(term, warn);
    repaint();
    expect(refresh).toHaveBeenCalledWith(0, 23);
    expect(innerRefresh).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  });

  test('warns once (not per call) when an xterm bump moves the debouncer internal', () => {
    const { term, refresh } = makeTerm(false);
    const warn = mock((_m: string) => {});
    const repaint = createSameFrameRepaint(term, warn);
    repaint();
    repaint();
    repaint();
    // Degrades to xterm's own next-frame repaint: the public refresh still
    // queues the range, only the same-frame flush is unavailable.
    expect(refresh).toHaveBeenCalledTimes(3);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain('render-debouncer internal not found');
  });
});

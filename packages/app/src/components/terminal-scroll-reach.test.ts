import { describe, expect, test } from 'vitest';
import {
  applyModelledScroll,
  createScrollModelState,
  instrumentSmoothScrollOption,
  settleModelledScroll,
} from './terminal-scroll-model.test-helper';
import { restoreScrollReach, type ScrollReachTarget } from './terminal-scroll-reach';

function makeTerminal({
  viewportY,
  baseY,
  smoothScrollDuration = 125,
  desyncedScrollbarLine,
}: {
  viewportY: number;
  baseY: number;
  smoothScrollDuration?: number;
  desyncedScrollbarLine?: number;
}) {
  const state = createScrollModelState(viewportY, desyncedScrollbarLine ?? viewportY);
  const options = { smoothScrollDuration };
  const smoothScrollWrites = instrumentSmoothScrollOption(options);

  const term: ScrollReachTarget = {
    buffer: {
      active: {
        get viewportY() {
          return state.viewportY;
        },
        baseY,
      },
    },
    options,
    scrollToBottom() {
      applyModelledScroll(state, baseY, term.options.smoothScrollDuration);
    },
    scrollToLine(line: number) {
      applyModelledScroll(state, line, term.options.smoothScrollDuration);
    },
  };

  return {
    term,
    settle: () => settleModelledScroll(state),
    get viewportY() {
      return state.viewportY;
    },
    get scrollbarLine() {
      return state.scrollbarLine;
    },
    get pending() {
      return state.pendingTarget;
    },
    optionWrites: smoothScrollWrites,
  };
}

describe('restoreScrollReach', () => {
  test('a viewport sitting at the bottom is left alone', () => {
    const t = makeTerminal({ viewportY: 400, baseY: 400, desyncedScrollbarLine: 12 });
    restoreScrollReach(t.term);
    t.settle();
    expect(t.viewportY).toBe(400);
    expect(t.scrollbarLine).toBe(12);
    expect(t.optionWrites()).toBe(0);
  });

  test('a buffer with no scrollback yet is left alone', () => {
    const t = makeTerminal({ viewportY: 0, baseY: 0 });
    restoreScrollReach(t.term);
    t.settle();
    expect(t.viewportY).toBe(0);
  });

  test('a scrolled-back viewport keeps its line and gets its scrollbar back', () => {
    const t = makeTerminal({ viewportY: 34, baseY: 108, desyncedScrollbarLine: 0 });
    restoreScrollReach(t.term);
    expect(t.viewportY).toBe(34);
    expect(t.scrollbarLine).toBe(34);
    expect(t.pending).toBeNull();
    expect(t.optionWrites()).toBe(2);
    t.settle();
    expect(t.viewportY).toBe(34);
  });

  test('the smooth-scroll duration is put back afterwards', () => {
    const t = makeTerminal({ viewportY: 34, baseY: 108, smoothScrollDuration: 125 });
    restoreScrollReach(t.term);
    expect(t.term.options.smoothScrollDuration).toBe(125);
  });

  test('a terminal that never had smooth scrolling is left exactly as it was', () => {
    const t = makeTerminal({ viewportY: 34, baseY: 108, smoothScrollDuration: 0 });
    restoreScrollReach(t.term);
    expect(t.term.options.smoothScrollDuration).toBe(0);
    expect(t.viewportY).toBe(34);
  });
});

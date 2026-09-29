import { describe, expect, test } from 'vitest';
import { CLOSED_TAB_TOOLTIP, nextOpenTabTooltip } from './tab-tooltip-state';

describe('nextOpenTabTooltip', () => {
  test('opening a tab tooltip records the tab and when it opened', () => {
    expect(nextOpenTabTooltip(CLOSED_TAB_TOOLTIP, 'a', true, 10)).toEqual({
      id: 'a',
      openedAt: 10,
    });
  });

  test('opening another tab tooltip moves to that tab', () => {
    expect(nextOpenTabTooltip({ id: 'a', openedAt: 10 }, 'b', true, 20)).toEqual({
      id: 'b',
      openedAt: 20,
    });
  });

  test('closing the open tab tooltip clears it and keeps its opening time', () => {
    expect(nextOpenTabTooltip({ id: 'a', openedAt: 10 }, 'a', false, 30)).toEqual({
      id: null,
      openedAt: 10,
    });
  });

  test('a late close from another tab leaves the open tooltip alone', () => {
    const open = { id: 'b', openedAt: 20 };
    expect(nextOpenTabTooltip(open, 'a', false, 30)).toBe(open);
  });
});

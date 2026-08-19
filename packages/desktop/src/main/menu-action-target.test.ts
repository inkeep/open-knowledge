import { describe, expect, test, vi } from 'vitest';

import { resolveMenuActionTarget } from './menu-action-target';

describe('resolveMenuActionTarget', () => {
  test('renderer menu actions target the dispatching window before focus fallbacks', () => {
    const sender = {};
    const dispatchingWindow = { id: 2 };
    const focusedWindow = { id: 1 };
    const fromWebContents = vi.fn(() => dispatchingWindow);
    const getFocusedWindow = vi.fn((): { id: number } | null => focusedWindow);
    const getAllWindows = vi.fn(() => [focusedWindow]);

    expect(
      resolveMenuActionTarget(sender, { fromWebContents, getFocusedWindow, getAllWindows }),
    ).toBe(dispatchingWindow);
    expect(fromWebContents).toHaveBeenCalledWith(sender);
    expect(getFocusedWindow).not.toHaveBeenCalled();
    expect(getAllWindows).not.toHaveBeenCalled();
  });

  test('native menu actions retain focused-window then first-window fallback ordering', () => {
    const focusedWindow = { id: 1 };
    const fallbackWindow = { id: 2 };
    const deps = {
      fromWebContents: vi.fn(() => null),
      getFocusedWindow: vi.fn((): { id: number } | null => focusedWindow),
      getAllWindows: vi.fn(() => [fallbackWindow]),
    };

    expect(resolveMenuActionTarget(null, deps)).toBe(focusedWindow);
    expect(deps.fromWebContents).not.toHaveBeenCalled();
    expect(deps.getAllWindows).not.toHaveBeenCalled();

    deps.getFocusedWindow.mockReturnValueOnce(null);
    expect(resolveMenuActionTarget(null, deps)).toBe(fallbackWindow);
  });
});

import { describe, expect, test, vi } from 'vitest';

import {
  LAUNCHER_BORNE_ORIGIN,
  LAUNCHER_FREE_ORIGIN,
  MENU_DISPATCH_KINDS,
  originForMenuDispatch,
  resolveMenuActionTarget,
} from './menu-action-target';

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

describe('menu action origins', () => {
  test('the two origins carry the bit the capture path reads', () => {
    expect(LAUNCHER_FREE_ORIGIN).toEqual({ launcherBorne: false });
    expect(LAUNCHER_BORNE_ORIGIN).toEqual({ launcherBorne: true });
  });

  test('both are frozen, so one dispatch cannot poison every later one', () => {
    // Module-level singletons shared by every dispatch: a mutation here would
    // silently reclassify unrelated actions rather than fail near its cause.
    expect(Object.isFrozen(LAUNCHER_FREE_ORIGIN)).toBe(true);
    expect(Object.isFrozen(LAUNCHER_BORNE_ORIGIN)).toBe(true);
    expect(() => {
      (LAUNCHER_FREE_ORIGIN as { launcherBorne: boolean }).launcherBorne = true;
    }).toThrow();
    expect(LAUNCHER_FREE_ORIGIN.launcherBorne).toBe(false);
  });
});

describe('originForMenuDispatch', () => {
  test('only menu-action is launcher-borne', () => {
    // Pins the mapping against inversion. Exhaustiveness is NOT this test's job
    // and cannot be: a roster listed here would be a copy of the union, free to
    // drift from it. `ORIGIN_BY_DISPATCH_KIND`'s `satisfies` is what forces a new
    // kind to be classified, and it fails at typecheck rather than here.
    expect(originForMenuDispatch('menu-action')).toBe(LAUNCHER_BORNE_ORIGIN);
    for (const kind of MENU_DISPATCH_KINDS.filter((k) => k !== 'menu-action')) {
      expect(originForMenuDispatch(kind)).toBe(LAUNCHER_FREE_ORIGIN);
    }
  });
});

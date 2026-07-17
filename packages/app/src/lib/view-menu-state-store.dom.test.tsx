import { afterEach, describe, expect, test } from 'bun:test';
import { act, cleanup, renderHook } from '@testing-library/react';
import {
  __resetViewMenuStateForTests,
  setViewMenuState,
  useViewMenuState,
} from './view-menu-state-store';

describe('view-menu-state store', () => {
  afterEach(() => {
    cleanup();
    __resetViewMenuStateForTests();
  });

  test('partials from different producers merge instead of replacing the snapshot', () => {
    const { result } = renderHook(() => useViewMenuState());

    act(() => setViewMenuState({ docPanelVisible: true }));
    act(() => setViewMenuState({ terminalVisible: false }));

    expect(result.current).toEqual({ docPanelVisible: true, terminalVisible: false });
  });

  test('a later partial overwrites the same field', () => {
    const { result } = renderHook(() => useViewMenuState());

    act(() => setViewMenuState({ terminalVisible: false }));
    act(() => setViewMenuState({ terminalVisible: true }));

    expect(result.current.terminalVisible).toBe(true);
  });

  test('writes notify subscribers; the snapshot is referentially stable between writes', () => {
    const { result, rerender } = renderHook(() => useViewMenuState());

    act(() => setViewMenuState({ sidebarVisible: true }));
    const afterWrite = result.current;
    rerender();
    // No write between renders → same snapshot reference (useSyncExternalStore
    // relies on this to skip re-renders).
    expect(result.current).toBe(afterWrite);

    act(() => setViewMenuState({ sidebarVisible: false }));
    expect(result.current).not.toBe(afterWrite);
    expect(result.current.sidebarVisible).toBe(false);
  });

  test('the test-only reset returns the store to an empty snapshot', () => {
    act(() => setViewMenuState({ docPanelVisible: true }));
    __resetViewMenuStateForTests();

    const { result } = renderHook(() => useViewMenuState());
    expect(result.current).toEqual({});
  });
});

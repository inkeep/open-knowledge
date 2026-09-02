import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  __resetPropertiesCollapsedForTests,
  setPropertiesCollapsed,
  usePropertiesCollapsed,
} from './properties-collapsed-store';

describe('usePropertiesCollapsed (live shared state)', () => {
  beforeEach(() => {
    localStorage.clear();
    __resetPropertiesCollapsedForTests();
  });
  afterEach(() => {
    cleanup();
    localStorage.clear();
    __resetPropertiesCollapsedForTests();
  });

  it('seeds from the persisted preference at mount', () => {
    setPropertiesCollapsed(true);
    const { result } = renderHook(() => usePropertiesCollapsed());
    expect(result.current[0]).toBe(true);
  });

  it('updates live when another panel toggles the shared store', () => {
    const { result } = renderHook(() => usePropertiesCollapsed());
    expect(result.current[0]).toBe(false);

    act(() => setPropertiesCollapsed(true));
    expect(result.current[0]).toBe(true);
  });

  it('keeps two mounted panels in lockstep', () => {
    const a = renderHook(() => usePropertiesCollapsed());
    const b = renderHook(() => usePropertiesCollapsed());
    expect(a.result.current[0]).toBe(false);
    expect(b.result.current[0]).toBe(false);

    act(() => a.result.current[1](true));
    expect(a.result.current[0]).toBe(true);
    expect(b.result.current[0]).toBe(true);
  });

  it('persists the preference for future mounts', () => {
    const { result } = renderHook(() => usePropertiesCollapsed());
    act(() => result.current[1](true));
    expect(localStorage.getItem('ok-properties-collapsed-v1')).toBe('true');
  });
});

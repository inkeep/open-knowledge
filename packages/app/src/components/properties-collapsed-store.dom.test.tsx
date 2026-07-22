import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  __resetPropertiesCollapsedForTests,
  setPropertiesCollapsed,
  usePropertiesCollapsed,
} from './properties-collapsed-store';

/**
 * The hook is a LIVE view of the shared preference: every mounted panel reflects
 * a toggle from any panel in lockstep (that is the "same across all documents"
 * requirement). The scroll disruption this live resize would otherwise cause on
 * a hidden, scrolled doc is compensated in ScrollPreservingContainer (body-top
 * anchor restore), not by making the state non-live here.
 */
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
    setPropertiesCollapsed(true); // a prior session/panel persisted "collapsed"
    const { result } = renderHook(() => usePropertiesCollapsed());
    expect(result.current[0]).toBe(true);
  });

  it('updates live when another panel toggles the shared store', () => {
    const { result } = renderHook(() => usePropertiesCollapsed());
    expect(result.current[0]).toBe(false); // default open

    // Another panel (or this one's setter) flips the shared preference.
    act(() => setPropertiesCollapsed(true));
    expect(result.current[0]).toBe(true);
  });

  it('keeps two mounted panels in lockstep', () => {
    const a = renderHook(() => usePropertiesCollapsed());
    const b = renderHook(() => usePropertiesCollapsed());
    expect(a.result.current[0]).toBe(false);
    expect(b.result.current[0]).toBe(false);

    // Toggle via panel A's setter → panel B reflects it too.
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

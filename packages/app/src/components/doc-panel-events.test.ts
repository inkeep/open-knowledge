import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  consumePendingDocPanelRequest,
  consumePendingDocPanelTabRequest,
  requestDocPanelTab,
  subscribeToDocPanelTabRequests,
} from './doc-panel-events';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('doc-panel-events', () => {
  test('dispatches and subscribes tab requests through the shared event name', () => {
    const target = new EventTarget();
    const onRequest = vi.fn(() => {});

    const unsubscribe = subscribeToDocPanelTabRequests(onRequest, target);
    consumePendingDocPanelTabRequest();
    requestDocPanelTab('graph', {}, target);

    expect(onRequest).toHaveBeenCalledTimes(1);
    expect(onRequest).toHaveBeenCalledWith('graph', { scope: undefined, focus: undefined });
    expect(consumePendingDocPanelTabRequest()).toBe('graph');

    unsubscribe();
    requestDocPanelTab('outline', {}, target);
    expect(onRequest).toHaveBeenCalledTimes(1);
    expect(consumePendingDocPanelTabRequest()).toBe('outline');
  });

  test('carries a requested panel scope to subscribers, and omits it otherwise', () => {
    const target = new EventTarget();
    const onRequest = vi.fn(() => {});

    const unsubscribe = subscribeToDocPanelTabRequests(onRequest, target);
    requestDocPanelTab('problems', { scope: 'doc' }, target);
    expect(onRequest).toHaveBeenLastCalledWith('problems', {
      scope: 'doc',
      focus: undefined,
    });

    requestDocPanelTab('problems', {}, target);
    expect(onRequest).toHaveBeenLastCalledWith('problems', {
      scope: undefined,
      focus: undefined,
    });

    unsubscribe();
    consumePendingDocPanelTabRequest();
    consumePendingDocPanelRequest('problems');
  });

  test('latches request details for the panel that the request itself mounts', () => {
    const target = new EventTarget();
    requestDocPanelTab('problems', { scope: 'project', focus: 'panel' }, target);

    expect(consumePendingDocPanelRequest('problems')).toEqual({
      scope: 'project',
      focus: 'panel',
    });
    expect(consumePendingDocPanelRequest('problems')).toBeNull();
    consumePendingDocPanelTabRequest();
  });

  test('the latched scope is addressed to one tab and no other', () => {
    const target = new EventTarget();
    requestDocPanelTab('comments', { scope: 'project' }, target);

    expect(consumePendingDocPanelRequest('problems')).toBeNull();
    expect(consumePendingDocPanelRequest('comments')).toEqual({ scope: 'project' });
    consumePendingDocPanelTabRequest();
  });

  test('a tab-only request clears a scope an earlier request left latched', () => {
    const target = new EventTarget();
    requestDocPanelTab('problems', { scope: 'project' }, target);
    requestDocPanelTab('problems', {}, target);

    expect(consumePendingDocPanelRequest('problems')).toBeNull();
    consumePendingDocPanelTabRequest();
  });

  test('retires request details that no resulting panel consumes', async () => {
    const target = new EventTarget();
    requestDocPanelTab('problems', { scope: 'doc', focus: 'panel' }, target);

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(consumePendingDocPanelRequest('problems')).toBeNull();
    consumePendingDocPanelTabRequest();
  });

  test('keeps request details through the commit frame and expires them after the next frame', () => {
    const frames = new Map<number, FrameRequestCallback>();
    let nextFrameId = 0;
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((callback: FrameRequestCallback) => {
        nextFrameId += 1;
        frames.set(nextFrameId, callback);
        return nextFrameId;
      }),
    );
    vi.stubGlobal(
      'cancelAnimationFrame',
      vi.fn((frameId: number) => frames.delete(frameId)),
    );

    const target = new EventTarget();
    requestDocPanelTab('problems', { scope: 'doc', focus: 'panel' }, target);

    const commitFrame = frames.get(1);
    expect(commitFrame).toBeDefined();
    frames.delete(1);
    commitFrame?.(0);

    expect(consumePendingDocPanelRequest('problems')).toEqual({
      scope: 'doc',
      focus: 'panel',
    });

    requestDocPanelTab('problems', { scope: 'doc', focus: 'panel' }, target);
    const nextCommitFrame = frames.get(3);
    expect(nextCommitFrame).toBeDefined();
    frames.delete(3);
    nextCommitFrame?.(16);

    const expiryFrame = frames.get(4);
    expect(expiryFrame).toBeDefined();
    frames.delete(4);
    expiryFrame?.(32);

    expect(consumePendingDocPanelRequest('problems')).toBeNull();
    consumePendingDocPanelTabRequest();
  });

  test('expires request details on a wall-clock backstop when frames are suspended', () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn(() => 1),
    );
    vi.stubGlobal('cancelAnimationFrame', vi.fn());

    requestDocPanelTab('problems', { scope: 'doc', focus: 'panel' }, new EventTarget());
    vi.advanceTimersByTime(250);

    expect(consumePendingDocPanelRequest('problems')).toBeNull();
    consumePendingDocPanelTabRequest();
  });
});

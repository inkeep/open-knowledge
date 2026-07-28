import { describe, expect, test, vi } from 'vitest';
import {
  consumePendingDocPanelTabRequest,
  requestDocPanelTab,
  subscribeToDocPanelTabRequests,
} from './doc-panel-events';

describe('doc-panel-events', () => {
  test('dispatches and subscribes tab requests through the shared event name', () => {
    const target = new EventTarget();
    const onRequest = vi.fn(() => {});

    const unsubscribe = subscribeToDocPanelTabRequests(onRequest, target);
    consumePendingDocPanelTabRequest();
    requestDocPanelTab('graph', target);

    expect(onRequest).toHaveBeenCalledTimes(1);
    expect(onRequest).toHaveBeenCalledWith('graph');
    expect(consumePendingDocPanelTabRequest()).toBe('graph');

    unsubscribe();
    requestDocPanelTab('outline', target);
    expect(onRequest).toHaveBeenCalledTimes(1);
    expect(consumePendingDocPanelTabRequest()).toBe('outline');
  });
});

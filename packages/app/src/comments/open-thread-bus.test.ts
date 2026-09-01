import { afterEach, describe, expect, test, vi } from 'vitest';
import { consumePendingDocPanelTabRequest } from '@/components/doc-panel-events';
import { emitOpenThread, subscribeOpenThread } from './store';

afterEach(() => {
  vi.restoreAllMocks();
  consumePendingDocPanelTabRequest();
});

function record(): { seen: (string | null)[]; stop: () => void } {
  const seen: (string | null)[] = [];
  const stop = subscribeOpenThread((id) => seen.push(id));
  return { seen, stop };
}

describe('the open-thread bus', () => {
  test('carries an id when a thread opens', () => {
    const bus = record();
    emitOpenThread('t1');
    expect(bus.seen).toEqual(['t1']);
    bus.stop();
  });

  test('carries null when it closes, so mirrors can clear', () => {
    const bus = record();
    emitOpenThread('t1');
    emitOpenThread(null);
    expect(bus.seen).toEqual(['t1', null]);
    bus.stop();
  });

  test('switching threads reports the new id, not a close first', () => {
    const bus = record();
    emitOpenThread('t1');
    emitOpenThread('t2');
    expect(bus.seen).toEqual(['t1', 't2']);
    bus.stop();
  });

  test('an unsubscribed listener stops hearing', () => {
    const bus = record();
    emitOpenThread('t1');
    bus.stop();
    emitOpenThread('t2');
    expect(bus.seen).toEqual(['t1']);
  });

  test('every listener sees the same signal', () => {
    const a = record();
    const b = record();
    emitOpenThread('t1');
    emitOpenThread(null);
    expect(a.seen).toEqual(b.seen);
    a.stop();
    b.stop();
  });
});

describe('opening a thread opens the Comments tab beside it', () => {
  test('an id requests the tab; a close leaves the panel alone', () => {
    consumePendingDocPanelTabRequest();
    emitOpenThread('t1');
    expect(consumePendingDocPanelTabRequest()).toBe('comments');

    emitOpenThread(null);
    expect(consumePendingDocPanelTabRequest()).toBeNull();
  });
});

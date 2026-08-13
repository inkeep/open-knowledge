/**
 * The open-popover signal is shared state, not a one-way "open" command.
 *
 * Two bugs came from it being one-way. The popover closed itself privately on
 * Escape / outside click / resolve, so the margin rail kept a marker lit for a
 * popover that no longer existed — and, not knowing what was open, the rail
 * could not make a marker toggle. Both need `null` to travel the same channel
 * as an id, which is what these pin.
 */

import { afterEach, describe, expect, test, vi } from 'vitest';
import { consumePendingDocPanelTabRequest } from '@/components/doc-panel-events';
import { emitOpenThreadPopover, subscribeOpenThreadPopover } from './store';

afterEach(() => {
  vi.restoreAllMocks();
  consumePendingDocPanelTabRequest();
});

/** Collect everything the bus publishes for the life of one subscription. */
function record(): { seen: (string | null)[]; stop: () => void } {
  const seen: (string | null)[] = [];
  const stop = subscribeOpenThreadPopover((id) => seen.push(id));
  return { seen, stop };
}

describe('the thread-popover bus', () => {
  test('carries an id when a thread opens', () => {
    const bus = record();
    emitOpenThreadPopover('t1');
    expect(bus.seen).toEqual(['t1']);
    bus.stop();
  });

  test('carries null when it closes, so mirrors can clear', () => {
    // The rail's lit marker depends on hearing this; before, a close was silent.
    const bus = record();
    emitOpenThreadPopover('t1');
    emitOpenThreadPopover(null);
    expect(bus.seen).toEqual(['t1', null]);
    bus.stop();
  });

  test('switching threads reports the new id, not a close first', () => {
    const bus = record();
    emitOpenThreadPopover('t1');
    emitOpenThreadPopover('t2');
    expect(bus.seen).toEqual(['t1', 't2']);
    bus.stop();
  });

  test('an unsubscribed listener stops hearing', () => {
    const bus = record();
    emitOpenThreadPopover('t1');
    bus.stop();
    emitOpenThreadPopover('t2');
    expect(bus.seen).toEqual(['t1']);
  });

  test('every listener sees the same signal', () => {
    // The popover and the rail both subscribe; they must not diverge.
    const a = record();
    const b = record();
    emitOpenThreadPopover('t1');
    emitOpenThreadPopover(null);
    expect(a.seen).toEqual(b.seen);
    a.stop();
    b.stop();
  });
});

describe('opening a thread opens the Comments tab beside it', () => {
  test('an id requests the tab; a close leaves the panel alone', () => {
    consumePendingDocPanelTabRequest();
    emitOpenThreadPopover('t1');
    // The pending-tab latch is how the panel host learns of the request even
    // when it has not mounted yet — the same channel every open path lands on.
    expect(consumePendingDocPanelTabRequest()).toBe('comments');

    emitOpenThreadPopover(null);
    // Dismissing a popover is not a statement about the panel.
    expect(consumePendingDocPanelTabRequest()).toBeNull();
  });
});

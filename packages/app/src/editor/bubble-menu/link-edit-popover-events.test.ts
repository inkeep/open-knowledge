/**
 * The open-link-popover pub/sub contract: emit reaches a live subscriber,
 * unsubscribe detaches it, and an injected EventTarget scopes the channel
 * (the SSR-safe default target path is exercised by the dom suite).
 */

import { expect, test } from 'bun:test';
import {
  emitOpenLinkEditPopover,
  subscribeToOpenLinkEditPopover,
} from './link-edit-popover-events';

test('emit reaches a subscriber on the shared target', () => {
  const target = new EventTarget();
  let calls = 0;
  const unsubscribe = subscribeToOpenLinkEditPopover(() => {
    calls++;
  }, target);
  try {
    emitOpenLinkEditPopover(target);
    emitOpenLinkEditPopover(target);
    expect(calls).toBe(2);
  } finally {
    unsubscribe();
  }
});

test('unsubscribe detaches the listener', () => {
  const target = new EventTarget();
  let calls = 0;
  const unsubscribe = subscribeToOpenLinkEditPopover(() => {
    calls++;
  }, target);
  emitOpenLinkEditPopover(target);
  unsubscribe();
  emitOpenLinkEditPopover(target);
  expect(calls).toBe(1);
});

test('subscribers on a different target never hear the emit', () => {
  const targetA = new EventTarget();
  const targetB = new EventTarget();
  let calls = 0;
  const unsubscribe = subscribeToOpenLinkEditPopover(() => {
    calls++;
  }, targetA);
  try {
    emitOpenLinkEditPopover(targetB);
    expect(calls).toBe(0);
  } finally {
    unsubscribe();
  }
});

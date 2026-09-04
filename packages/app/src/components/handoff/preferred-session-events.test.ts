import { describe, expect, test } from 'vitest';
import {
  requestPreferredSession,
  subscribeToPreferredSessionRequests,
} from './preferred-session-events';

describe('preferred-session-events', () => {
  test('delivers a request to the subscriber and stops after unsubscribe', () => {
    const target = new EventTarget();
    let received = 0;
    const unsub = subscribeToPreferredSessionRequests(() => {
      received += 1;
    }, target);

    requestPreferredSession(target);
    expect(received).toBe(1);

    requestPreferredSession(target);
    expect(received).toBe(2);

    unsub();
    requestPreferredSession(target);
    expect(received).toBe(2);
  });

  test('carries no payload, so callers cannot name an AI', () => {
    const target = new EventTarget();
    const args: unknown[][] = [];
    const unsub = subscribeToPreferredSessionRequests((...rest) => args.push(rest), target);

    requestPreferredSession(target);
    unsub();

    expect(args).toEqual([[]]);
  });
});

import { describe, expect, test } from 'vitest';
import {
  requestPreferredSession,
  subscribeToPreferredSessionRequests,
} from './preferred-session-events';

describe('preferred-session-events', () => {
  test('reports an unclaimed request when no session host is subscribed', () => {
    const target = new EventTarget();

    expect(requestPreferredSession(target)).toBe(false);
  });

  test('reports one matching host claim for a live request', () => {
    const target = new EventTarget();
    let launches = 0;
    const unsubscribe = subscribeToPreferredSessionRequests(() => {
      launches += 1;
    }, target);

    expect(requestPreferredSession(target)).toBe(true);
    expect(launches).toBe(1);
    unsubscribe();
  });

  test('a nonmatching host declines and only the first matching host launches', () => {
    const target = new EventTarget();
    const launches: string[] = [];
    const subscribe = (host: string, matches: boolean) =>
      Reflect.apply(subscribeToPreferredSessionRequests, undefined, [
        () => launches.push(host),
        target,
        () => matches,
      ]) as () => void;
    const stopWrong = subscribe('wrong', false);
    const stopMatching = subscribe('matching', true);
    const stopSecond = subscribe('second', true);

    const claimed = requestPreferredSession(target);

    expect(launches).toEqual(['matching']);
    expect(claimed).toBe(true);
    stopWrong();
    stopMatching();
    stopSecond();
  });

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

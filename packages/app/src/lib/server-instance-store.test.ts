import { afterEach, describe, expect, test } from 'vitest';
import {
  __resetServerInstanceStoreForTests,
  getServerInstanceId,
  setServerInstanceId,
  subscribeServerInstanceId,
} from './server-instance-store';

afterEach(() => {
  __resetServerInstanceStoreForTests();
});

describe('server-instance-store', () => {
  test('starts null and reflects the last set value', () => {
    expect(getServerInstanceId()).toBeNull();
    setServerInstanceId('instance-a');
    expect(getServerInstanceId()).toBe('instance-a');
  });

  test('empty string normalizes to null (absent-claim treatment)', () => {
    setServerInstanceId('instance-a');
    setServerInstanceId('');
    expect(getServerInstanceId()).toBeNull();
  });

  test('notifies subscribers only on change (idempotent setter)', () => {
    let calls = 0;
    const unsub = subscribeServerInstanceId(() => {
      calls += 1;
    });

    setServerInstanceId('instance-a');
    setServerInstanceId('instance-a'); // unchanged → no fire
    expect(calls).toBe(1);

    setServerInstanceId('instance-b'); // changed → fire
    expect(calls).toBe(2);

    unsub();
    setServerInstanceId('instance-c'); // no subscribers after unsub
    expect(calls).toBe(2);
    expect(getServerInstanceId()).toBe('instance-c');
  });

  test('a throwing subscriber does not block other subscribers', () => {
    let good = 0;
    subscribeServerInstanceId(() => {
      throw new Error('boom');
    });
    subscribeServerInstanceId(() => {
      good += 1;
    });
    setServerInstanceId('instance-a');
    expect(good).toBe(1);
  });
});

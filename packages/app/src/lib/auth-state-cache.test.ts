import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { getLastKnownSignedIn, setLastKnownSignedIn } from './auth-state-cache';

describe('auth-state-cache', () => {
  beforeEach(() => setLastKnownSignedIn(null));
  afterEach(() => setLastKnownSignedIn(null));

  test('reads back null when no status has resolved', () => {
    expect(getLastKnownSignedIn()).toBeNull();
  });

  test('round-trips the last resolved signed-in state', () => {
    setLastKnownSignedIn(true);
    expect(getLastKnownSignedIn()).toBe(true);

    setLastKnownSignedIn(false);
    expect(getLastKnownSignedIn()).toBe(false);
  });
});

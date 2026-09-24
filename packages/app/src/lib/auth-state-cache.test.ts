import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { getLastKnownSignedIn, recordAuthStatus, setLastKnownSignedIn } from './auth-state-cache';

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

  test('records a resolved status but ignores an origin refusal, which says nothing about sign-in', () => {
    recordAuthStatus({ authenticated: true });
    expect(getLastKnownSignedIn()).toBe(true);

    recordAuthStatus({ authenticated: false, unsupportedOrigin: { host: 'ghes.acme.test' } });
    expect(getLastKnownSignedIn()).toBe(true);

    recordAuthStatus({ authenticated: false });
    expect(getLastKnownSignedIn()).toBe(false);
  });
});

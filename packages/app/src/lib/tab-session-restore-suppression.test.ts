import { afterEach, describe, expect, test } from 'vitest';
import {
  consumeHashNavigationSuppression,
  recordAppShellCrashTrip,
  resetTabSessionRestoreSuppression,
  shouldSuppressTabSessionRestore,
} from './tab-session-restore-suppression';

describe('tab-session restore suppression', () => {
  afterEach(() => {
    resetTabSessionRestoreSuppression();
    consumeHashNavigationSuppression();
  });

  test('a single crash trip does not suppress restore', () => {
    recordAppShellCrashTrip(new Error('boom'));
    expect(shouldSuppressTabSessionRestore()).toBe(false);
  });

  test('a second trip on the same error suppresses restore', () => {
    recordAppShellCrashTrip(new Error('boom'));
    recordAppShellCrashTrip(new Error('boom'));
    expect(shouldSuppressTabSessionRestore()).toBe(true);
  });

  test('a different second error does not suppress restore', () => {
    recordAppShellCrashTrip(new Error('boom'));
    recordAppShellCrashTrip(new Error('an unrelated crash'));
    expect(shouldSuppressTabSessionRestore()).toBe(false);
  });

  test('a different crash disarms an already-armed suppression', () => {
    recordAppShellCrashTrip(new Error('boom'));
    recordAppShellCrashTrip(new Error('boom'));
    expect(shouldSuppressTabSessionRestore()).toBe(true);

    recordAppShellCrashTrip(new Error('an unrelated crash'));
    expect(shouldSuppressTabSessionRestore()).toBe(false);

    recordAppShellCrashTrip(new Error('an unrelated crash'));
    expect(shouldSuppressTabSessionRestore()).toBe(true);
  });

  test('reset lifts an armed suppression', () => {
    recordAppShellCrashTrip(new Error('boom'));
    recordAppShellCrashTrip(new Error('boom'));
    resetTabSessionRestoreSuppression();
    expect(shouldSuppressTabSessionRestore()).toBe(false);
  });

  test('after a reset the same error must trip twice again to suppress', () => {
    recordAppShellCrashTrip(new Error('boom'));
    recordAppShellCrashTrip(new Error('boom'));
    resetTabSessionRestoreSuppression();

    recordAppShellCrashTrip(new Error('boom'));
    expect(shouldSuppressTabSessionRestore()).toBe(false);
    recordAppShellCrashTrip(new Error('boom'));
    expect(shouldSuppressTabSessionRestore()).toBe(true);
  });

  test('a single trip does not arm hash-navigation suppression', () => {
    recordAppShellCrashTrip(new Error('boom'));

    expect(consumeHashNavigationSuppression()).toBe(false);
  });

  test('a repeat trip arms hash-navigation suppression alongside restore suppression', () => {
    recordAppShellCrashTrip(new Error('boom'));
    recordAppShellCrashTrip(new Error('boom'));

    expect(consumeHashNavigationSuppression()).toBe(true);
  });

  test('hash-navigation suppression is a one-shot consume', () => {
    recordAppShellCrashTrip(new Error('boom'));
    recordAppShellCrashTrip(new Error('boom'));
    expect(consumeHashNavigationSuppression()).toBe(true);
    expect(consumeHashNavigationSuppression()).toBe(false);
  });

  test('consuming hash-navigation suppression leaves restore suppression armed', () => {
    recordAppShellCrashTrip(new Error('boom'));
    recordAppShellCrashTrip(new Error('boom'));
    consumeHashNavigationSuppression();
    expect(shouldSuppressTabSessionRestore()).toBe(true);
  });

  test('the restore reset leaves an armed hash-navigation suppression consumable', () => {
    recordAppShellCrashTrip(new Error('boom'));
    recordAppShellCrashTrip(new Error('boom'));
    resetTabSessionRestoreSuppression();
    expect(consumeHashNavigationSuppression()).toBe(true);
  });

  test('a different crash disarms hash-navigation suppression with the restore latch', () => {
    recordAppShellCrashTrip(new Error('boom'));
    recordAppShellCrashTrip(new Error('boom'));
    recordAppShellCrashTrip(new Error('an unrelated crash'));
    expect(consumeHashNavigationSuppression()).toBe(false);
  });
});

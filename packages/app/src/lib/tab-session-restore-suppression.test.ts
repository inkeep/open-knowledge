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
    // Arm on a repeat of the same error, then take one trip of a DIFFERENT
    // error. A new, single crash is not a repeat, so the latch must disarm —
    // otherwise a lone unrelated crash inherits the armed flag and drops the
    // next mount's tab restore on the strength of a single occurrence.
    recordAppShellCrashTrip(new Error('boom'));
    recordAppShellCrashTrip(new Error('boom'));
    expect(shouldSuppressTabSessionRestore()).toBe(true);

    recordAppShellCrashTrip(new Error('an unrelated crash'));
    expect(shouldSuppressTabSessionRestore()).toBe(false);

    // And the unrelated error now starts its own fresh count: it must trip
    // twice on its own to arm, exactly as the first error did.
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
    // Exactly two same-key trips. Split from the single-trip case above so the
    // arming threshold is asserted rather than implied: a change that required
    // three trips would still pass a test that made three.
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
    // The restore path resets its latch the moment it honors a suppression,
    // which can be before OR after the navigation handler's mount effect runs.
    // If the reset also cleared the navigation latch, an early restore reset
    // would leave the stale hash live and the crashing document would reopen
    // through it.
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

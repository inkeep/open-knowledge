import { describe, expect, test } from 'bun:test';
import {
  type DriverUtilityLike,
  isDriverBootSmokeMode,
  runDriverBootSmoke,
} from './driver-boot-smoke.ts';

type ExitHandler = () => void;

function makeFakeUtility() {
  const handlers: ExitHandler[] = [];
  const util: DriverUtilityLike = {
    on(event, listener) {
      if (event === 'exit') handlers.push(listener);
    },
  };
  return {
    util,
    emitExit: () => {
      for (const h of handlers) h();
    },
  };
}

describe('runDriverBootSmoke (US-006 AC8 regression)', () => {
  test('forks the utility at the supplied entry path', () => {
    let forkedEntry: string | null = null;
    const fake = makeFakeUtility();
    runDriverBootSmoke({
      fork: (entry) => {
        forkedEntry = entry;
        return fake.util;
      },
      quit: () => {},
      setTimeout: () => {},
      utilityEntryPath: '/some/path/utility/server-entry.js',
    });
    expect(forkedEntry).toBe('/some/path/utility/server-entry.js');
  });

  test('quits the app when the utility exits cleanly (normal driver flow)', () => {
    let quitCount = 0;
    const fake = makeFakeUtility();
    runDriverBootSmoke({
      fork: () => fake.util,
      quit: () => {
        quitCount += 1;
      },
      setTimeout: () => {},
      utilityEntryPath: '/ignored.js',
    });
    expect(quitCount).toBe(0);
    fake.emitExit();
    expect(quitCount).toBe(1);
  });

  test('quit is idempotent when both exit and safety timeout fire', () => {
    let quitCount = 0;
    let safetyTimer: (() => void) | null = null;
    const fake = makeFakeUtility();
    runDriverBootSmoke({
      fork: () => fake.util,
      quit: () => {
        quitCount += 1;
      },
      setTimeout: (fn) => {
        safetyTimer = fn;
      },
      utilityEntryPath: '/ignored.js',
    });
    safetyTimer?.();
    expect(quitCount).toBe(1);
    fake.emitExit();
    expect(quitCount).toBe(1);
  });

  test('safety timeout is scheduled at the configured interval (default 25s, inside driver 30s timeout)', () => {
    let scheduledMs: number | null = null;
    const fake = makeFakeUtility();
    runDriverBootSmoke({
      fork: () => fake.util,
      quit: () => {},
      setTimeout: (_fn, ms) => {
        scheduledMs = ms;
      },
      utilityEntryPath: '/ignored.js',
    });
    expect(scheduledMs).toBe(25_000);
    expect(scheduledMs).toBeLessThan(30_000);
  });

  test('safety timeout override is honored (for tests that want a fast tick)', () => {
    let scheduledMs: number | null = null;
    const fake = makeFakeUtility();
    runDriverBootSmoke({
      fork: () => fake.util,
      quit: () => {},
      setTimeout: (_fn, ms) => {
        scheduledMs = ms;
      },
      utilityEntryPath: '/ignored.js',
      safetyTimeoutMs: 100,
    });
    expect(scheduledMs).toBe(100);
  });
});

describe('isDriverBootSmokeMode (US-006 AC8 gate)', () => {
  test('true only when both env vars are set to 1', () => {
    expect(
      isDriverBootSmokeMode({
        OK_DEBUG_KEYRING_SMOKE: '1',
        OK_DEBUG_KEYRING_SMOKE_EXIT: '1',
      }),
    ).toBe(true);
  });

  test('false when only SMOKE=1 (dev-mode auto-smoke, not driver mode)', () => {
    expect(isDriverBootSmokeMode({ OK_DEBUG_KEYRING_SMOKE: '1' })).toBe(false);
  });

  test('false when only EXIT=1 (meaningless without SMOKE=1)', () => {
    expect(isDriverBootSmokeMode({ OK_DEBUG_KEYRING_SMOKE_EXIT: '1' })).toBe(false);
  });

  test('false on empty env (default user launch — Navigator opens, no utility)', () => {
    expect(isDriverBootSmokeMode({})).toBe(false);
  });

  test('false when vars are truthy-but-not-literal-"1"', () => {
    expect(
      isDriverBootSmokeMode({
        OK_DEBUG_KEYRING_SMOKE: 'true',
        OK_DEBUG_KEYRING_SMOKE_EXIT: 'true',
      }),
    ).toBe(false);
  });
});

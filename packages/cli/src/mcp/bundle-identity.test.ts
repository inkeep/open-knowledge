import { describe, expect, test } from 'bun:test';
import {
  type BundleIdentityCheckInput,
  type BundleIdentityState,
  type BundleIdentityWatcherDeps,
  captureBootIdentity,
  detectBundleIdentity,
  startBundleIdentityWatcher,
} from './bundle-identity.ts';

const DARWIN: NodeJS.Platform = 'darwin';
const ANCHOR_PATH = '/Applications/OpenKnowledge.app/Contents/MacOS/OpenKnowledge';
const REAL_ANCHOR_PATH = '/Applications/OpenKnowledge.app/Contents/MacOS/OpenKnowledge';

function input(overrides: Partial<BundleIdentityCheckInput> = {}): BundleIdentityCheckInput {
  return {
    bundleAnchorPath: ANCHOR_PATH,
    currentInode: 299_520_753,
    platform: DARWIN,
    realpath: () => REAL_ANCHOR_PATH,
    statInode: () => 299_520_753,
    ...overrides,
  };
}

describe('detectBundleIdentity', () => {
  test('returns `unchanged` when realpath inode matches process-start inode', () => {
    const state = detectBundleIdentity(input());
    expect(state.kind).toBe('unchanged');
  });

  test('returns `replaced` when realpath inode differs from process-start inode', () => {
    const state = detectBundleIdentity(
      input({
        currentInode: 299_520_753,
        statInode: () => 299_520_789,
      }),
    );
    expect(state.kind).toBe('replaced');
    if (state.kind === 'replaced') {
      expect(state.currentInode).toBe(299_520_753);
      expect(state.onDiskInode).toBe(299_520_789);
    }
  });

  test('returns `unreadable` when realpath() throws (bundle uninstalled mid-session)', () => {
    const state = detectBundleIdentity(
      input({
        realpath: () => {
          const err = new Error("ENOENT: no such file or directory, realpath '/path/to/bundle'");
          (err as NodeJS.ErrnoException).code = 'ENOENT';
          throw err;
        },
      }),
    );
    expect(state.kind).toBe('unreadable');
  });

  test('propagates the realpath error message via state.reason for operator debugging', () => {
    const state = detectBundleIdentity(
      input({
        realpath: () => {
          throw new Error("ENOENT: no such file or directory, realpath '/path/to/bundle'");
        },
      }),
    );
    expect(state.kind).toBe('unreadable');
    if (state.kind === 'unreadable') {
      expect(state.reason).toBe("ENOENT: no such file or directory, realpath '/path/to/bundle'");
    }
  });

  test('propagates the statInode error message via state.reason for operator debugging', () => {
    const state = detectBundleIdentity(
      input({
        statInode: () => {
          throw new Error("EACCES: permission denied, stat '/path/to/bundle'");
        },
      }),
    );
    expect(state.kind).toBe('unreadable');
    if (state.kind === 'unreadable') {
      expect(state.reason).toBe("EACCES: permission denied, stat '/path/to/bundle'");
    }
  });

  test('returns `unreadable` when statInode() throws after realpath succeeds', () => {
    const state = detectBundleIdentity(
      input({
        realpath: () => REAL_ANCHOR_PATH,
        statInode: () => {
          const err = new Error("EACCES: permission denied, stat '/path/to/bundle'");
          (err as NodeJS.ErrnoException).code = 'EACCES';
          throw err;
        },
      }),
    );
    expect(state.kind).toBe('unreadable');
  });

  test('returns `unchanged` on non-darwin platforms regardless of inputs', () => {
    const linuxState = detectBundleIdentity(
      input({
        platform: 'linux',
        currentInode: 100,
        statInode: () => 200,
        realpath: () => {
          throw new Error('realpath should not be called on non-darwin');
        },
      }),
    );
    expect(linuxState.kind).toBe('unchanged');

    const winState = detectBundleIdentity(
      input({
        platform: 'win32',
        currentInode: 100,
        statInode: () => 200,
        realpath: () => {
          throw new Error('realpath should not be called on non-darwin');
        },
      }),
    );
    expect(winState.kind).toBe('unchanged');
  });

  test('returns `unchanged` when realpath path string differs but inode is identical', () => {
    const state = detectBundleIdentity(
      input({
        realpath: () => '/Applications/OK.app/Contents/MacOS/OK',
        currentInode: 299_520_753,
        statInode: () => 299_520_753,
      }),
    );
    expect(state.kind).toBe('unchanged');
  });

  test('never throws — translates every failure mode to a typed state', () => {
    const stateA = detectBundleIdentity(
      input({
        realpath: () => {
          throw new Error('boom-1');
        },
      }),
    );
    expect(stateA.kind).toBe('unreadable');

    const stateB = detectBundleIdentity(
      input({
        statInode: () => {
          throw new Error('boom-2');
        },
      }),
    );
    expect(stateB.kind).toBe('unreadable');

    const stateC = detectBundleIdentity(
      input({
        platform: 'freebsd' as NodeJS.Platform,
        realpath: () => {
          throw new Error('platform-guard-failed');
        },
      }),
    );
    expect(stateC.kind).toBe('unchanged');
  });
});

interface WatcherFixtures {
  setInterval: BundleIdentityWatcherDeps['setInterval'];
  clearInterval: BundleIdentityWatcherDeps['clearInterval'];
  tickCallback: (() => void) | null;
  setIntervalCalls: Array<{ ms: number }>;
  clearIntervalCalls: unknown[];
  intervalHandle: { unrefCalls: number };
}

function makeWatcherFixtures(): WatcherFixtures {
  const fx: WatcherFixtures = {
    tickCallback: null,
    setIntervalCalls: [],
    clearIntervalCalls: [],
    intervalHandle: { unrefCalls: 0 },
    setInterval: ((cb: () => void, ms: number) => {
      fx.tickCallback = cb;
      fx.setIntervalCalls.push({ ms });
      return {
        unref: () => {
          fx.intervalHandle.unrefCalls += 1;
          return fx.intervalHandle;
        },
      } as unknown as ReturnType<typeof setInterval>;
    }) as BundleIdentityWatcherDeps['setInterval'],
    clearInterval: ((handle: unknown) => {
      fx.clearIntervalCalls.push(handle);
    }) as BundleIdentityWatcherDeps['clearInterval'],
  };
  return fx;
}

describe('startBundleIdentityWatcher', () => {
  test('registers a periodic tick with the configured interval and unrefs the handle', () => {
    const fx = makeWatcherFixtures();
    startBundleIdentityWatcher({
      detect: () => ({ kind: 'unchanged' }),
      onReplaced: () => {},
      log: () => {},
      intervalMs: 300_000,
      setInterval: fx.setInterval,
      clearInterval: fx.clearInterval,
    });
    expect(fx.setIntervalCalls.length).toBe(1);
    expect(fx.setIntervalCalls[0]?.ms).toBe(300_000);
    expect(fx.intervalHandle.unrefCalls).toBe(1);
  });

  test('invokes detect on each tick', () => {
    const fx = makeWatcherFixtures();
    let detectCalls = 0;
    startBundleIdentityWatcher({
      detect: () => {
        detectCalls += 1;
        return { kind: 'unchanged' };
      },
      onReplaced: () => {},
      log: () => {},
      intervalMs: 1000,
      setInterval: fx.setInterval,
      clearInterval: fx.clearInterval,
    });
    expect(detectCalls).toBe(0);
    fx.tickCallback?.();
    expect(detectCalls).toBe(1);
    fx.tickCallback?.();
    fx.tickCallback?.();
    expect(detectCalls).toBe(3);
  });

  test('invokes onReplaced exactly once when detect returns `replaced`, then disarms', () => {
    const fx = makeWatcherFixtures();
    const replaced: BundleIdentityState = {
      kind: 'replaced',
      currentInode: 100,
      onDiskInode: 200,
    };
    const onReplacedCalls: BundleIdentityState[] = [];
    startBundleIdentityWatcher({
      detect: () => replaced,
      onReplaced: (s) => onReplacedCalls.push(s),
      log: () => {},
      intervalMs: 1000,
      setInterval: fx.setInterval,
      clearInterval: fx.clearInterval,
    });
    fx.tickCallback?.();
    fx.tickCallback?.();
    fx.tickCallback?.();
    expect(onReplacedCalls.length).toBe(1);
    expect(onReplacedCalls[0]).toEqual(replaced);
  });

  test('does NOT invoke onReplaced for `unchanged` or `unreadable`', () => {
    const fx = makeWatcherFixtures();
    let kind: BundleIdentityState['kind'] = 'unchanged';
    const onReplacedCalls: BundleIdentityState[] = [];
    startBundleIdentityWatcher({
      detect: () => (kind === 'unchanged' ? { kind: 'unchanged' } : { kind: 'unreadable' }),
      onReplaced: (s) => onReplacedCalls.push(s),
      log: () => {},
      intervalMs: 1000,
      setInterval: fx.setInterval,
      clearInterval: fx.clearInterval,
    });
    fx.tickCallback?.();
    kind = 'unreadable';
    fx.tickCallback?.();
    fx.tickCallback?.();
    expect(onReplacedCalls.length).toBe(0);
  });

  test('logs a diagnostic message when detect returns `unreadable`', () => {
    const fx = makeWatcherFixtures();
    const logs: string[] = [];
    startBundleIdentityWatcher({
      detect: () => ({ kind: 'unreadable' }),
      onReplaced: () => {},
      log: (msg) => logs.push(msg),
      intervalMs: 1000,
      setInterval: fx.setInterval,
      clearInterval: fx.clearInterval,
    });
    fx.tickCallback?.();
    expect(logs.length).toBe(1);
    expect(logs[0]).toMatch(/unreadable/i);
  });

  test('watcher log includes `reason` when unreadable state carries one', () => {
    const fx = makeWatcherFixtures();
    const logs: string[] = [];
    startBundleIdentityWatcher({
      detect: () => ({ kind: 'unreadable', reason: 'ENOENT: no such file or directory' }),
      onReplaced: () => {},
      log: (msg) => logs.push(msg),
      intervalMs: 1000,
      setInterval: fx.setInterval,
      clearInterval: fx.clearInterval,
    });
    fx.tickCallback?.();
    expect(logs.length).toBe(1);
    expect(logs[0]).toMatch(/ENOENT: no such file or directory/);
  });

  test('logs `unreadable` once per episode, not on every tick', () => {
    const fx = makeWatcherFixtures();
    const logs: string[] = [];
    let kind: BundleIdentityState['kind'] = 'unreadable';
    startBundleIdentityWatcher({
      detect: () => (kind === 'unreadable' ? { kind: 'unreadable' } : { kind: 'unchanged' }),
      onReplaced: () => {},
      log: (msg) => logs.push(msg),
      intervalMs: 1000,
      setInterval: fx.setInterval,
      clearInterval: fx.clearInterval,
    });
    fx.tickCallback?.();
    fx.tickCallback?.();
    fx.tickCallback?.();
    expect(logs.length).toBe(1);
    expect(logs[0]).toMatch(/unreadable/i);

    kind = 'unchanged';
    fx.tickCallback?.();
    expect(logs.length).toBe(2);
    expect(logs[1]).toMatch(/recovered/i);

    fx.tickCallback?.();
    fx.tickCallback?.();
    expect(logs.length).toBe(2);

    kind = 'unreadable';
    fx.tickCallback?.();
    fx.tickCallback?.();
    expect(logs.length).toBe(3);
    expect(logs[2]).toMatch(/unreadable/i);
  });

  test('unreadable → replaced transition fires onReplaced + recovery log', () => {
    const fx = makeWatcherFixtures();
    const logs: string[] = [];
    const onReplacedCalls: BundleIdentityState[] = [];
    const replaced: BundleIdentityState = {
      kind: 'replaced',
      currentInode: 100,
      onDiskInode: 200,
    };
    let kind: BundleIdentityState['kind'] = 'unreadable';
    startBundleIdentityWatcher({
      detect: () => (kind === 'unreadable' ? { kind: 'unreadable', reason: 'EACCES' } : replaced),
      onReplaced: (s) => onReplacedCalls.push(s),
      log: (msg) => logs.push(msg),
      intervalMs: 1000,
      setInterval: fx.setInterval,
      clearInterval: fx.clearInterval,
    });
    fx.tickCallback?.();
    fx.tickCallback?.();
    expect(logs.length).toBe(1);
    expect(logs[0]).toMatch(/unreadable/i);

    kind = 'replaced';
    fx.tickCallback?.();
    expect(onReplacedCalls.length).toBe(1);
    expect(onReplacedCalls[0]).toEqual(replaced);
    expect(logs.length).toBe(2);
    expect(logs[1]).toMatch(/recovered/i);
  });

  test('logs and continues when detect throws (defense-in-depth)', () => {
    const fx = makeWatcherFixtures();
    const logs: string[] = [];
    let tickCalls = 0;
    startBundleIdentityWatcher({
      detect: () => {
        tickCalls += 1;
        throw new Error('contract violation');
      },
      onReplaced: () => {},
      log: (msg) => logs.push(msg),
      intervalMs: 1000,
      setInterval: fx.setInterval,
      clearInterval: fx.clearInterval,
    });
    expect(() => fx.tickCallback?.()).not.toThrow();
    expect(tickCalls).toBe(1);
    expect(logs.some((m) => /contract violation/.test(m))).toBe(true);
    expect(() => fx.tickCallback?.()).not.toThrow();
    expect(tickCalls).toBe(2);
  });

  test('stop() clears the interval and subsequent ticks are no-ops', () => {
    const fx = makeWatcherFixtures();
    let detectCalls = 0;
    const handle = startBundleIdentityWatcher({
      detect: () => {
        detectCalls += 1;
        return { kind: 'unchanged' };
      },
      onReplaced: () => {},
      log: () => {},
      intervalMs: 1000,
      setInterval: fx.setInterval,
      clearInterval: fx.clearInterval,
    });
    fx.tickCallback?.();
    expect(detectCalls).toBe(1);

    handle.stop();
    expect(fx.clearIntervalCalls.length).toBe(1);

    fx.tickCallback?.();
    expect(detectCalls).toBe(1);
  });

  test('stop() is idempotent', () => {
    const fx = makeWatcherFixtures();
    const handle = startBundleIdentityWatcher({
      detect: () => ({ kind: 'unchanged' }),
      onReplaced: () => {},
      log: () => {},
      intervalMs: 1000,
      setInterval: fx.setInterval,
      clearInterval: fx.clearInterval,
    });
    handle.stop();
    handle.stop();
    handle.stop();
    expect(fx.clearIntervalCalls.length).toBe(1);
  });
});

describe('captureBootIdentity', () => {
  test('returns { resolvedPath, inode } when both fs probes succeed', () => {
    const logs: string[] = [];
    const result = captureBootIdentity(
      '/Applications/OpenKnowledge.app/Contents/MacOS/OpenKnowledge',
      {
        realpathSync: () => '/Applications/OpenKnowledge.app/Contents/MacOS/OpenKnowledge',
        statInoSync: () => 299_520_753,
        log: (m) => logs.push(m),
      },
    );
    expect(result).toEqual({
      resolvedPath: '/Applications/OpenKnowledge.app/Contents/MacOS/OpenKnowledge',
      inode: 299_520_753,
    });
    expect(logs).toEqual([]);
  });

  test('returns undefined and logs underlying error when realpathSync throws', () => {
    const logs: string[] = [];
    const result = captureBootIdentity('/missing/bundle/path', {
      realpathSync: () => {
        throw new Error("ENOENT: no such file or directory, realpath '/missing/bundle/path'");
      },
      statInoSync: () => {
        throw new Error('stat should not be called when realpath fails');
      },
      log: (m) => logs.push(m),
    });
    expect(result).toBeUndefined();
    const joined = logs.join(' ');
    expect(joined).toMatch(/realpath/i);
    expect(joined).toMatch(/ENOENT/);
    expect(joined).toMatch(/\/missing\/bundle\/path/);
  });

  test('returns undefined and logs underlying error when statInoSync throws', () => {
    const logs: string[] = [];
    const result = captureBootIdentity(
      '/Applications/OpenKnowledge.app/Contents/MacOS/OpenKnowledge',
      {
        realpathSync: () => '/Applications/OpenKnowledge.app/Contents/MacOS/OpenKnowledge',
        statInoSync: () => {
          throw new Error("EACCES: permission denied, stat '/path/to/bundle'");
        },
        log: (m) => logs.push(m),
      },
    );
    expect(result).toBeUndefined();
    const joined = logs.join(' ');
    expect(joined).toMatch(/stat/i);
    expect(joined).toMatch(/EACCES/);
  });

  test('non-Error throwables (string, undefined) are coerced into the log message', () => {
    const logs: string[] = [];
    const result = captureBootIdentity('/anchor', {
      realpathSync: () => {
        throw 'plain-string-error';
      },
      statInoSync: () => 0,
      log: (m) => logs.push(m),
    });
    expect(result).toBeUndefined();
    expect(logs.join(' ')).toMatch(/plain-string-error/);
  });
});

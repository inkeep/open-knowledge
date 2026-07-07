import { describe, expect, test } from 'bun:test';
import {
  type BundleIdentityCheckInput,
  type BundleIdentityState,
  type BundleIdentityWatcherDeps,
  captureBootIdentity,
  detectBundleIdentity,
  startBundleIdentityWatcher,
} from './bundle-identity.ts';

/**
 * The `ok mcp` self-check detects a mid-session drag-replace upgrade of the
 * OpenKnowledge bundle. The detection function classifies identity at the
 * inode level — path equality is insufficient because the drag-replace UX
 * swaps the inode while the path stays the same.
 *
 * `realpath` and `statInode` are injected as function deps rather than
 * mocked via `node:fs`. The try/catch around the injected deps is a trust-
 * boundary guard at the filesystem; failures map to `'unreadable'`, which
 * is a domain-specific behavioral outcome, not a tautological "catch was
 * reached" assertion. Tests pin `'unreadable'` by passing throwing
 * implementations of the deps.
 */

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
    // The drag-replace case: Finder swaps the bundle, child still maps the
    // previous inode (299_520_753), on-disk realpath now resolves to a
    // fresh inode (299_520_789).
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
    // Real failure mode: user dragged the bundle to the Trash while the
    // child is still alive. `realpath` throws ENOENT. The function must
    // classify this conservatively — the caller decides whether to exit.
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
    // Without `reason`, operators staring at a recurring `unreadable` log
    // can't distinguish ENOENT (bundle gone) from EACCES (permission) from
    // EIO (transient fs hiccup). Pin that the underlying error text reaches
    // the state object via the public interface.
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
    // Same diagnostic contract as the realpath failure path: stat-side
    // failures (EACCES, EIO, mid-replace flux) must surface their message
    // through state.reason.
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
    // Real failure mode: realpath resolves, but the stat raced with a
    // permissions change / unmount / mid-replace flux. Conservative
    // classification — do NOT report `replaced` from a transient stat
    // failure (false-positive would force unnecessary process exits).
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
    // Platform guard. The bundle-drag-replace vector is macOS-specific
    // (Finder UX). Windows uses installer-with-restart so the same vector
    // doesn't exist. The function MUST short-circuit BEFORE calling fs deps
    // so this platform branch is exercised without producing fs side
    // effects (and so non-darwin packagers can call the function freely).
    const linuxState = detectBundleIdentity(
      input({
        platform: 'linux',
        // Inodes diverge — would normally classify as `replaced`. Platform
        // guard must overrule.
        currentInode: 100,
        statInode: () => 200,
        // If the platform guard is missing, this throw would surface;
        // catching it would route to `unreadable`. Pinning `unchanged`
        // proves the guard short-circuited before deps were called.
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
    // Edge case: symlink swap with no inode change. E.g., user renamed
    // and recreated `/Applications/OpenKnowledge.app` via a script that
    // preserved the underlying inode, OR `process.execPath` is a symlink
    // whose target was rewritten to a different path resolving to the
    // SAME on-disk inode. The function classifies identity by inode, not
    // path — equal inode = same binary = no replacement.
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
    // The contract is that callers can call this function unconditionally
    // without a try/catch. Both unhappy paths (realpath throws / statInode
    // throws) must be absorbed into `'unreadable'`. Non-darwin platforms
    // short-circuit to `'unchanged'` before any dep is touched.
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
  /** The tick callback registered with the fake setInterval. */
  tickCallback: (() => void) | null;
  /** Args passed to the fake setInterval (callback + intervalMs). */
  setIntervalCalls: Array<{ ms: number }>;
  /** Handles passed to the fake clearInterval. */
  clearIntervalCalls: unknown[];
  /** The handle returned from the fake setInterval. */
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
    // .unref() must fire so a dangling timer never blocks process exit on
    // SIGINT/SIGTERM after `close()` has run on a different code path.
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
    // Single-shot per session: once a replacement is detected, the watcher
    // should stop firing onReplaced so the host respawn isn't triggered
    // repeatedly while close() is in flight. Mirrors the sibling
    // single-shot semantics in bundle-replace-detector.ts.
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
    // Without this signal, operators cannot distinguish "check ran clean"
    // from "check ran but couldn't classify" — both look identical in the
    // absence of the `bundle replaced` log line.
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
    // The `reason` field exists so operators can distinguish ENOENT (bundle
    // removed) from EACCES (sandboxing) from EIO (transient). The classifier
    // tests pin that the field is populated; this test pins that the watcher
    // actually surfaces it through the log line — the one diagnostic signal
    // an operator has when stale-detection is silently no-op'ing.
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
    // Persistent unreadable state (e.g., user dragged the bundle to the
    // Trash) must not generate one log line every interval indefinitely —
    // external MCP hosts capture stdio child stderr permanently. The log
    // is edge-triggered on the unchanged-to-unreadable transition; the
    // recovery transition (unreadable-to-unchanged) is logged separately
    // so a future re-occurrence can log again.
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

    // Transition back to readable — should log recovery.
    kind = 'unchanged';
    fx.tickCallback?.();
    expect(logs.length).toBe(2);
    expect(logs[1]).toMatch(/recovered/i);

    // Subsequent unchanged ticks stay silent.
    fx.tickCallback?.();
    fx.tickCallback?.();
    expect(logs.length).toBe(2);

    // New unreadable episode — log fires again on the leading edge.
    kind = 'unreadable';
    fx.tickCallback?.();
    fx.tickCallback?.();
    expect(logs.length).toBe(3);
    expect(logs[2]).toMatch(/unreadable/i);
  });

  test('unreadable → replaced transition fires onReplaced + recovery log', () => {
    // The wasUnreadable flag must reset on the recovery edge whether the
    // recovery is to 'unchanged' (covered above) OR straight to 'replaced'.
    // A regression that only resets on 'unchanged' would either skip the
    // recovery log on a replace or fail to clear the flag — both confuse
    // the operator triage signal during an already-disruptive event.
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
    // detectBundleIdentity is contractually no-throw, but the watcher wraps
    // each tick in a try/catch so a future contract violation surfaces as a
    // log line rather than crashing the long-lived stdio process.
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
    // Subsequent ticks still run — one transient throw doesn't disarm.
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

    // Even if the (real) interval somehow fired again, the watcher must
    // skip the work — clearInterval is best-effort and tests guard against
    // the race.
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
  // The realpath/stat error paths are exercised through this public
  // helper rather than only through the server's stdio boot lifecycle.
  // Assertions check user-observable return value (`undefined` on
  // failure) and captured log message CONTENT, not the exact format
  // string — leaves the log format free to evolve.

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
    // Happy path stays silent — operators only see boot-time noise on failure.
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
    // Asserting CONTENT, not format — the operator-debugging contract is
    // that the underlying error text appears in the log so they can act on
    // it. The exact framing ("realpath failed", "boot capture", etc.) is a
    // logging concern that should be free to evolve without breaking tests.
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
    // Same content contract as the realpath failure path: operators get
    // the underlying error text so they can distinguish failure modes.
    const joined = logs.join(' ');
    expect(joined).toMatch(/stat/i);
    expect(joined).toMatch(/EACCES/);
  });

  test('non-Error throwables (string, undefined) are coerced into the log message', () => {
    // Defensive belt-and-suspenders: realpathSync and statSync from node:fs
    // always throw Error subclasses, but the helper accepts injected fs
    // shims and a malicious/buggy shim could throw a string. The helper
    // must still produce a non-empty diagnostic and return undefined.
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

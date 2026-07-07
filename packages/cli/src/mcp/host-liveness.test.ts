import { describe, expect, test } from 'bun:test';
import { type HostLivenessScheduler, startHostLivenessWatch } from './host-liveness.ts';

/**
 * A scheduler that captures the tick callback so the test drives it manually.
 * A `tick()` after `clearInterval` is a no-op — faithful to real `setInterval`,
 * so tests can assert that `stop()` (which clears) actually halts polling.
 */
function manualScheduler(): {
  scheduler: HostLivenessScheduler;
  tick: () => void;
  registered: () => boolean;
  cleared: () => boolean;
} {
  let cb: (() => void) | null = null;
  let active = false;
  let everRegistered = false;
  const token = Symbol('timer') as unknown as ReturnType<typeof globalThis.setInterval>;
  return {
    scheduler: {
      setInterval: (fn) => {
        cb = fn;
        active = true;
        everRegistered = true;
        return token;
      },
      clearInterval: (handle) => {
        if (handle === token) active = false;
      },
    },
    tick: () => {
      if (active) cb?.();
    },
    registered: () => everRegistered,
    cleared: () => everRegistered && !active,
  };
}

describe('startHostLivenessWatch', () => {
  test('fires onHostGone once when ppid changes from boot, then clears the timer', () => {
    const m = manualScheduler();
    let ppid = 4242;
    const reasons: string[] = [];
    startHostLivenessWatch({
      getPpid: () => ppid,
      onHostGone: (r) => reasons.push(r),
      scheduler: m.scheduler,
    });

    m.tick(); // parent still alive
    expect(reasons).toHaveLength(0);

    ppid = 1; // reparented to launchd
    m.tick();
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain('4242');
    expect(reasons[0]).toContain('1');
    expect(m.cleared()).toBe(true);

    m.tick(); // timer cleared → no further fires
    expect(reasons).toHaveLength(1);
  });

  test('does not fire while the parent pid is unchanged', () => {
    const m = manualScheduler();
    let fired = 0;
    startHostLivenessWatch({
      getPpid: () => 999,
      onHostGone: () => {
        fired++;
      },
      scheduler: m.scheduler,
    });
    m.tick();
    m.tick();
    expect(fired).toBe(0);
  });

  test('no-op when there is no meaningful parent (bootPpid <= 1)', () => {
    const m = manualScheduler();
    let fired = 0;
    const handle = startHostLivenessWatch({
      getPpid: () => 1, // already orphaned / launched by init
      onHostGone: () => {
        fired++;
      },
      scheduler: m.scheduler,
    });
    expect(m.registered()).toBe(false); // never schedules a poll
    handle.stop(); // safe to call
    expect(fired).toBe(0);
  });

  test('stop() halts polling so onHostGone never fires afterward', () => {
    const m = manualScheduler();
    let ppid = 500;
    let fired = 0;
    const handle = startHostLivenessWatch({
      getPpid: () => ppid,
      onHostGone: () => {
        fired++;
      },
      scheduler: m.scheduler,
    });
    handle.stop();
    expect(m.cleared()).toBe(true);
    ppid = 1; // host dies after we stopped watching
    m.tick(); // no-op (timer cleared)
    expect(fired).toBe(0);
  });
});

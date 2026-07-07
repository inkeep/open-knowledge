import { describe, expect, test } from 'bun:test';
import { createSelfSchedulingPoll, type PollOutcome } from './self-scheduling-poll.ts';

// Injectable fake timer — records scheduled callbacks; `runPending` fires the
// next one. No real time elapses, so the scheduling contract is deterministic.
function makeTimerHarness() {
  const timers: Array<{ fn: () => void; ms: number; id: number }> = [];
  let nextId = 1;
  return {
    timers,
    setTimer: (fn: () => void, ms: number) => {
      const id = nextId++;
      timers.push({ fn, ms, id });
      return id;
    },
    clearTimer: (h: unknown) => {
      const i = timers.findIndex((t) => t.id === h);
      if (i >= 0) timers.splice(i, 1);
    },
    runPending: () => {
      const t = timers.shift();
      t?.fn();
    },
  };
}

// Controllable poll — each call returns a fresh promise resolved/rejected by the
// test via `resolve`/`reject` on the latest call.
function makePollController() {
  let calls = 0;
  let resolveLatest: (o: PollOutcome) => void = () => {};
  let rejectLatest: (e: unknown) => void = () => {};
  return {
    poll: (_signal: AbortSignal) => {
      calls += 1;
      return new Promise<PollOutcome>((res, rej) => {
        resolveLatest = res;
        rejectLatest = rej;
      });
    },
    get calls() {
      return calls;
    },
    resolve: (o: PollOutcome) => resolveLatest(o),
    reject: (e: unknown) => rejectLatest(e),
  };
}

// Flush microtasks so the continuation after `await poll()` runs.
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

describe('createSelfSchedulingPoll (PRD-6972 FR1)', () => {
  test('never stacks: next poll is armed only after the previous settles', async () => {
    const timer = makeTimerHarness();
    const ctrl = makePollController();
    const loop = createSelfSchedulingPoll({
      poll: ctrl.poll,
      baseMs: 1000,
      maxBackoffMs: 60_000,
      isPaused: () => false,
      setTimer: timer.setTimer,
      clearTimer: timer.clearTimer,
    });

    loop.start();
    await flush();
    expect(ctrl.calls).toBe(1);
    expect(timer.timers).toHaveLength(0); // nothing armed while a poll is in flight

    // The poll is still in flight — no second poll can be issued.
    await flush();
    expect(ctrl.calls).toBe(1);

    ctrl.resolve('ok');
    await flush();
    expect(timer.timers).toHaveLength(1); // next armed only after settle
    expect(timer.timers[0]?.ms).toBe(1000); // base cadence on success
    expect(ctrl.calls).toBe(1);

    timer.runPending();
    await flush();
    expect(ctrl.calls).toBe(2);
    loop.stop();
  });

  test('hidden tab issues zero requests; resume() restarts on re-show', async () => {
    const timer = makeTimerHarness();
    const ctrl = makePollController();
    let paused = false;
    const loop = createSelfSchedulingPoll({
      poll: ctrl.poll,
      baseMs: 1000,
      maxBackoffMs: 60_000,
      isPaused: () => paused,
      setTimer: timer.setTimer,
      clearTimer: timer.clearTimer,
    });

    loop.start();
    await flush();
    ctrl.resolve('ok');
    await flush();
    expect(timer.timers).toHaveLength(1);

    // Tab goes hidden; the armed tick fires but parks instead of polling.
    paused = true;
    timer.runPending();
    await flush();
    expect(ctrl.calls).toBe(1); // zero requests while hidden
    expect(timer.timers).toHaveLength(0); // parked, no timer

    // resume() while still hidden is a no-op.
    loop.resume();
    await flush();
    expect(ctrl.calls).toBe(1);

    // Tab shown → resume polls exactly once.
    paused = false;
    loop.resume();
    await flush();
    expect(ctrl.calls).toBe(2);
    loop.stop();
  });

  test('errors back off exponentially up to the cap; success resets to base', async () => {
    const timer = makeTimerHarness();
    const ctrl = makePollController();
    const loop = createSelfSchedulingPoll({
      poll: ctrl.poll,
      baseMs: 1000,
      maxBackoffMs: 4000,
      isPaused: () => false,
      setTimer: timer.setTimer,
      clearTimer: timer.clearTimer,
    });

    loop.start();
    await flush();
    ctrl.resolve('error');
    await flush();
    expect(timer.timers[0]?.ms).toBe(2000); // base * 2

    timer.runPending();
    await flush();
    ctrl.resolve('error');
    await flush();
    expect(timer.timers[0]?.ms).toBe(4000); // 2000 * 2

    timer.runPending();
    await flush();
    ctrl.resolve('error');
    await flush();
    expect(timer.timers[0]?.ms).toBe(4000); // capped at max — no tight loop

    timer.runPending();
    await flush();
    ctrl.resolve('ok');
    await flush();
    expect(timer.timers[0]?.ms).toBe(1000); // recovered → base
    loop.stop();
  });

  test('a rejected poll backs off; a rejection after stop() does not reschedule', async () => {
    const timer = makeTimerHarness();
    const ctrl = makePollController();
    const loop = createSelfSchedulingPoll({
      poll: ctrl.poll,
      baseMs: 1000,
      maxBackoffMs: 60_000,
      isPaused: () => false,
      setTimer: timer.setTimer,
      clearTimer: timer.clearTimer,
    });

    loop.start();
    await flush();
    ctrl.reject(new Error('network'));
    await flush();
    expect(timer.timers[0]?.ms).toBe(2000); // rejection treated as error → backoff

    timer.runPending();
    await flush();
    loop.stop(); // aborts the in-flight poll
    ctrl.reject(new Error('aborted-after-stop'));
    await flush();
    expect(timer.timers).toHaveLength(0); // stopped → no reschedule
  });

  test('stop() clears the pending timer and start()/resume() are no-ops afterward', async () => {
    const timer = makeTimerHarness();
    const ctrl = makePollController();
    const loop = createSelfSchedulingPoll({
      poll: ctrl.poll,
      baseMs: 1000,
      maxBackoffMs: 60_000,
      isPaused: () => false,
      setTimer: timer.setTimer,
      clearTimer: timer.clearTimer,
    });

    loop.start();
    await flush();
    ctrl.resolve('ok');
    await flush();
    expect(timer.timers).toHaveLength(1);

    loop.stop();
    expect(timer.timers).toHaveLength(0); // pending timer cleared

    loop.start();
    loop.resume();
    await flush();
    expect(ctrl.calls).toBe(1); // no new poll after stop
  });

  test('a second start() while running is a no-op (does not spawn a second loop)', async () => {
    const timer = makeTimerHarness();
    const ctrl = makePollController();
    const loop = createSelfSchedulingPoll({
      poll: ctrl.poll,
      baseMs: 1000,
      maxBackoffMs: 60_000,
      isPaused: () => false,
      setTimer: timer.setTimer,
      clearTimer: timer.clearTimer,
    });

    loop.start();
    await flush();
    expect(ctrl.calls).toBe(1);

    // Re-starting mid-flight must not fire a second concurrent poll.
    loop.start();
    await flush();
    expect(ctrl.calls).toBe(1);
  });
});

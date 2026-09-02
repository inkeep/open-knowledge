import { describe, expect, test } from 'vitest';
import { createSelfSchedulingPoll, type PollOutcome } from './self-scheduling-poll.ts';

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
    expect(timer.timers).toHaveLength(0);

    await flush();
    expect(ctrl.calls).toBe(1);

    ctrl.resolve('ok');
    await flush();
    expect(timer.timers).toHaveLength(1);
    expect(timer.timers[0]?.ms).toBe(1000);
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

    paused = true;
    timer.runPending();
    await flush();
    expect(ctrl.calls).toBe(1);
    expect(timer.timers).toHaveLength(0);

    loop.resume();
    await flush();
    expect(ctrl.calls).toBe(1);

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
    expect(timer.timers[0]?.ms).toBe(2000);

    timer.runPending();
    await flush();
    ctrl.resolve('error');
    await flush();
    expect(timer.timers[0]?.ms).toBe(4000);

    timer.runPending();
    await flush();
    ctrl.resolve('error');
    await flush();
    expect(timer.timers[0]?.ms).toBe(4000);

    timer.runPending();
    await flush();
    ctrl.resolve('ok');
    await flush();
    expect(timer.timers[0]?.ms).toBe(1000);
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
    expect(timer.timers[0]?.ms).toBe(2000);

    timer.runPending();
    await flush();
    loop.stop();
    ctrl.reject(new Error('aborted-after-stop'));
    await flush();
    expect(timer.timers).toHaveLength(0);
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
    expect(timer.timers).toHaveLength(0);

    loop.start();
    loop.resume();
    await flush();
    expect(ctrl.calls).toBe(1);
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

    loop.start();
    await flush();
    expect(ctrl.calls).toBe(1);
  });
});

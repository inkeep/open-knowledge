/**
 * Tests for the SIGTERM → grace-poll → SIGKILL teardown ladder.
 *
 * Every case runs on a virtual clock: `sleep` advances the clock and resolves
 * synchronously, so the grace window and its escalation are deterministic and
 * take no wall-clock time. The assertions pin the ORDER and the exact SIGNALS
 * sent, not merely that a kill happened.
 */

import { describe, expect, it } from 'vitest';
import { gracefulTerminate } from './graceful-terminate.ts';

/**
 * Assemble deps around a virtual clock and a scripted liveness. `aliveForChecks`
 * is how many of the grace-window liveness polls report the process still
 * running before it is observed gone; `Infinity` models a process that never
 * exits (forcing escalation).
 */
function scriptedDeps(opts: { aliveForChecks: number; graceMs?: number; pollMs?: number }) {
  let clock = 0;
  let checks = 0;
  const signals: Array<'SIGTERM' | 'SIGKILL'> = [];
  const sleeps: number[] = [];
  return {
    deps: {
      sendSignal: (s: 'SIGTERM' | 'SIGKILL') => {
        signals.push(s);
      },
      isAlive: () => {
        checks += 1;
        return checks <= opts.aliveForChecks;
      },
      now: () => clock,
      sleep: (ms: number) => {
        sleeps.push(ms);
        clock += ms;
        return Promise.resolve();
      },
      graceMs: opts.graceMs,
      pollMs: opts.pollMs,
    },
    signals: () => signals,
    sleeps: () => sleeps,
  };
}

describe('gracefulTerminate', () => {
  it('escalates SIGTERM → SIGKILL when the process stays alive through the grace window', async () => {
    const { deps, signals } = scriptedDeps({
      aliveForChecks: Infinity,
      graceMs: 1_000,
      pollMs: 250,
    });
    const result = await gracefulTerminate(deps);
    // Order matters: the gentle signal first, the hard signal only after grace.
    expect(signals()).toEqual(['SIGTERM', 'SIGKILL']);
    expect(result).toEqual({ escalated: true });
  });

  it('sends SIGTERM alone — never SIGKILL — when the process exits within the grace window', async () => {
    // Alive on the first poll, gone on the second: it died mid-grace.
    const { deps, signals } = scriptedDeps({ aliveForChecks: 1, graceMs: 1_000, pollMs: 250 });
    const result = await gracefulTerminate(deps);
    expect(signals()).toEqual(['SIGTERM']);
    expect(result).toEqual({ escalated: false });
  });

  it('sends SIGTERM first, before any liveness poll or sleep', async () => {
    // Already gone at the first poll — proves SIGTERM precedes the grace loop and
    // a fast exit is neither polled-around nor SIGKILLed.
    const { deps, signals, sleeps } = scriptedDeps({
      aliveForChecks: 0,
      graceMs: 1_000,
      pollMs: 250,
    });
    const result = await gracefulTerminate(deps);
    expect(signals()).toEqual(['SIGTERM']);
    expect(sleeps()).toEqual([]);
    expect(result).toEqual({ escalated: false });
  });

  it('defaults the grace and poll cadence to the shared lifecycle constants', async () => {
    // No graceMs/pollMs supplied: the loop must run the shared 10 s / 200 ms —
    // 50 polls of 200 ms each — then escalate. Pins the defaults behaviorally.
    const { deps, signals, sleeps } = scriptedDeps({ aliveForChecks: Infinity });
    const result = await gracefulTerminate(deps);
    expect(signals()).toEqual(['SIGTERM', 'SIGKILL']);
    expect(sleeps()).toEqual(Array.from({ length: 50 }, () => 200));
    expect(result).toEqual({ escalated: true });
  });

  it('does not wait a real timeout — the grace is injectable', async () => {
    // A tiny grace with an immediate virtual sleep completes instantly; the test
    // itself is the proof (it returns without a wall-clock stall).
    const { deps, signals } = scriptedDeps({ aliveForChecks: Infinity, graceMs: 1, pollMs: 1 });
    await gracefulTerminate(deps);
    expect(signals()).toEqual(['SIGTERM', 'SIGKILL']);
  });
});

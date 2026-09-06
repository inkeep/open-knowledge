import { describe, expect, it } from 'vitest';
import { gracefulTerminate } from './graceful-terminate.ts';

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
    expect(signals()).toEqual(['SIGTERM', 'SIGKILL']);
    expect(result).toEqual({ escalated: true });
  });

  it('sends SIGTERM alone — never SIGKILL — when the process exits within the grace window', async () => {
    const { deps, signals } = scriptedDeps({ aliveForChecks: 1, graceMs: 1_000, pollMs: 250 });
    const result = await gracefulTerminate(deps);
    expect(signals()).toEqual(['SIGTERM']);
    expect(result).toEqual({ escalated: false });
  });

  it('sends SIGTERM first, before any liveness poll or sleep', async () => {
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

  it('waits for asynchronous signal dispatch before polling liveness', async () => {
    let releaseSignal: (() => void) | undefined;
    let polled = false;
    const termination = gracefulTerminate({
      sendSignal: () =>
        new Promise<void>((resolve) => {
          releaseSignal = resolve;
        }),
      isAlive: () => {
        polled = true;
        return false;
      },
      now: () => 0,
      sleep: () => Promise.resolve(),
    });

    await Promise.resolve();
    expect(polled).toBe(false);
    releaseSignal?.();
    await termination;
    expect(polled).toBe(true);
  });

  it('defaults the grace and poll cadence to the shared lifecycle constants', async () => {
    const { deps, signals, sleeps } = scriptedDeps({ aliveForChecks: Infinity });
    const result = await gracefulTerminate(deps);
    expect(signals()).toEqual(['SIGTERM', 'SIGKILL']);
    expect(sleeps()).toEqual(Array.from({ length: 50 }, () => 200));
    expect(result).toEqual({ escalated: true });
  });

  it('does not wait a real timeout — the grace is injectable', async () => {
    const { deps, signals } = scriptedDeps({ aliveForChecks: Infinity, graceMs: 1, pollMs: 1 });
    await gracefulTerminate(deps);
    expect(signals()).toEqual(['SIGTERM', 'SIGKILL']);
  });
});

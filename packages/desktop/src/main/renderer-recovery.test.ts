import { describe, expect, test, vi } from 'vitest';
import {
  createRendererRecovery,
  type RecoverableWebContents,
  type RendererRecovery,
  type RenderProcessGoneDetails,
} from './renderer-recovery.ts';

interface MockContents extends RecoverableWebContents {
  reload: ReturnType<typeof vi.fn>;
  markDestroyed: () => void;
}

let nextContentsId = 1;

function makeContents(): MockContents {
  let destroyed = false;
  return {
    id: nextContentsId++,
    reload: vi.fn(() => {}),
    isDestroyed: () => destroyed,
    markDestroyed: () => {
      destroyed = true;
    },
  };
}

interface LogLine {
  level: 'info' | 'warn';
  obj: Record<string, unknown>;
  msg: string;
}

interface CapturedPrompt {
  contents: RecoverableWebContents;
  info: Record<string, unknown>;
}

interface Rig {
  recovery: RendererRecovery;
  prompts: CapturedPrompt[];
  logs: LogLine[];
  advance: (ms: number) => void;
  drainDeferred: () => void;
  settlePrompts: () => Promise<void>;
}

function makeRig(opts?: {
  loopWindowMs?: number;
  maxAutoReloads?: number;
  maxLifetimeAutoReloads?: number;
}): Rig {
  let clockMs = Date.parse('2026-08-03T17:54:19.000Z');
  const prompts: CapturedPrompt[] = [];
  const logs: LogLine[] = [];
  const pendingPrompts: Array<() => void> = [];
  const deferred: Array<() => void> = [];
  const record = (level: 'info' | 'warn') => (obj: Record<string, unknown>, msg: string) => {
    logs.push({ level, obj, msg });
  };
  const recovery = createRendererRecovery({
    now: () => clockMs,
    logger: { info: record('info'), warn: record('warn') },
    defer: (fn) => {
      deferred.push(fn);
    },
    promptManualRecovery: (contents, info) => {
      prompts.push({ contents, info: info as unknown as Record<string, unknown> });
      return new Promise<void>((resolve) => {
        pendingPrompts.push(resolve);
      });
    },
    ...opts,
  });
  return {
    recovery,
    prompts,
    logs,
    advance: (ms: number) => {
      clockMs += ms;
    },
    drainDeferred: () => {
      for (const fn of deferred.splice(0)) fn();
    },
    settlePrompts: async () => {
      for (const resolve of pendingPrompts.splice(0)) resolve();
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}

const crashed: RenderProcessGoneDetails = { reason: 'crashed', exitCode: 5 };

describe('renderer crash recovery', () => {
  test('reloads a crashed renderer exactly once', () => {
    const rig = makeRig();
    const contents = makeContents();

    rig.recovery.handleRenderProcessGone(contents, crashed);
    rig.drainDeferred();

    expect(contents.reload).toHaveBeenCalledTimes(1);
    expect(rig.prompts).toHaveLength(0);
  });

  test('the reload never runs on the caller stack', () => {
    const rig = makeRig();
    const contents = makeContents();

    rig.recovery.handleRenderProcessGone(contents, crashed);

    expect(contents.reload).not.toHaveBeenCalled();

    rig.drainDeferred();
    expect(contents.reload).toHaveBeenCalledTimes(1);
  });

  test('a window closed during the deferral gap is not reloaded, and says so', () => {
    const rig = makeRig();
    const contents = makeContents();

    rig.recovery.handleRenderProcessGone(contents, crashed);
    contents.markDestroyed();
    rig.drainDeferred();

    expect(contents.reload).not.toHaveBeenCalled();
    expect(rig.logs.some((l) => l.obj.event === 'renderer-recovery.reload-abandoned')).toBe(true);
  });

  test.each([
    ['oom' as const],
    ['launch-failed' as const],
    ['integrity-failure' as const],
  ])('reloads on abnormal reason %s', (reason) => {
    const rig = makeRig();
    const contents = makeContents();

    rig.recovery.handleRenderProcessGone(contents, { reason, exitCode: 1 });
    rig.drainDeferred();

    expect(contents.reload).toHaveBeenCalledTimes(1);
  });

  test.each([
    ['clean-exit' as const],
    ['killed' as const],
    ['abnormal-exit' as const],
    ['memory-eviction' as const],
  ])('ignores non-crash exit reason %s, but logs it', (reason) => {
    const rig = makeRig();
    const contents = makeContents();

    rig.recovery.handleRenderProcessGone(contents, { reason, exitCode: 0 });
    rig.drainDeferred();

    expect(contents.reload).not.toHaveBeenCalled();
    expect(rig.prompts).toHaveLength(0);
    const ignored = rig.logs.find((l) => l.obj.event === 'renderer-recovery.ignored');
    expect(ignored?.obj).toMatchObject({ reason, contentsId: contents.id });
    const routine = reason === 'clean-exit' || reason === 'killed';
    expect(ignored?.level).toBe(routine ? 'info' : 'warn');
  });

  test('an async prompt rejection clears the flag and leaves a log line', async () => {
    const logs: LogLine[] = [];
    const record = (level: 'info' | 'warn') => (obj: Record<string, unknown>, msg: string) => {
      logs.push({ level, obj, msg });
    };
    let clockMs = 0;
    let calls = 0;
    const recovery = createRendererRecovery({
      now: () => clockMs,
      logger: { info: record('info'), warn: record('warn') },
      defer: (fn) => {
        fn();
      },
      promptManualRecovery: () => {
        calls += 1;
        return Promise.reject(new Error('dialog subsystem unavailable'));
      },
    });
    const contents = makeContents();

    recovery.handleRenderProcessGone(contents, crashed);
    clockMs += 1_000;
    recovery.handleRenderProcessGone(contents, crashed);
    await Promise.resolve();
    await Promise.resolve();

    expect(logs.some((l) => l.obj.event === 'renderer-recovery.prompt-failed')).toBe(true);

    clockMs += 1_000;
    recovery.handleRenderProcessGone(contents, crashed);
    expect(calls).toBe(2);
  });

  test('a repeat crash inside the loop window prompts instead of reloading again', () => {
    const rig = makeRig({ loopWindowMs: 60_000 });
    const contents = makeContents();

    rig.recovery.handleRenderProcessGone(contents, crashed);
    rig.drainDeferred();
    expect(contents.reload).toHaveBeenCalledTimes(1);

    rig.advance(5_000);
    rig.recovery.handleRenderProcessGone(contents, crashed);
    rig.drainDeferred();

    expect(contents.reload).toHaveBeenCalledTimes(1);
    expect(rig.prompts.map((p) => p.contents)).toEqual([contents]);
  });

  test('a crash exactly at the loop-window boundary is still inside the window', () => {
    const rig = makeRig({ loopWindowMs: 60_000 });
    const contents = makeContents();

    rig.recovery.handleRenderProcessGone(contents, crashed);
    rig.advance(60_000);
    rig.recovery.handleRenderProcessGone(contents, crashed);
    rig.drainDeferred();

    expect(contents.reload).toHaveBeenCalledTimes(1);
    expect(rig.prompts).toHaveLength(1);
  });

  test('a crash after the loop window elapses is a fresh incident and reloads again', () => {
    const rig = makeRig({ loopWindowMs: 60_000 });
    const contents = makeContents();

    rig.recovery.handleRenderProcessGone(contents, crashed);
    rig.advance(60_001);
    rig.recovery.handleRenderProcessGone(contents, crashed);
    rig.drainDeferred();

    expect(contents.reload).toHaveBeenCalledTimes(2);
    expect(rig.prompts).toHaveLength(0);
  });

  test('the lifetime cap stops a renderer that dies just outside the window forever', () => {
    const rig = makeRig({ loopWindowMs: 60_000, maxLifetimeAutoReloads: 3 });
    const contents = makeContents();

    for (let i = 0; i < 3; i++) {
      rig.recovery.handleRenderProcessGone(contents, crashed);
      rig.advance(60_001);
    }
    rig.drainDeferred();
    expect(contents.reload).toHaveBeenCalledTimes(3);
    expect(rig.prompts).toHaveLength(0);

    rig.recovery.handleRenderProcessGone(contents, crashed);
    rig.drainDeferred();

    expect(contents.reload).toHaveBeenCalledTimes(3);
    expect(rig.prompts).toHaveLength(1);
    expect(rig.logs.some((l) => l.obj.exhausted === 'lifetime')).toBe(true);
  });

  test('only one recovery prompt is open per webContents at a time', async () => {
    const rig = makeRig({ loopWindowMs: 60_000 });
    const contents = makeContents();

    rig.recovery.handleRenderProcessGone(contents, crashed);
    rig.advance(1_000);
    rig.recovery.handleRenderProcessGone(contents, crashed);
    rig.advance(1_000);
    rig.recovery.handleRenderProcessGone(contents, crashed);
    rig.drainDeferred();

    expect(rig.prompts).toHaveLength(1);
    expect(rig.logs.some((l) => l.obj.event === 'renderer-recovery.prompt-suppressed')).toBe(true);

    await rig.settlePrompts();
    rig.advance(1_000);
    rig.recovery.handleRenderProcessGone(contents, crashed);

    expect(rig.prompts).toHaveLength(2);
  });

  test('an open prompt suppresses auto-reload across a loop-window rollover', async () => {
    const rig = makeRig({ loopWindowMs: 60_000 });
    const contents = makeContents();

    rig.recovery.handleRenderProcessGone(contents, crashed);
    rig.advance(1_000);
    rig.recovery.handleRenderProcessGone(contents, crashed);
    rig.drainDeferred();
    expect(rig.prompts).toHaveLength(1);
    expect(contents.reload).toHaveBeenCalledTimes(1);

    rig.advance(60_001);
    rig.recovery.handleRenderProcessGone(contents, crashed);
    rig.drainDeferred();

    expect(contents.reload).toHaveBeenCalledTimes(1);
    expect(rig.prompts).toHaveLength(1);

    await rig.settlePrompts();
    rig.advance(1_000);
    rig.recovery.handleRenderProcessGone(contents, crashed);
    rig.drainDeferred();

    expect(contents.reload).toHaveBeenCalledTimes(2);
  });

  test('maxAutoReloads above 1 allows that many silent reloads before prompting', () => {
    const rig = makeRig({ loopWindowMs: 60_000, maxAutoReloads: 2 });
    const contents = makeContents();

    rig.recovery.handleRenderProcessGone(contents, crashed);
    rig.advance(1_000);
    rig.recovery.handleRenderProcessGone(contents, crashed);
    rig.advance(1_000);
    rig.recovery.handleRenderProcessGone(contents, crashed);
    rig.drainDeferred();

    expect(contents.reload).toHaveBeenCalledTimes(2);
    expect(rig.prompts).toHaveLength(1);
  });

  test('passes the crash context to the prompt', () => {
    const rig = makeRig({ loopWindowMs: 60_000 });
    const contents = makeContents();

    rig.recovery.handleRenderProcessGone(contents, crashed);
    rig.drainDeferred();
    rig.advance(1_000);
    rig.recovery.handleRenderProcessGone(contents, crashed);

    expect(rig.prompts[0]?.info).toMatchObject({
      reason: 'crashed',
      exitCode: 5,
      crashesInWindow: 2,
      lifetimeAutoReloads: 1,
      contentsId: contents.id,
    });
  });

  test('never reloads a destroyed webContents', () => {
    const rig = makeRig();
    const contents = makeContents();
    contents.markDestroyed();

    rig.recovery.handleRenderProcessGone(contents, crashed);
    rig.drainDeferred();

    expect(contents.reload).not.toHaveBeenCalled();
    expect(rig.prompts).toHaveLength(0);
  });

  test('a reload that throws is contained, not propagated', () => {
    const rig = makeRig();
    const contents = makeContents();
    contents.reload.mockImplementation(() => {
      throw new Error('Object has been destroyed');
    });

    rig.recovery.handleRenderProcessGone(contents, crashed);
    expect(() => rig.drainDeferred()).not.toThrow();

    expect(rig.logs.some((l) => l.obj.event === 'renderer-recovery.reload-failed')).toBe(true);
    expect(rig.prompts).toHaveLength(0);
  });

  test('a prompt that throws synchronously is contained and clears the pending flag', () => {
    let calls = 0;
    const logs: LogLine[] = [];
    const record = (level: 'info' | 'warn') => (obj: Record<string, unknown>, msg: string) => {
      logs.push({ level, obj, msg });
    };
    let clockMs = 0;
    const recovery = createRendererRecovery({
      now: () => clockMs,
      logger: { info: record('info'), warn: record('warn') },
      defer: (fn) => {
        fn();
      },
      promptManualRecovery: () => {
        calls += 1;
        throw new Error('dialog subsystem unavailable');
      },
    });
    const contents = makeContents();

    recovery.handleRenderProcessGone(contents, crashed);
    clockMs += 1_000;
    expect(() => recovery.handleRenderProcessGone(contents, crashed)).not.toThrow();
    expect(logs.some((l) => l.obj.event === 'renderer-recovery.prompt-failed')).toBe(true);

    clockMs += 1_000;
    recovery.handleRenderProcessGone(contents, crashed);
    expect(calls).toBe(2);
  });

  test('tracks each webContents independently', () => {
    const rig = makeRig();
    const first = makeContents();
    const second = makeContents();

    rig.recovery.handleRenderProcessGone(first, crashed);
    rig.recovery.handleRenderProcessGone(first, crashed);
    rig.recovery.handleRenderProcessGone(second, crashed);
    rig.drainDeferred();

    expect(first.reload).toHaveBeenCalledTimes(1);
    expect(second.reload).toHaveBeenCalledTimes(1);
    expect(rig.prompts.map((p) => p.contents)).toEqual([first]);
  });

  test('dispose releases per-contents state', () => {
    const rig = makeRig();
    const contents = makeContents();

    rig.recovery.handleRenderProcessGone(contents, crashed);
    rig.recovery.handleRenderProcessGone(contents, crashed);
    rig.drainDeferred();
    expect(rig.prompts).toHaveLength(1);

    rig.recovery.dispose(contents);
    rig.recovery.handleRenderProcessGone(contents, crashed);
    rig.drainDeferred();

    expect(contents.reload).toHaveBeenCalledTimes(2);
    expect(rig.prompts).toHaveLength(1);
  });

  test('logs the reload and the loop detection with the crash reason', () => {
    const rig = makeRig();
    const contents = makeContents();

    rig.recovery.handleRenderProcessGone(contents, crashed);
    rig.recovery.handleRenderProcessGone(contents, crashed);
    rig.drainDeferred();

    const events = rig.logs.map((l) => l.obj.event);
    expect(events).toContain('renderer-recovery.reloading');
    expect(events).toContain('renderer-recovery.loop-detected');
    for (const line of rig.logs) {
      expect(line.obj.reason).toBe('crashed');
      expect(line.obj.contentsId).toBe(contents.id);
    }
  });

  test('the reloading log reports the post-increment counters', () => {
    const rig = makeRig();
    const contents = makeContents();

    rig.recovery.handleRenderProcessGone(contents, crashed);
    rig.drainDeferred();

    const reloading = rig.logs.find((l) => l.obj.event === 'renderer-recovery.reloading');
    expect(reloading?.obj).toMatchObject({ autoReloads: 1, lifetimeAutoReloads: 1 });
  });
});

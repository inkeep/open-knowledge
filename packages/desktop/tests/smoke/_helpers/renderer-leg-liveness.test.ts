import { EventEmitter } from 'node:events';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BOOT_HEARTBEAT_EVENTS,
  DESKTOP_BOOT_EVENT,
  startupMarkLine,
} from '../../../src/shared/boot-narration.ts';
import {
  BOOT_LOG_CAP_MS,
  BOOT_LOG_HEARTBEAT_MS,
  BOOT_LOG_POLL_MS,
  BOOT_LOG_STALL_MS,
  bootGapLineFor,
  bootLogDirFor,
  bootNarrationFor,
  DECLARED_UTILITY_BUDGET_CEILING_MS,
  formatBootGapLine,
  readBootLog,
  readinessWorstCaseMs,
  readyWaitsFor,
  tryBootLogFor,
  tryFirstWaitFor,
  UTILITY_TIMEOUT_OBSERVATION_MARGIN_MS,
  type WaitForWindowOptions,
  waitForWindowByMode,
} from './launch-readiness.ts';

const homes: string[] = [];

class ConsolePage extends EventEmitter {
  mode = Promise.withResolvers<string | undefined>();
  evaluateCalls = 0;

  evaluate(): Promise<string | undefined> {
    this.evaluateCalls += 1;
    return this.mode.promise;
  }

  reportActivity(): void {
    this.emit('console', { type: () => 'log', text: () => 'renderer active' });
  }

  resetMode(): void {
    this.mode = Promise.withResolvers<string | undefined>();
  }
}

afterEach(() => {
  vi.useRealTimers();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

const stageAt = BOOT_LOG_CAP_MS - BOOT_LOG_STALL_MS / 2;
const firstRendererEventAt = stageAt + BOOT_LOG_STALL_MS - BOOT_LOG_POLL_MS;
const lateModeAnswerAt = stageAt + BOOT_LOG_STALL_MS + BOOT_LOG_HEARTBEAT_MS;
const startupMarkAt = { appReady: BOOT_LOG_HEARTBEAT_MS, loadUrlResolved: stageAt } as const;

function launchFixture(
  marks: readonly (keyof typeof startupMarkAt)[] = ['appReady', 'loadUrlResolved'],
) {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-01T00:00:00.000Z'));
  const home = mkdtempSync(join(tmpdir(), 'ok-renderer-liveness-'));
  homes.push(home);
  mkdirSync(bootLogDirFor(home), { recursive: true });
  const log = join(bootLogDirFor(home), 'desktop.renderer-leg.log');
  const write = (fields: Record<string, unknown>) =>
    appendFileSync(log, `${JSON.stringify({ time: new Date().toISOString(), ...fields })}\n`);
  const at = (when: number, action: () => void) => setTimeout(action, when);
  write({ event: DESKTOP_BOOT_EVENT });
  for (const mark of marks) {
    at(startupMarkAt[mark], () => write(startupMarkLine(mark, startupMarkAt[mark])));
  }

  let pages: { evaluate(): Promise<string | undefined> }[] = [];
  const app = { windows: () => pages };
  const setPages = (next: typeof pages) => {
    pages = next;
  };
  const wait = (options: Omit<WaitForWindowOptions, 'home'> = {}) =>
    waitForWindowByMode(app, 'editor', { home, ...options }).then(
      (page) => ({ kind: 'ready' as const, page }),
      (error: Error) => ({ kind: 'gave-up' as const, message: error.message }),
    );
  const lastWait = () => readyWaitsFor(app)?.at(-1);
  return { app, at, home, lastWait, setPages, wait, write };
}

type LaunchFixture = ReturnType<typeof launchFixture>;

function gaveUpLines(outcome: Awaited<ReturnType<LaunchFixture['wait']>>): string[] {
  return outcome.kind === 'gave-up' ? outcome.message.split('\n') : [];
}

function triageTokensOf(fixture: LaunchFixture): string[] {
  const firstWait = tryFirstWaitFor(fixture.app);
  return formatBootGapLine(
    bootGapLineFor({
      slot: 0,
      narration: bootNarrationFor(tryBootLogFor(fixture.app), readBootLog(fixture.home)),
      readyWaitCount: readyWaitsFor(fixture.app)?.length ?? 0,
      ...(firstWait === undefined ? {} : { firstWait }),
      homeShared: false,
    }),
  ).split(' ');
}

const utilityGrantAt = BOOT_LOG_HEARTBEAT_MS + BOOT_LOG_POLL_MS * 2;

function scheduleClosedUtilityGrant(fixture: ReturnType<typeof launchFixture>): void {
  fixture.at(BOOT_LOG_HEARTBEAT_MS, () =>
    fixture.write(startupMarkLine('serverSpawned', BOOT_LOG_HEARTBEAT_MS)),
  );
  fixture.at(utilityGrantAt, () =>
    fixture.write({
      event: BOOT_HEARTBEAT_EVENTS.utilityWait,
      elapsedMs: 0,
      initTimeoutMs: DECLARED_UTILITY_BUDGET_CEILING_MS,
    }),
  );
  fixture.at(utilityGrantAt + BOOT_LOG_POLL_MS, () =>
    fixture.write(startupMarkLine('serverLockReady', utilityGrantAt + BOOT_LOG_POLL_MS)),
  );
}

function scheduleMainHeartbeat(fixture: ReturnType<typeof launchFixture>, until: number): void {
  for (let at = BOOT_LOG_HEARTBEAT_MS; at < until; at += BOOT_LOG_HEARTBEAT_MS) {
    fixture.at(at, () =>
      fixture.write({
        event: BOOT_HEARTBEAT_EVENTS.boot,
        lastPhase: at >= stageAt ? 'loadUrlResolved' : 'appReady',
      }),
    );
  }
}

describe('renderer activity during first-window readiness', () => {
  it('keeps the pending mode probe alive while the renderer reports activity', async () => {
    const fixture = launchFixture();
    const editor = new ConsolePage();
    scheduleMainHeartbeat(fixture, lateModeAnswerAt);
    fixture.at(stageAt, () => fixture.setPages([editor]));
    fixture.at(firstRendererEventAt, () => editor.reportActivity());
    fixture.at(firstRendererEventAt + BOOT_LOG_POLL_MS * 2, () => editor.reportActivity());
    fixture.at(lateModeAnswerAt, () => editor.mode.resolve('editor'));

    const pending = fixture.wait();
    await vi.runAllTimersAsync();
    expect(await pending).toEqual({ kind: 'ready', page: editor });
  });

  it('gives up on a pending renderer when only main keeps narrating', async () => {
    const fixture = launchFixture();
    scheduleMainHeartbeat(fixture, lateModeAnswerAt);
    fixture.at(stageAt, () => fixture.setPages([new ConsolePage()]));

    const pending = fixture.wait();
    await vi.runAllTimersAsync();
    expect({ outcome: await pending, record: fixture.lastWait() }).toMatchObject({
      outcome: {
        kind: 'gave-up',
        message: expect.stringContaining('The last probe had not answered'),
      },
      record: { gaveUp: true, reason: 'cap' },
    });
  });

  it('diagnoses a launch that stops producing activity', async () => {
    const fixture = launchFixture([]);
    fixture.at(stageAt, () => fixture.setPages([new ConsolePage()]));

    const pending = fixture.wait();
    await vi.runAllTimersAsync();
    expect({ outcome: await pending, record: fixture.lastWait() }).toMatchObject({
      outcome: { kind: 'gave-up', message: expect.stringContaining('no new boot activity') },
      record: { gaveUp: true, reason: 'stall' },
    });
  });

  it('retains the failed page probe in the give-up diagnosis', async () => {
    const fixture = launchFixture();
    scheduleMainHeartbeat(fixture, lateModeAnswerAt);
    for (const at of [firstRendererEventAt, firstRendererEventAt + BOOT_LOG_POLL_MS * 2]) {
      fixture.at(at, () =>
        fixture.write({
          source: 'renderer-console',
          transport: 'electron',
          event: 'ok-terminal-sessions-host-state',
          attached: true,
        }),
      );
    }
    fixture.at(stageAt, () =>
      fixture.setPages([{ evaluate: () => Promise.reject(new Error('Renderer load failed')) }]),
    );

    const pending = fixture.wait();
    await vi.runAllTimersAsync();
    expect(await pending).toMatchObject({
      kind: 'gave-up',
      message: expect.stringContaining('Renderer load failed'),
    });
  });
});

describe('page-owned renderer activity', () => {
  it('keeps a silent boot wait alive until the pending editor mode is known', async () => {
    const fixture = launchFixture();
    const editor = new ConsolePage();
    fixture.setPages([editor]);
    fixture.at(firstRendererEventAt, () => editor.reportActivity());
    fixture.at(lateModeAnswerAt, () => editor.mode.resolve('editor'));

    const pending = fixture.wait();
    await vi.runAllTimersAsync();
    expect(await pending).toEqual({ kind: 'ready', page: editor });
  });

  it('does not borrow activity from a page already identified as another mode', async () => {
    const fixture = launchFixture();
    const navigator = new ConsolePage();
    const editor = new ConsolePage();
    navigator.mode.resolve('navigator');
    editor.mode.resolve('editor');
    fixture.setPages([navigator]);
    fixture.at(firstRendererEventAt, () => navigator.reportActivity());
    fixture.at(firstRendererEventAt + BOOT_LOG_POLL_MS * 2, () => navigator.reportActivity());
    fixture.at(lateModeAnswerAt, () => fixture.setPages([navigator, editor]));

    const pending = fixture.wait();
    await vi.runAllTimersAsync();
    expect(await pending).toMatchObject({ kind: 'gave-up' });
    expect(fixture.lastWait()).toMatchObject({ gaveUp: true, reason: 'stall' });
  });

  it('keeps two unknown Pages distinct when one later reports another mode', async () => {
    const fixture = launchFixture();
    const editor = new ConsolePage();
    const navigator = new ConsolePage();
    fixture.setPages([editor, navigator]);
    fixture.at(firstRendererEventAt - BOOT_LOG_HEARTBEAT_MS, () =>
      navigator.mode.resolve('navigator'),
    );
    fixture.at(firstRendererEventAt - BOOT_LOG_POLL_MS, () => navigator.reportActivity());
    fixture.at(firstRendererEventAt, () => editor.reportActivity());
    fixture.at(lateModeAnswerAt, () => editor.mode.resolve('editor'));

    const pending = fixture.wait();
    await vi.runAllTimersAsync();
    expect(await pending).toEqual({ kind: 'ready', page: editor });
    expect(editor.evaluateCalls).toBe(1);
  });

  it('does not borrow late activity from an initially unknown Page that classified wrong', async () => {
    const fixture = launchFixture();
    const editor = new ConsolePage();
    const navigator = new ConsolePage();
    fixture.setPages([editor, navigator]);
    fixture.at(firstRendererEventAt - BOOT_LOG_HEARTBEAT_MS, () =>
      navigator.mode.resolve('navigator'),
    );
    fixture.at(firstRendererEventAt, () => navigator.reportActivity());
    fixture.at(lateModeAnswerAt, () => editor.mode.resolve('editor'));

    const pending = fixture.wait();
    await vi.runAllTimersAsync();
    expect(await pending).toMatchObject({ kind: 'gave-up' });
    expect(navigator.evaluateCalls).toBeGreaterThan(0);
    expect(editor.evaluateCalls).toBe(1);
  });

  it('uses an activity receipt once, even when the mode probe stays pending', async () => {
    const fixture = launchFixture();
    const editor = new ConsolePage();
    fixture.setPages([editor]);
    fixture.at(stageAt + BOOT_LOG_POLL_MS, () => editor.reportActivity());
    fixture.at(lateModeAnswerAt, () => editor.mode.resolve('editor'));

    const pending = fixture.wait();
    await vi.runAllTimersAsync();
    expect(await pending).toMatchObject({ kind: 'gave-up' });
    expect(editor.evaluateCalls).toBe(1);
  });

  it('keeps the receipt timestamp when the next poll reads the activity later', async () => {
    const fixture = launchFixture();
    const editor = new ConsolePage();
    fixture.setPages([editor]);
    const pollMs = BOOT_LOG_POLL_MS * 7;
    fixture.at(stageAt + BOOT_LOG_POLL_MS / 2, () => editor.reportActivity());
    fixture.at(stageAt + BOOT_LOG_STALL_MS + (BOOT_LOG_POLL_MS * 3) / 4, () =>
      editor.mode.resolve('editor'),
    );

    const pending = fixture.wait({ pollMs });
    await vi.runAllTimersAsync();
    expect(await pending).toMatchObject({ kind: 'gave-up' });
  });

  it('does not revive an expired wait from an after-deadline Page event', async () => {
    const fixture = launchFixture();
    const editor = new ConsolePage();
    fixture.setPages([editor]);
    const pollMs = BOOT_LOG_POLL_MS * 7;
    let settled = false;
    let eventArrivedWhileWaiting = false;
    fixture.at(stageAt + BOOT_LOG_STALL_MS + pollMs / 4, () => {
      eventArrivedWhileWaiting = !settled;
      editor.reportActivity();
    });
    fixture.at(lateModeAnswerAt, () => editor.mode.resolve('editor'));
    const pending = fixture.wait({ pollMs }).then((outcome) => {
      settled = true;
      return outcome;
    });
    await vi.runAllTimersAsync();
    expect(eventArrivedWhileWaiting).toBe(true);
    expect(await pending).toMatchObject({ kind: 'gave-up' });
  });

  it('retains a before-deadline Page receipt when a later event arrives after the deadline', async () => {
    const fixture = launchFixture();
    const editor = new ConsolePage();
    fixture.setPages([editor]);
    scheduleMainHeartbeat(fixture, lateModeAnswerAt);
    fixture.at(firstRendererEventAt, () => editor.reportActivity());
    fixture.at(stageAt + BOOT_LOG_STALL_MS + BOOT_LOG_POLL_MS, () => editor.reportActivity());
    fixture.at(lateModeAnswerAt, () => editor.mode.resolve('editor'));

    const pending = fixture.wait({ pollMs: BOOT_LOG_POLL_MS * 7 });
    await vi.runAllTimersAsync();
    expect(await pending).toEqual({ kind: 'ready', page: editor });
  });

  it('reaches a late editor from Page activity before the initial cap without a later startup stage', async () => {
    const fixture = launchFixture(['appReady']);
    const editor = new ConsolePage();
    fixture.setPages([editor]);
    const modeAnswersAt = BOOT_LOG_CAP_MS + BOOT_LOG_HEARTBEAT_MS;
    for (let at = BOOT_LOG_HEARTBEAT_MS; at < modeAnswersAt; at += BOOT_LOG_HEARTBEAT_MS) {
      fixture.at(at, () =>
        fixture.write({ event: BOOT_HEARTBEAT_EVENTS.boot, lastPhase: 'appReady' }),
      );
    }
    fixture.at(BOOT_LOG_CAP_MS - BOOT_LOG_POLL_MS, () => editor.reportActivity());
    fixture.at(modeAnswersAt, () => editor.mode.resolve('editor'));

    const pending = fixture.wait();
    await vi.runAllTimersAsync();
    expect(await pending).toEqual({ kind: 'ready', page: editor });
  });

  it('keeps the latest eligible Page receipt after a newer donor leaves', async () => {
    const fixture = launchFixture();
    const editor = new ConsolePage();
    const departing = new ConsolePage();
    fixture.setPages([editor, departing]);
    fixture.at(stageAt + BOOT_LOG_POLL_MS, () => editor.reportActivity());
    fixture.at(firstRendererEventAt, () => departing.reportActivity());
    fixture.at(firstRendererEventAt + BOOT_LOG_POLL_MS / 2, () => fixture.setPages([editor]));
    fixture.at(lateModeAnswerAt, () => editor.mode.resolve('editor'));

    const pending = fixture.wait();
    await vi.runAllTimersAsync();
    expect(await pending).toEqual({ kind: 'ready', page: editor });
  });

  it('keeps a known wrong Page excluded after a later undefined mode result', async () => {
    const fixture = launchFixture();
    const navigator = new ConsolePage();
    const editor = new ConsolePage();
    let evaluations = 0;
    navigator.evaluate = async () => {
      evaluations += 1;
      return evaluations === 1 ? 'navigator' : undefined;
    };
    fixture.setPages([navigator, editor]);
    const modeAnswersAt = stageAt + BOOT_LOG_STALL_MS + BOOT_LOG_POLL_MS * 4;
    scheduleMainHeartbeat(fixture, modeAnswersAt);
    fixture.at(firstRendererEventAt, () => navigator.reportActivity());
    fixture.at(modeAnswersAt, () => editor.mode.resolve('editor'));

    const pending = fixture.wait();
    await vi.runAllTimersAsync();
    expect(evaluations).toBeGreaterThan(1);
    expect(editor.evaluateCalls).toBe(1);
    expect(await pending).toMatchObject({ kind: 'gave-up' });
  });
});

describe('renderer observation bounds and lifetime', () => {
  it('ends recurring renderer activity at the packaged backstop without a utility grant', async () => {
    const fixture = launchFixture();
    const editor = new ConsolePage();
    fixture.setPages([editor]);
    const packagedBound = readinessWorstCaseMs({ path: 'packaged' });
    for (let at = BOOT_LOG_HEARTBEAT_MS; at <= packagedBound; at += BOOT_LOG_HEARTBEAT_MS) {
      fixture.at(at, () => editor.reportActivity());
    }

    const pending = fixture.wait();
    await vi.runAllTimersAsync();
    expect(await pending).toMatchObject({ kind: 'gave-up' });
    expect(fixture.lastWait()).toMatchObject({
      gaveUp: true,
      reason: 'cap',
      capMs: packagedBound,
    });
  });

  it('keeps an accepted utility grant within the fork backstop', async () => {
    const fixture = launchFixture();
    const editor = new ConsolePage();
    fixture.setPages([editor]);
    scheduleClosedUtilityGrant(fixture);
    const forkBound = readinessWorstCaseMs({ path: 'fork' });
    for (let at = BOOT_LOG_HEARTBEAT_MS; at <= forkBound; at += BOOT_LOG_HEARTBEAT_MS) {
      fixture.at(at, () => editor.reportActivity());
    }

    const pending = fixture.wait();
    await vi.runAllTimersAsync();
    expect(await pending).toMatchObject({ kind: 'gave-up' });
    const record = fixture.lastWait();
    expect(record?.declaredGrantMs).toBeDefined();
    expect(record).toMatchObject({ gaveUp: true, reason: 'cap' });
    expect(record?.capMs).toBeGreaterThan(readinessWorstCaseMs({ path: 'packaged' }));
    expect(record?.capMs).toBeLessThanOrEqual(forkBound);
  });

  it('uses fresh Page activity to reach an editor after the utility grant expires', async () => {
    const fixture = launchFixture();
    const editor = new ConsolePage();
    fixture.setPages([editor]);
    scheduleClosedUtilityGrant(fixture);
    const grantExpiresAt =
      utilityGrantAt + DECLARED_UTILITY_BUDGET_CEILING_MS + UTILITY_TIMEOUT_OBSERVATION_MARGIN_MS;
    const modeAnswersAt = grantExpiresAt + BOOT_LOG_HEARTBEAT_MS;
    for (let at = BOOT_LOG_HEARTBEAT_MS; at <= modeAnswersAt; at += BOOT_LOG_HEARTBEAT_MS) {
      fixture.at(at, () => editor.reportActivity());
    }
    for (
      let at = utilityGrantAt + BOOT_LOG_HEARTBEAT_MS;
      at <= modeAnswersAt;
      at += BOOT_LOG_HEARTBEAT_MS
    ) {
      fixture.at(at, () =>
        fixture.write({ event: BOOT_HEARTBEAT_EVENTS.boot, lastPhase: 'loadUrlResolved' }),
      );
    }
    fixture.at(grantExpiresAt - BOOT_LOG_POLL_MS * 2, () => editor.reportActivity());
    fixture.at(modeAnswersAt, () => editor.mode.resolve('editor'));

    const pending = fixture.wait();
    await vi.runAllTimersAsync();
    expect(fixture.lastWait()?.declaredGrantMs).toBeDefined();
    expect(await pending).toEqual({ kind: 'ready', page: editor });
  });

  it('does not credit Page activity when liveness is none', async () => {
    const fixture = launchFixture();
    const editor = new ConsolePage();
    fixture.setPages([editor]);
    let listenersDuringWait = -1;
    fixture.at(firstRendererEventAt, () => {
      listenersDuringWait = editor.listenerCount('console');
      editor.reportActivity();
    });
    fixture.at(lateModeAnswerAt, () => editor.mode.resolve('editor'));

    const pending = fixture.wait({ liveness: 'none' });
    await vi.runAllTimersAsync();
    expect(await pending).toMatchObject({ kind: 'gave-up' });
    expect(editor.evaluateCalls).toBe(1);
    expect(listenersDuringWait).toBe(0);
  });

  it('removes Page listeners after success and does not inherit old activity on a later wait', async () => {
    const fixture = launchFixture();
    const editor = new ConsolePage();
    fixture.setPages([editor]);
    let registered = 0;
    fixture.at(BOOT_LOG_POLL_MS * 2, () => {
      registered = editor.listenerCount('console');
    });
    fixture.at(firstRendererEventAt, () => editor.reportActivity());
    fixture.at(lateModeAnswerAt, () => editor.mode.resolve('editor'));

    const first = fixture.wait();
    await vi.runAllTimersAsync();
    expect(await first).toEqual({ kind: 'ready', page: editor });
    expect(registered).toBeGreaterThan(0);
    expect(editor.listenerCount('console')).toBe(0);

    editor.resetMode();
    const second = fixture.wait();
    setTimeout(() => editor.mode.resolve('editor'), BOOT_LOG_CAP_MS + BOOT_LOG_HEARTBEAT_MS);
    await vi.runAllTimersAsync();
    expect(await second).toMatchObject({ kind: 'gave-up' });
    expect(editor.listenerCount('console')).toBe(0);
  });

  it('removes listeners after give-up and after a Page leaves the app', async () => {
    const fixture = launchFixture();
    const removed = new ConsolePage();
    const remaining = new ConsolePage();
    fixture.setPages([removed, remaining]);
    let registered = 0;
    let removedAfterPoll = -1;
    fixture.at(BOOT_LOG_POLL_MS * 2, () => {
      registered = removed.listenerCount('console');
    });
    const removedEventAt = firstRendererEventAt - BOOT_LOG_POLL_MS / 2;
    fixture.at(removedEventAt, () => removed.reportActivity());
    fixture.at(removedEventAt + BOOT_LOG_POLL_MS / 4, () => fixture.setPages([remaining]));
    fixture.at(firstRendererEventAt + BOOT_LOG_POLL_MS / 2, () => {
      removedAfterPoll = removed.listenerCount('console');
    });
    fixture.at(lateModeAnswerAt, () => remaining.mode.resolve('editor'));

    const pending = fixture.wait();
    await vi.runAllTimersAsync();
    expect(await pending).toMatchObject({ kind: 'gave-up' });
    expect(registered).toBeGreaterThan(0);
    expect(removedAfterPoll).toBe(0);
    expect(remaining.listenerCount('console')).toBe(0);
  });

  it('does not credit a Page removed before the cap decision reads its activity', async () => {
    const fixture = launchFixture();
    const removed = new ConsolePage();
    const later = new ConsolePage();
    fixture.setPages([removed]);
    const modeAnswersAt = stageAt + BOOT_LOG_STALL_MS + BOOT_LOG_POLL_MS * 20;
    scheduleMainHeartbeat(fixture, modeAnswersAt);
    let settled = false;
    let listenerAtEvent = 0;
    let removedWhileWaiting = false;
    fixture.at(firstRendererEventAt, () => {
      listenerAtEvent = removed.listenerCount('console');
      removed.reportActivity();
    });
    fixture.at(firstRendererEventAt + BOOT_LOG_POLL_MS / 2, () => {
      removedWhileWaiting = !settled;
      fixture.setPages([]);
    });
    fixture.at(stageAt + BOOT_LOG_STALL_MS + BOOT_LOG_POLL_MS * 6, () => fixture.setPages([later]));
    fixture.at(modeAnswersAt, () => later.mode.resolve('editor'));

    const pending = fixture.wait({ pollMs: BOOT_LOG_POLL_MS * 7 }).then((outcome) => {
      settled = true;
      return outcome;
    });
    await vi.runAllTimersAsync();
    expect(listenerAtEvent).toBeGreaterThan(0);
    expect(removedWhileWaiting).toBe(true);
    expect(await pending).toMatchObject({ kind: 'gave-up' });
    expect(removed.listenerCount('console')).toBe(0);
  });

  it('does not credit a Page classified wrong before the cap decision reads its activity', async () => {
    const fixture = launchFixture();
    const navigator = new ConsolePage();
    const later = new ConsolePage();
    fixture.setPages([navigator]);
    const modeAnswersAt = stageAt + BOOT_LOG_STALL_MS + BOOT_LOG_POLL_MS * 20;
    scheduleMainHeartbeat(fixture, modeAnswersAt);
    let settled = false;
    let listenerAtEvent = 0;
    let classifiedWhileWaiting = false;
    fixture.at(firstRendererEventAt, () => {
      listenerAtEvent = navigator.listenerCount('console');
      navigator.reportActivity();
    });
    fixture.at(firstRendererEventAt + BOOT_LOG_POLL_MS / 2, () => {
      classifiedWhileWaiting = !settled;
      navigator.mode.resolve('navigator');
    });
    fixture.at(stageAt + BOOT_LOG_STALL_MS + BOOT_LOG_POLL_MS * 6, () =>
      fixture.setPages([navigator, later]),
    );
    fixture.at(modeAnswersAt, () => later.mode.resolve('editor'));

    const pending = fixture.wait({ pollMs: BOOT_LOG_POLL_MS * 7 }).then((outcome) => {
      settled = true;
      return outcome;
    });
    await vi.runAllTimersAsync();
    expect(listenerAtEvent).toBeGreaterThan(0);
    expect(classifiedWhileWaiting).toBe(true);
    expect(navigator.evaluateCalls).toBeGreaterThan(0);
    expect(await pending).toMatchObject({ kind: 'gave-up' });
  });

  it('drops old-launch credit without starting another evaluation on a pending Page', async () => {
    const fixture = launchFixture();
    const editor = new ConsolePage();
    fixture.setPages([editor]);
    let registered = 0;
    fixture.at(BOOT_LOG_POLL_MS * 2, () => {
      registered = editor.listenerCount('console');
    });
    fixture.at(firstRendererEventAt, () => editor.reportActivity());
    fixture.at(firstRendererEventAt + BOOT_LOG_POLL_MS, () =>
      fixture.write({ event: DESKTOP_BOOT_EVENT }),
    );
    fixture.at(lateModeAnswerAt, () => editor.mode.resolve('editor'));

    const pending = fixture.wait();
    await vi.runAllTimersAsync();
    expect(await pending).toMatchObject({ kind: 'gave-up' });
    expect(registered).toBeGreaterThan(0);
    expect(editor.evaluateCalls).toBe(1);
    expect(fixture.lastWait()).not.toHaveProperty('rendererActivityMs');
  });

  it('drops Page activity received just before a new launch is first read', async () => {
    const fixture = launchFixture();
    const editor = new ConsolePage();
    fixture.setPages([editor]);
    fixture.at(BOOT_LOG_CAP_MS - BOOT_LOG_POLL_MS / 2, () => editor.reportActivity());
    fixture.at(BOOT_LOG_CAP_MS - BOOT_LOG_POLL_MS / 4, () =>
      fixture.write({ event: DESKTOP_BOOT_EVENT }),
    );
    fixture.at(lateModeAnswerAt, () => editor.mode.resolve('editor'));

    const pending = fixture.wait();
    await vi.runAllTimersAsync();
    expect(await pending).toMatchObject({ kind: 'gave-up' });
    expect(editor.evaluateCalls).toBe(1);
  });

  it('leaves an evaluate-only Page without renderer observation credit', async () => {
    const fixture = launchFixture();
    const mode = Promise.withResolvers<string | undefined>();
    const editor = { evaluate: () => mode.promise };
    fixture.setPages([editor]);
    fixture.at(firstRendererEventAt, () =>
      fixture.write({ source: 'renderer-console', event: 'renderer activity' }),
    );
    fixture.at(lateModeAnswerAt, () => mode.resolve('editor'));

    const pending = fixture.wait();
    await vi.runAllTimersAsync();
    expect(await pending).toMatchObject({ kind: 'gave-up' });
  });
});

describe('renderer activity attribution in the ready-wait record', () => {
  it('records the credited Page receipt when the cap fires with the mode probe pending', async () => {
    const fixture = launchFixture();
    const editor = new ConsolePage();
    fixture.setPages([editor]);
    fixture.at(firstRendererEventAt, () => editor.reportActivity());

    const pending = fixture.wait();
    await vi.runAllTimersAsync();
    const outcome = await pending;
    expect({ outcome, record: fixture.lastWait() }).toMatchObject({
      outcome: {
        kind: 'gave-up',
        message: expect.stringContaining('The last probe had not answered'),
      },
      record: { gaveUp: true, reason: 'cap' },
    });
    expect({
      record: fixture.lastWait(),
      lines: gaveUpLines(outcome),
      triage: triageTokensOf(fixture),
    }).toMatchObject({
      record: { rendererActivityMs: firstRendererEventAt },
      lines: expect.arrayContaining([
        `Last credited Page console activity: ${firstRendererEventAt}ms into the wait.`,
      ]),
      triage: expect.arrayContaining([`firstWaitRendererActivityMs=${firstRendererEventAt}`]),
    });
  });

  it('records the credited Page receipt when the launch stalls after it', async () => {
    const fixture = launchFixture([]);
    const editor = new ConsolePage();
    fixture.setPages([editor]);
    fixture.at(BOOT_LOG_HEARTBEAT_MS, () => editor.reportActivity());

    const pending = fixture.wait();
    await vi.runAllTimersAsync();
    const outcome = await pending;
    expect({ record: fixture.lastWait(), lines: gaveUpLines(outcome) }).toMatchObject({
      record: { gaveUp: true, reason: 'stall', rendererActivityMs: BOOT_LOG_HEARTBEAT_MS },
      lines: expect.arrayContaining([
        `Last credited Page console activity: ${BOOT_LOG_HEARTBEAT_MS}ms into the wait.`,
      ]),
    });
  });

  it('does not credit the boot log for a cap that only Page activity renewed', async () => {
    const fixture = launchFixture();
    const editor = new ConsolePage();
    editor.mode.resolve(undefined);
    fixture.setPages([editor]);
    const packagedBound = readinessWorstCaseMs({ path: 'packaged' });
    let lastActivityAt = 0;
    for (let at = BOOT_LOG_HEARTBEAT_MS; at < packagedBound; at += BOOT_LOG_HEARTBEAT_MS) {
      fixture.at(at, () => editor.reportActivity());
      lastActivityAt = at;
    }

    const pending = fixture.wait();
    await vi.runAllTimersAsync();
    const outcome = await pending;
    expect({ outcome, record: fixture.lastWait() }).toMatchObject({
      outcome: {
        kind: 'gave-up',
        message: expect.not.stringContaining('The last probe had not answered'),
      },
      record: { gaveUp: true, reason: 'cap' },
    });
    expect(editor.evaluateCalls).toBeGreaterThan(1);
    const lines = gaveUpLines(outcome);
    expect({ record: fixture.lastWait(), head: lines[0], lines }).toMatchObject({
      record: { rendererActivityMs: lastActivityAt },
      head: expect.stringMatching(/^editor window did not arrive within \d+ms\.$/),
      lines: expect.arrayContaining([
        `Last credited Page console activity: ${lastActivityAt}ms into the wait.`,
      ]),
    });
    expect(lines.join('\n')).not.toContain('though the app kept logging boot activity');
  });

  it('leaves a wait without credited Page activity unattributed', async () => {
    const fixture = launchFixture();
    const editor = new ConsolePage();
    fixture.setPages([editor]);
    let settled = false;
    let reportedWhileWaiting = false;
    fixture.at(firstRendererEventAt, () => {
      reportedWhileWaiting = !settled;
      editor.reportActivity();
    });

    const pending = fixture.wait({ liveness: 'none' }).then((outcome) => {
      settled = true;
      return outcome;
    });
    await vi.runAllTimersAsync();
    const outcome = await pending;
    expect(reportedWhileWaiting).toBe(true);
    expect({ outcome, record: fixture.lastWait() }).toMatchObject({
      outcome: { kind: 'gave-up', message: expect.not.stringContaining('Page console activity') },
      record: { gaveUp: true, reason: 'cap' },
    });
    expect(fixture.lastWait()).not.toHaveProperty('rendererActivityMs');
    expect(triageTokensOf(fixture)).toContain('firstWaitRendererActivityMs=none');
  });
});

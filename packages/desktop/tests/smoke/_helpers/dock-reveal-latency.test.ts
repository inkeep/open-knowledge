import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  DOCK_REVEAL_BUDGET_MS,
  DOCK_REVEAL_WATCH_CEILING_MS,
  type DockRevealSample,
  dockRevealProbe,
  measureDockRevealMs,
  readDockRevealElapsed,
  watchForDockReveal,
} from './dock-reveal-latency';

const ARMED_AT = 1_000;
const REVEAL_SPAN_MS = 5;
const SLOW_TRIGGER_MS = 120;
const UNIT_ID = 'dock-unit-terminal';
const ZERO_SIZE = { width: 0, height: 0 };
const SHOWN = { width: 1280, height: 300 };

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const armed = (over: Partial<DockRevealSample> = {}): DockRevealSample => ({
  at: ARMED_AT,
  revealed: false,
  ...over,
});

interface FakeUnit {
  box: { width: number; height: number };
  visibility: string;
  passesCheckVisibility: boolean;
}

const fakeUnit = (over: Partial<FakeUnit> = {}): FakeUnit => ({
  box: { ...SHOWN },
  visibility: 'visible',
  passesCheckVisibility: true,
  ...over,
});

const neverShownUnit = (): FakeUnit =>
  fakeUnit({ box: { ...ZERO_SIZE }, passesCheckVisibility: false });

function mountFakeRenderer(unit: FakeUnit | null, clock: { now: number }) {
  const element =
    unit === null
      ? null
      : {
          checkVisibility: () => unit.passesCheckVisibility,
          getBoundingClientRect: () => unit.box,
        };
  vi.stubGlobal('document', {
    getElementById: (id: string) => (id === UNIT_ID ? element : null),
  });
  vi.stubGlobal('getComputedStyle', () => ({ visibility: unit?.visibility ?? 'hidden' }));
  vi.stubGlobal('performance', { now: () => clock.now });
}

describe('dock reveal measurement', () => {
  const stubSteps = (over: Partial<Parameters<typeof measureDockRevealMs>[0]> = {}) => ({
    armProbe: () => Promise.resolve(armed()),
    watchForReveal: () => Promise.resolve(ARMED_AT + REVEAL_SPAN_MS),
    triggerReveal: () => Promise.resolve(),
    ...over,
  });

  test('starts watching before the toggle is dispatched', async () => {
    const order: string[] = [];

    await measureDockRevealMs(
      stubSteps({
        watchForReveal: () => {
          order.push('watch');
          return Promise.resolve(ARMED_AT + REVEAL_SPAN_MS);
        },
        triggerReveal: () => {
          order.push('trigger');
          return Promise.resolve();
        },
      }),
    );

    expect(order).toEqual(['watch', 'trigger']);
  });

  test('reports the stamp itself, whatever the trigger costs', async () => {
    const startedAt = Date.now();

    const measured = await measureDockRevealMs(
      stubSteps({
        watchForReveal: () => Promise.resolve(ARMED_AT + REVEAL_SPAN_MS),
        triggerReveal: () => sleep(SLOW_TRIGGER_MS),
      }),
    );

    expect(measured).toBe(REVEAL_SPAN_MS);
    expect(measured).toBeLessThan(Date.now() - startedAt);
  });

  test('reports the same span whether the trigger returns promptly or late', async () => {
    const measureWithTrigger = (triggerMs: number): Promise<number> =>
      measureDockRevealMs(stubSteps({ triggerReveal: () => sleep(triggerMs) }));

    expect(await measureWithTrigger(0)).toBe(await measureWithTrigger(SLOW_TRIGGER_MS));
  });

  test('surfaces a trigger failure as itself, not as a reveal timeout', async () => {
    await expect(
      measureDockRevealMs(
        stubSteps({
          watchForReveal: () => new Promise<number>(() => {}),
          triggerReveal: () => Promise.reject(new Error('View menu is missing the Terminal item')),
        }),
      ),
    ).rejects.toThrow(/View menu is missing the Terminal item/u);
  });

  test('an abandoned watch cannot resurface as an unhandled rejection', async () => {
    await expect(
      measureDockRevealMs(
        stubSteps({
          watchForReveal: () =>
            new Promise<number>((_resolve, reject) => {
              setTimeout(() => reject(new Error('watch abandoned after the trigger failed')), 10);
            }),
          triggerReveal: () => Promise.reject(new Error('View menu item missing')),
        }),
      ),
    ).rejects.toThrow(/View menu item missing/u);

    await sleep(60);
  });

  test('reports the abandoned watch reason without displacing the trigger failure', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      await expect(
        measureDockRevealMs(
          stubSteps({
            watchForReveal: () => Promise.reject(new Error('dock unit never mounted')),
            triggerReveal: () =>
              new Promise<void>((_resolve, reject) => {
                setTimeout(() => reject(new Error('View menu item missing')), 0);
              }),
          }),
        ),
      ).rejects.toThrow(/View menu item missing/u);

      expect(warn).toHaveBeenCalledWith(expect.stringContaining('dock unit never mounted'));
    } finally {
      warn.mockRestore();
    }
  });

  test('does not report a watch failure the thrown error already carries', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      await expect(
        measureDockRevealMs(
          stubSteps({
            watchForReveal: () =>
              Promise.reject(new Error('ended without a stamp inside its ceiling')),
            triggerReveal: () => Promise.resolve(),
          }),
        ),
      ).rejects.toThrow(/ended without a stamp inside its ceiling/u);

      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  test('refuses a vacuous reading before it watches or dispatches anything', async () => {
    let watches = 0;
    let triggers = 0;

    await expect(
      measureDockRevealMs(
        stubSteps({
          armProbe: () => Promise.resolve(armed({ revealed: true })),
          watchForReveal: () => {
            watches += 1;
            return Promise.resolve(ARMED_AT);
          },
          triggerReveal: () => {
            triggers += 1;
            return Promise.resolve();
          },
        }),
      ),
    ).rejects.toThrow(/already revealed when the probe was armed/u);

    expect([watches, triggers]).toEqual([0, 0]);
  });

  test('refuses a non-finite arm mark before it watches or dispatches anything', async () => {
    let watches = 0;
    let triggers = 0;

    await expect(
      measureDockRevealMs(
        stubSteps({
          armProbe: () => Promise.resolve(armed({ at: Number.NaN })),
          watchForReveal: () => {
            watches += 1;
            return Promise.resolve(0);
          },
          triggerReveal: () => {
            triggers += 1;
            return Promise.resolve();
          },
        }),
      ),
    ).rejects.toThrow(/non-finite mark/u);

    expect([watches, triggers]).toEqual([0, 0]);
  });

  test('refuses a reveal stamped before the probe armed', () => {
    const reading = readDockRevealElapsed(ARMED_AT, ARMED_AT - 1);
    expect(reading.revealed === false && reading.reason).toMatch(/before the probe armed/u);
  });

  test('refuses a non-finite stamp rather than reporting NaN as a measurement', () => {
    const reading = readDockRevealElapsed(ARMED_AT, Number.NaN);
    expect(reading.revealed === false && reading.reason).toMatch(/non-finite/u);
  });
});

describe('dock reveal probe reads the unit the way Playwright does', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('a unit that was never shown is not revealed, though it is in the DOM', () => {
    mountFakeRenderer(neverShownUnit(), { now: ARMED_AT });

    expect(dockRevealProbe(['arm', UNIT_ID])).toEqual({ at: ARMED_AT, revealed: false });
  });

  test('a unit shown at arm time is reported as already revealed', () => {
    mountFakeRenderer(fakeUnit(), { now: ARMED_AT });

    expect(dockRevealProbe(['arm', UNIT_ID])).toEqual({ at: ARMED_AT, revealed: true });
  });

  test('a poll against a unit that is still not shown yields no stamp', () => {
    mountFakeRenderer(neverShownUnit(), { now: ARMED_AT });

    expect(dockRevealProbe(['poll', UNIT_ID])).toBe(false);
  });

  test('a poll stamps the first frame the unit shows, without watching for a DOM mutation', () => {
    const clock = { now: ARMED_AT };
    const unit = neverShownUnit();
    mountFakeRenderer(unit, clock);

    expect(dockRevealProbe(['poll', UNIT_ID])).toBe(false);

    clock.now = ARMED_AT + REVEAL_SPAN_MS;
    unit.passesCheckVisibility = true;
    unit.box = { ...SHOWN };

    expect(dockRevealProbe(['poll', UNIT_ID])).toEqual({
      at: ARMED_AT + REVEAL_SPAN_MS,
      revealed: true,
    });
  });

  test('a unit turned off keeps its last size but is not revealed while it is invisible', () => {
    mountFakeRenderer(fakeUnit({ visibility: 'hidden' }), { now: ARMED_AT });

    expect(dockRevealProbe(['poll', UNIT_ID])).toBe(false);
  });

  test('a sized unit that fails checkVisibility is not revealed', () => {
    mountFakeRenderer(fakeUnit({ passesCheckVisibility: false }), { now: ARMED_AT });

    expect(dockRevealProbe(['poll', UNIT_ID])).toBe(false);
  });

  test('a zero-size unit that passes checkVisibility is not revealed', () => {
    mountFakeRenderer(fakeUnit({ box: { ...ZERO_SIZE } }), { now: ARMED_AT });

    expect(dockRevealProbe(['poll', UNIT_ID])).toBe(false);
  });

  test('an absent unit is not revealed', () => {
    mountFakeRenderer(null, { now: ARMED_AT });

    expect(dockRevealProbe(['poll', UNIT_ID])).toBe(false);
  });
});

describe('dock reveal watch budget', () => {
  const pageWithNoWait = {
    waitForFunction: () => Promise.reject(new Error('waitForFunction must not be reached')),
  } as unknown as Parameters<typeof watchForDockReveal>[0];

  test.each([
    ['a negative ceiling', -1],
    ['a zero ceiling', 0],
    ['a NaN ceiling', Number.NaN],
  ])('rejects %s by naming the contract, not an already-elapsed deadline', async (_label, ms) => {
    await expect(watchForDockReveal(pageWithNoWait, UNIT_ID, ms)).rejects.toThrow(
      /positive ceiling/u,
    );
  });

  test('holds the watch ceiling above the asserted budget, so an over-budget reveal is measured rather than timed out', () => {
    expect(DOCK_REVEAL_WATCH_CEILING_MS).toBeGreaterThan(DOCK_REVEAL_BUDGET_MS);
  });

  test('names the ceiling and the unit when the watch ends with no stamp', async () => {
    const pageThatNeverReveals = {
      waitForFunction: () => Promise.reject(new Error('Timeout 2000ms exceeded')),
    } as unknown as Parameters<typeof watchForDockReveal>[0];

    await expect(watchForDockReveal(pageThatNeverReveals, UNIT_ID, 2000)).rejects.toThrow(
      /dock-unit-terminal.*2000 ms ceiling/su,
    );
  });

  test('a read that fails after the stamp exists is not reported as a missing stamp', async () => {
    const destroyed = 'Execution context was destroyed, most likely because of a navigation';
    const pageLosingItsContext = {
      waitForFunction: () =>
        Promise.resolve({ jsonValue: () => Promise.reject(new Error(destroyed)) }),
    } as unknown as Parameters<typeof watchForDockReveal>[0];

    const failure = await watchForDockReveal(pageLosingItsContext, UNIT_ID, 2000).then(
      () => new Error('the watch resolved where it had to reject'),
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe(destroyed);
  });

  test('refuses a falsy poll sample in its own words rather than as a non-finite mark', async () => {
    const pageResolvingFalse = {
      waitForFunction: () => Promise.resolve({ jsonValue: () => Promise.resolve(false) }),
    } as unknown as Parameters<typeof watchForDockReveal>[0];

    await expect(watchForDockReveal(pageResolvingFalse, UNIT_ID, 2000)).rejects.toThrow(
      /resolved on a falsy sample for #dock-unit-terminal/u,
    );
  });
});

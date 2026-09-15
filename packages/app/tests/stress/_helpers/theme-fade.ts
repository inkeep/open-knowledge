import type { Page } from '@playwright/test';

const FADE_REPORT_TIMEOUT_MS = process.env.CI ? 15_000 : 5_000;
const SEQUENTIAL_REPORT_SENTINELS = 2;
export const FADE_REPORT_WINDOW_MS = FADE_REPORT_TIMEOUT_MS * SEQUENTIAL_REPORT_SENTINELS;
export const FADE_DURATION_MS = 200;

type ThemeFadeStart = 'run' | 'timeout';
export type ThemeFadeSettle = 'end' | 'cancel' | 'timeout';

export interface ThemeFadeReport<K extends string> {
  token: string;
  settle: ThemeFadeSettle;
  durationMs: number;
  beforeClick: Record<K, string>;
  atFadeStart: Record<K, string>;
  atMidpoint: Record<K, string>;
  afterSettle: Record<K, string>;
}

export interface ArmedThemeFade<K extends string> {
  report(): Promise<ThemeFadeReport<K>>;
}

export interface ThemeFadeProbeOptions<K extends string> {
  token: string;
  read: Record<K, () => string>;
}

export interface ThemeFadeProbeWindow {
  armThemeFade?<K extends string>(options: ThemeFadeProbeOptions<K>): ArmedThemeFade<K>;
}

export async function installThemeFadeProbe(page: Page): Promise<void> {
  await page.evaluate((reportTimeoutMs: number) => {
    const root = document.documentElement;

    const readAll = <K extends string>(read: Record<K, () => string>): Record<K, string> => {
      const values = {} as Record<K, string>;
      for (const key of Object.keys(read) as K[]) values[key] = read[key]();
      return values;
    };

    const isTransition = (animation: Animation): animation is CSSTransition =>
      'transitionProperty' in animation;

    const transitionFor =
      (token: string) =>
      (animation: Animation): animation is CSSTransition =>
        isTransition(animation) && animation.transitionProperty === token;

    const runningTransitions = (): string[] =>
      root
        .getAnimations({ subtree: false })
        .filter(isTransition)
        .map((transition) => transition.transitionProperty);

    (window as typeof window & ThemeFadeProbeWindow).armThemeFade = <K extends string>({
      token,
      read,
    }: ThemeFadeProbeOptions<K>): ArmedThemeFade<K> => {
      const timeoutMs = reportTimeoutMs;
      type Capture =
        | { matched: false; reason: string }
        | { matched: true; transition: CSSTransition; durationMs: number; delayMs: number };
      let captured: Capture = { matched: false, reason: 'no transition was captured' };
      let resolveStart!: (value: ThemeFadeStart) => void;
      const started = new Promise<ThemeFadeStart>((resolve) => {
        resolveStart = resolve;
      });
      let resolveSettle!: (value: ThemeFadeSettle) => void;
      const settled = new Promise<ThemeFadeSettle>((resolve) => {
        resolveSettle = resolve;
      });

      const lifetime = new AbortController();
      let startTimer = 0;
      let settleTimer = 0;
      let reported = false;
      const teardown = () => {
        window.clearTimeout(startTimer);
        window.clearTimeout(settleTimer);
        lifetime.abort();
      };

      const onRun = (event: TransitionEvent) => {
        if (event.target !== root || event.propertyName !== token) return;
        window.clearTimeout(startTimer);
        const match = root.getAnimations({ subtree: false }).find(transitionFor(token));
        const timing = match?.effect?.getComputedTiming();
        const duration = timing?.duration;
        const delay = timing?.delay;
        if (!match) {
          captured = { matched: false, reason: 'no matching transition was running' };
        } else if (typeof duration !== 'number' || !Number.isFinite(duration)) {
          captured = {
            matched: false,
            reason: `the matching transition reported a non-finite duration ${String(duration)}`,
          };
        } else if (typeof delay !== 'number' || !Number.isFinite(delay)) {
          captured = {
            matched: false,
            reason: `the matching transition reported a non-finite delay ${String(delay)}`,
          };
        } else {
          captured = { matched: true, transition: match, durationMs: duration, delayMs: delay };
        }
        resolveStart('run');
      };
      const onSettle = (event: TransitionEvent) => {
        if (event.target !== root || event.propertyName !== token) return;
        resolveSettle(event.type === 'transitioncancel' ? 'cancel' : 'end');
        teardown();
      };

      const beforeClick = readAll(read);
      const failureState = () =>
        JSON.stringify({ runningTransitions: runningTransitions(), beforeClick });
      root.addEventListener('transitionrun', onRun, { signal: lifetime.signal });
      root.addEventListener('transitionend', onSettle, { signal: lifetime.signal });
      root.addEventListener('transitioncancel', onSettle, { signal: lifetime.signal });
      startTimer = window.setTimeout(() => {
        resolveStart('timeout');
        teardown();
      }, timeoutMs);

      return {
        async report(): Promise<ThemeFadeReport<K>> {
          if (reported) {
            throw new Error(
              `report() for ${token} was already awaited; arm a new fade; ${failureState()}`,
            );
          }
          reported = true;
          try {
            if ((await started) !== 'run') {
              throw new Error(
                `theme fade for ${token} never started within ${timeoutMs}ms; ${failureState()}`,
              );
            }
            const capture = captured;
            if (!capture.matched) {
              throw new Error(
                `transitionrun fired for ${token} but ${capture.reason}; ${failureState()}`,
              );
            }
            settleTimer = window.setTimeout(() => resolveSettle('timeout'), timeoutMs);
            const { delayMs, durationMs, transition } = capture;
            transition.pause();
            transition.currentTime = 0;
            const atFadeStart = readAll(read);
            transition.currentTime = delayMs + durationMs / 2;
            const atMidpoint = readAll(read);
            transition.play();
            const settle = await settled;
            return {
              token,
              settle,
              durationMs,
              beforeClick,
              atFadeStart,
              atMidpoint,
              afterSettle: readAll(read),
            };
          } finally {
            teardown();
          }
        },
      };
    };
  }, FADE_REPORT_TIMEOUT_MS);
}

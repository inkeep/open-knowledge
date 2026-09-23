import type { Page } from '@playwright/test';

export const DOCK_REVEAL_BUDGET_MS = 2_000;
export const DOCK_REVEAL_WATCH_CEILING_MS = 5_000;

export interface DockRevealSample {
  at: number;
  revealed: boolean;
}

export type DockRevealReading =
  | { readonly revealed: false; readonly reason: string }
  | { readonly revealed: true; readonly elapsedMs: number };

export interface DockRevealSteps {
  armProbe: () => Promise<DockRevealSample>;
  watchForReveal: () => Promise<number>;
  triggerReveal: () => Promise<void>;
}

export function dockRevealProbe(args: readonly ['arm', string]): DockRevealSample;
export function dockRevealProbe(args: readonly ['poll', string]): DockRevealSample | false;
export function dockRevealProbe([mode, panelId]: readonly ['arm' | 'poll', string]):
  | DockRevealSample
  | false {
  const isRevealed = (element: Element | null): boolean => {
    if (element === null) return false;
    if (!element.checkVisibility()) return false;
    if (getComputedStyle(element).visibility !== 'visible') return false;
    const box = element.getBoundingClientRect();
    return box.width > 0 && box.height > 0;
  };
  const revealed = isRevealed(document.getElementById(panelId));
  if (mode === 'poll' && !revealed) return false;
  return { at: performance.now(), revealed };
}

export function readDockRevealElapsed(armedAt: number, stampedAt: number): DockRevealReading {
  const pending = (reason: string): DockRevealReading => ({ revealed: false, reason });
  if (!Number.isFinite(stampedAt)) {
    return pending(`terminal dock reveal stamped a non-finite mark ${stampedAt}`);
  }
  if (stampedAt < armedAt) {
    return pending(
      `terminal dock reveal stamped ${stampedAt}, before the probe armed at ${armedAt}`,
    );
  }
  return { revealed: true, elapsedMs: stampedAt - armedAt };
}

export async function measureDockRevealMs({
  armProbe,
  watchForReveal,
  triggerReveal,
}: DockRevealSteps): Promise<number> {
  const armed = await armProbe();
  if (armed.revealed) {
    throw new Error(
      'terminal dock was already revealed when the probe was armed, so the toggle revealed nothing',
    );
  }
  if (!Number.isFinite(armed.at)) {
    throw new Error(`dock reveal probe armed at a non-finite mark ${armed.at}`);
  }

  // STOP: the watch has to be polling before the toggle is dispatched. On every platform but darwin the trigger awaits an IPC round trip, and a watch started after it resolves reports that round trip as the reveal, which is the defect this helper exists to remove.
  const settled = watchForReveal().then(
    (stampedAt) => ({ stamped: true, stampedAt }) as const,
    (error: unknown) => ({ stamped: false, error }) as const,
  );
  try {
    await triggerReveal();
  } catch (triggerFailure) {
    void settled.then((abandoned) => {
      if (abandoned.stamped) return;
      const reason =
        abandoned.error instanceof Error ? abandoned.error.message : String(abandoned.error);
      console.warn(`[dock-reveal] terminal dock reveal watch failed: ${reason}`);
    });
    throw triggerFailure;
  }

  const outcome = await settled;
  if (!outcome.stamped) throw outcome.error;
  const reading = readDockRevealElapsed(armed.at, outcome.stampedAt);
  if (!reading.revealed) throw new Error(reading.reason);
  return reading.elapsedMs;
}

export async function armDockRevealProbe(page: Page, panelId: string): Promise<DockRevealSample> {
  const sample = await page.evaluate(dockRevealProbe, ['arm', panelId] as const);
  if (sample === false) {
    throw new Error(
      `dock reveal probe returned no arm sample for #${panelId}; arm mode always returns one, so the renderer ran a different probe than this module ships`,
    );
  }
  return sample;
}

export async function watchForDockReveal(
  page: Page,
  panelId: string,
  ceilingMs: number,
): Promise<number> {
  if (!(ceilingMs > 0)) {
    throw new Error(
      `watchForDockReveal needs a positive ceiling; received ${ceilingMs}. ` +
        `waitForFunction({ timeout: 0 }) waits without a deadline and fails as an unattributable test timeout.`,
    );
  }
  const handle = await page
    .waitForFunction(dockRevealProbe, ['poll', panelId] as const, {
      polling: 'raf',
      timeout: ceilingMs,
    })
    .catch((cause: unknown): never => {
      throw new Error(
        `terminal dock reveal watch on #${panelId} ended without a stamp inside its ${ceilingMs} ms ceiling`,
        { cause },
      );
    });
  const sample = await handle.jsonValue();
  if (sample === false) {
    throw new Error(
      `dock reveal poll resolved on a falsy sample for #${panelId}; waitForFunction resolves only on a truthy result, so the renderer ran a different probe than this module ships`,
    );
  }
  return sample.at;
}

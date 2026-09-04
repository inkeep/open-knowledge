import { expect } from '@playwright/test';
import { buildInputReadyProbe } from './terminal-smoke-shell';

const WINDOWS_SETTLE_BUDGET_DIVISOR = 3;

export async function waitForShellReady(
  readTerminalText: () => Promise<string>,
  sendTerminalCommand: (command: string) => Promise<void>,
  {
    timeout = 30_000,
    quietPolls = 3,
    interval = 250,
    platform = process.platform,
    resetTerminalInput,
  }: WaitForShellReadyOptions = {},
): Promise<void> {
  if (platform === 'win32') {
    if (resetTerminalInput === undefined) {
      throw new Error('Windows shell readiness requires resetTerminalInput');
    }
    const startedAt = Date.now();
    await settleTerminalTextBestEffort(
      readTerminalText,
      Math.floor(timeout / WINDOWS_SETTLE_BUDGET_DIVISOR),
      quietPolls,
      interval,
    );

    const { marker, command: probe } = buildInputReadyProbe('win32');
    let attempted = false;
    const remainingTimeout = Math.max(interval, timeout - (Date.now() - startedAt));
    await expect(async () => {
      if ((await readTerminalText()).includes(marker)) return;

      if (attempted) {
        await resetTerminalInput();
      }
      attempted = true;
      await sendTerminalCommand(probe);
      expect(await readTerminalText()).toContain(marker);
    }).toPass({ timeout: remainingTimeout, intervals: [interval] });
    return;
  }

  await waitForQuietTerminalText(readTerminalText, timeout, quietPolls, interval);
}

async function settleTerminalTextBestEffort(
  readTerminalText: () => Promise<string>,
  timeout: number,
  quietPolls: number,
  interval: number,
): Promise<void> {
  try {
    await waitForQuietTerminalText(readTerminalText, timeout, quietPolls, interval);
  } catch {
    return;
  }
}

async function waitForQuietTerminalText(
  readTerminalText: () => Promise<string>,
  timeout: number,
  quietPolls: number,
  interval: number,
): Promise<void> {
  let previous: string | null = null;
  let stable = 0;
  await expect(async () => {
    const current = (await readTerminalText()).replace(/\s+$/, '');
    stable = current.length > 0 && current === previous ? stable + 1 : 0;
    previous = current;
    expect(stable).toBeGreaterThanOrEqual(quietPolls);
  }).toPass({ timeout, intervals: [interval] });
}

export interface WaitForShellReadyOptions {
  timeout?: number;
  quietPolls?: number;
  interval?: number;
  platform?: NodeJS.Platform;
  resetTerminalInput?: () => Promise<void>;
}

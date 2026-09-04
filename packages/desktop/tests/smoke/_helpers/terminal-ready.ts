import { randomUUID } from 'node:crypto';
import { expect } from '@playwright/test';
import { terminalSmokeShellCommands } from './terminal-smoke-shell';

const WINDOWS_SETTLE_TIMEOUT_MS = 10_000;

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
    await waitForQuietTerminalText(
      readTerminalText,
      Math.min(timeout, WINDOWS_SETTLE_TIMEOUT_MS),
      quietPolls,
      interval,
    );

    const token = `OK_INPUT_READY_${randomUUID().replaceAll('-', '')}`;
    const marker = `${token}_42_READY`;
    const probe = terminalSmokeShellCommands('win32').arithmetic(token, 6, 7, 'READY');
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

import { expect } from '@playwright/test';
import {
  buildInputReadyProbe,
  WINDOWS_PRIMARY_PROMPT_AT_END,
  windowsPrimaryPromptAfter,
} from './terminal-smoke-shell';

export async function waitForShellReady(
  readTerminalText: () => Promise<string>,
  sendTerminalCommand: (command: string) => Promise<void>,
  {
    timeout = 30_000,
    quietPolls = 3,
    interval = 250,
    platform = process.platform,
  }: WaitForShellReadyOptions = {},
): Promise<void> {
  if (platform === 'win32') {
    const startedAt = Date.now();
    await waitForTerminalText(
      readTerminalText,
      WINDOWS_PRIMARY_PROMPT_AT_END,
      'PowerShell primary prompt',
      timeout,
      interval,
    );
    const firstPromptWaitMs = Date.now() - startedAt;
    const { marker, command } = buildInputReadyProbe('win32');
    await sendTerminalCommand(command);
    try {
      await waitForTerminalText(
        readTerminalText,
        windowsPrimaryPromptAfter(marker),
        'PowerShell primary prompt after the probe output',
        Math.max(interval, timeout - (Date.now() - startedAt)),
        interval,
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        `The post-probe prompt wait ended without a match; this waitForShellReady call's timeout is ${timeout} ms and its first-prompt wait took ${firstPromptWaitMs} ms.\n\n${reason}`,
        { cause: error },
      );
    }
    return;
  }

  await waitForQuietTerminalText(readTerminalText, timeout, quietPolls, interval);
}

async function waitForTerminalText(
  readTerminalText: () => Promise<string>,
  pattern: RegExp,
  label: string,
  timeout: number,
  interval: number,
): Promise<void> {
  await expect(async () => {
    expect(await readTerminalText(), label).toMatch(pattern);
  }).toPass({ timeout, intervals: [interval] });
}

export async function waitForTerminalOutput(
  readTerminalText: () => Promise<string>,
  expected: string,
  { stallMs }: WaitForTerminalOutputOptions,
): Promise<void> {
  const startedAt = performance.now();
  let lastText: string | undefined;
  let lastChangeSeenAt = startedAt;
  let reads = 0;
  let changes = 0;
  let slowestReadMs = 0;
  await expect
    .poll(
      async () => {
        const readStartedAt = performance.now();
        const text = await readTerminalText();
        const readEndedAt = performance.now();
        reads += 1;
        slowestReadMs = Math.max(slowestReadMs, readEndedAt - readStartedAt);
        if (text !== lastText) {
          lastText = text;
          lastChangeSeenAt = readEndedAt;
          changes += 1;
          return text;
        }
        const quietMs = readStartedAt - lastChangeSeenAt;
        if (quietMs < stallMs) return text;
        throw new Error(
          `The terminal output stopped advancing before it showed ${JSON.stringify(expected)}: it has not changed for ${Math.round(quietMs)} ms, which reaches this wait's declared stall window of ${stallMs} ms. It last changed ${Math.round(lastChangeSeenAt - startedAt)} ms after the wait began; the wait made ${reads} reads in ${Math.round(readEndedAt - startedAt)} ms, ${changes} of which changed the text, and its slowest read took ${Math.round(slowestReadMs)} ms. Last read: ${JSON.stringify(text)}`,
        );
      },
      { message: `the terminal output shows ${expected}`, timeout: 0 },
    )
    .toContain(expected);
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
    if (stable < quietPolls) {
      throw new Error(
        `terminal text quiet for ${stable} of ${quietPolls} polls; last read ${JSON.stringify(current)}`,
      );
    }
  }).toPass({ timeout, intervals: [interval] });
}

export interface WaitForShellReadyOptions {
  timeout?: number;
  quietPolls?: number;
  interval?: number;
  platform?: NodeJS.Platform;
}

export interface WaitForTerminalOutputOptions {
  stallMs: number;
}

import { expect } from '@playwright/test';

/**
 * Wait until the shell inside a terminal is ready to READ input.
 *
 * `data-terminal-status="running"` reports that the PTY spawned, not that the
 * shell behind it has reached its read loop. The shell may still be sourcing
 * profile scripts and printing startup notices — macOS CI runners emit the
 * bash-to-zsh migration banner. Keystrokes delivered during that window are
 * swallowed, so the row buffer ends up holding a prompt with no echo of the
 * command, and the caller times out waiting for output that never ran.
 *
 * Readiness is defined as "the buffer has printed something and then stopped
 * changing". That is deliberately prompt-shape agnostic: pinning a PS1 pattern
 * would break on bash vs zsh vs a themed prompt, and the quiet period is the
 * property that actually matters — it is the shell having finished startup.
 *
 * Callers pass their own reader because each terminal smoke test scopes to a
 * different section (docked, active, visible).
 */
export async function waitForShellReady(
  readTerminalText: () => Promise<string>,
  { timeout = 30_000, quietPolls = 3, interval = 250 }: WaitForShellReadyOptions = {},
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
  /** Overall budget before the shell is declared unusable. */
  timeout?: number;
  /** Consecutive unchanged reads required to call startup finished. */
  quietPolls?: number;
  /** Gap between reads. `quietPolls * interval` is the quiet period. */
  interval?: number;
}

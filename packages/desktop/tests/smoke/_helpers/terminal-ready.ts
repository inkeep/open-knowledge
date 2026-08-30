import { randomUUID } from 'node:crypto';
import { expect } from '@playwright/test';
import { terminalSmokeShellCommands } from './terminal-smoke-shell';

// Reserve most of the default Windows budget for the evaluated input probe;
// startup output settling is only the guard that makes sending that probe safe.
const WINDOWS_SETTLE_TIMEOUT_MS = 10_000;

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
 * POSIX readiness is a quiet buffer because prompt shapes vary across bash,
 * zsh, and themes. Windows first uses the same quiet-buffer gate so no probe or
 * reset lands while the process is still attaching its console reader. It then
 * avoids prompt matching because prompt shapes are shell- and theme-specific;
 * instead it proves PowerShell evaluated a randomized arithmetic command whose
 * result cannot occur in the echoed input.
 * These fixtures do not pin `terminal.shell`: this probe relies on the product
 * ladder landing on a PowerShell rung. That holds on `windows-latest` because
 * the PowerShell rungs probe absolute paths under `%ProgramFiles%` and
 * `%SystemRoot%` rather than searching PATH, so the restricted test PATH only
 * defeats the `pwsh`-on-PATH rung. A fallthrough to cmd fails this gate closed.
 * Do not copy the packaged ABI probe's deliberate ComSpec pin into these
 * rendered smokes. This typed probe is deliberately renderer-only: xterm
 * answers the device queries PowerShell emits during startup. The raw-PTY
 * harness has no terminal emulator to answer them, so it waits for a structured
 * launch marker without writing into ConPTY during startup.
 *
 * Callers pass their own reader and command sender because each terminal smoke
 * test scopes to a different section (docked, active, visible).
 */
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
      // Output can arrive after the send callback returns. Observe it before
      // cancelling the line so a slow but successful probe is not interrupted.
      if ((await readTerminalText()).includes(marker)) return;

      // A prior attempt can leave PowerShell at its continuation prompt when
      // only part of the command reached the line editor. Cancel that buffer
      // before retrying so probes do not compound into one malformed command.
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
  /** Overall budget; Windows shares it between startup settling and its evaluated probe. */
  timeout?: number;
  /** Consecutive unchanged reads required to call startup finished. */
  quietPolls?: number;
  /** Gap between reads. `quietPolls * interval` is the quiet period. */
  interval?: number;
  /** Override used by the cross-platform contract tests. */
  platform?: NodeJS.Platform;
  /** Cancel any partial Windows shell line before sending the next probe. */
  resetTerminalInput?: () => Promise<void>;
}

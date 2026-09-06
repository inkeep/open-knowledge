import { describe, expect, test } from 'vitest';
import { waitForShellReady } from './terminal-ready';

function evaluateArithmeticProbe(command: string): string {
  return command.replace(/\$\(\((\d+)\*(\d+)\)\)/u, (_match, left, right) =>
    String(Number(left) * Number(right)),
  );
}

describe('terminal smoke shell readiness', () => {
  test('requires evaluated Windows output instead of accepting the echoed probe', async () => {
    let text = '\u001b]0;C:\\Program Files\\PowerShell\\7\\pwsh.exe\u0007';
    const commands: string[] = [];
    const resets: number[] = [];
    let continuationPrompt = false;

    await waitForShellReady(
      () => Promise.resolve(text),
      (command) => {
        commands.push(command);
        if (continuationPrompt) {
          text += `\r\n>> ${command}`;
        } else if (commands.length === 1) {
          text += `\r\n>> ${command}`;
          continuationPrompt = true;
        } else {
          text += `\r\n${command}`;
          text += `\r\n${evaluateArithmeticProbe(command)}`;
        }
        return Promise.resolve();
      },
      {
        platform: 'win32',
        interval: 5,
        timeout: 1_000,
        resetTerminalInput: async () => {
          await Promise.resolve();
          resets.push(commands.length);
          continuationPrompt = false;
        },
      },
    );

    expect(commands).toHaveLength(2);
    expect(commands[0]).toBe(commands[1]);
    expect(resets).toEqual([1]);
  });

  test('holds the Windows reset clear of the pty-create window where U+0003 kills the shell', async () => {
    const MEASURED_SAFE_RESET_MS = 1_000;
    const TIMER_SLACK_MS = 10;
    const startedAt = Date.now();
    let text = 'PowerShell 7.6.5';
    let resetAtMs: number | null = null;

    await waitForShellReady(
      () => Promise.resolve(text),
      (command) => {
        if (resetAtMs !== null) text += `\r\n${evaluateArithmeticProbe(command)}`;
        return Promise.resolve();
      },
      {
        platform: 'win32',
        timeout: 10_000,
        resetTerminalInput: () => {
          resetAtMs ??= Date.now() - startedAt;
          return Promise.resolve();
        },
      },
    );

    expect(resetAtMs).toBeGreaterThan(MEASURED_SAFE_RESET_MS - TIMER_SLACK_MS);
  });

  test('observes delayed Windows output before cancelling a successful probe', async () => {
    let command = '';
    let readsAfterSend = 0;
    let commandsSent = 0;
    let resets = 0;

    await waitForShellReady(
      () => {
        if (command === '') return Promise.resolve('PowerShell startup');
        readsAfterSend += 1;
        if (readsAfterSend === 1) return Promise.resolve(command);
        return Promise.resolve(evaluateArithmeticProbe(command));
      },
      (nextCommand) => {
        commandsSent += 1;
        command = nextCommand;
        return Promise.resolve();
      },
      {
        platform: 'win32',
        interval: 5,
        timeout: 1_000,
        resetTerminalInput: () => {
          resets += 1;
          return Promise.resolve();
        },
      },
    );

    expect(commandsSent).toBe(1);
    expect(resets).toBe(0);
  });

  test('waits for rendered Windows startup output to settle before probing', async () => {
    let text = 'PowerShell starting';
    let reads = 0;
    let commandSentAtRead = 0;

    await waitForShellReady(
      () => {
        reads += 1;
        if (reads === 2) text += ' profile loaded';
        return Promise.resolve(text);
      },
      (command) => {
        commandSentAtRead = reads;
        text += `\r\n${evaluateArithmeticProbe(command)}`;
        return Promise.resolve();
      },
      {
        platform: 'win32',
        interval: 5,
        quietPolls: 2,
        timeout: 1_000,
        resetTerminalInput: () => Promise.resolve(),
      },
    );

    expect(commandSentAtRead).toBe(5);
  });

  test('probes anyway when rendered Windows output never settles', async () => {
    let text = 'PowerShell starting';
    let reads = 0;
    const commands: string[] = [];

    await waitForShellReady(
      () => {
        reads += 1;
        text += ` tick${reads}`;
        return Promise.resolve(text);
      },
      (command) => {
        commands.push(command);
        if (commands.length > 1) {
          text += `\r\n${evaluateArithmeticProbe(command)}`;
        }
        return Promise.resolve();
      },
      {
        platform: 'win32',
        interval: 5,
        timeout: 1_000,
        resetTerminalInput: () => Promise.resolve(),
      },
    );

    expect(commands).toHaveLength(2);
  });

  test('fails loud when a Windows caller omits the line reset', async () => {
    await expect(
      waitForShellReady(
        () => Promise.resolve(''),
        () => Promise.resolve(),
        {
          platform: 'win32',
        },
      ),
    ).rejects.toThrow(/requires resetTerminalInput/u);
  });

  test('still fails loud when the Windows probe is never evaluated', async () => {
    let text = 'PowerShell starting';
    const commands: string[] = [];
    await expect(
      waitForShellReady(
        () => Promise.resolve(text),
        (command) => {
          commands.push(command);
          text += `\r\n${command}`;
          return Promise.resolve();
        },
        {
          platform: 'win32',
          interval: 5,
          timeout: 200,
          resetTerminalInput: () => Promise.resolve(),
        },
      ),
    ).rejects.toThrow();
    expect(commands).not.toHaveLength(0);
  });

  test('still fails loud on POSIX when the buffer never settles', async () => {
    let reads = 0;
    await expect(
      waitForShellReady(
        () => {
          reads += 1;
          return Promise.resolve(`zsh tick${reads}`);
        },
        () => Promise.resolve(),
        { platform: 'darwin', interval: 5, timeout: 200 },
      ),
    ).rejects.toThrow();
    expect(reads).toBeGreaterThan(1);
  });

  test('retains the quiet-buffer readiness contract on POSIX', async () => {
    let text = 'shell startup';
    let commandsSent = 0;
    const started = Date.now();
    const timer = setTimeout(() => {
      text += ' complete';
    }, 25);

    try {
      await waitForShellReady(
        () => Promise.resolve(text),
        () => {
          commandsSent += 1;
          return Promise.resolve();
        },
        { platform: 'linux', interval: 10, quietPolls: 3, timeout: 2_000 },
      );
      expect(commandsSent).toBe(0);
      expect(text).toContain('complete');
      expect(Date.now() - started).toBeGreaterThanOrEqual(55);
    } finally {
      clearTimeout(timer);
    }
  });
});

import { describe, expect, test } from 'vitest';
import { waitForShellReady } from './terminal-ready';

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
          text += `\r\n${command.replace(/\$\(\((\d+)\*(\d+)\)\)/u, (_match, left, right) =>
            String(Number(left) * Number(right)),
          )}`;
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
        return Promise.resolve(
          command.replace(/\$\(\((\d+)\*(\d+)\)\)/u, (_match, left, right) =>
            String(Number(left) * Number(right)),
          ),
        );
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
        text += `\r\n${command.replace(/\$\(\((\d+)\*(\d+)\)\)/u, (_match, left, right) =>
          String(Number(left) * Number(right)),
        )}`;
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

    // Two reads observe the buffer change, `quietPolls` matching reads clear
    // the gate, then one probe-phase read occurs before the first send.
    expect(commandSentAtRead).toBe(5);
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
      // The buffer goes quiet, then changes again, so `stable` is positive when
      // the mismatch arrives and a reset that merely held would resolve early.
      expect(Date.now() - started).toBeGreaterThanOrEqual(55);
    } finally {
      clearTimeout(timer);
    }
  });
});

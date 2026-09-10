import { describe, expect, test } from 'vitest';
import { harnessTerminalCli } from './harness-terminal-cli';

describe('harnessTerminalCli', () => {
  test('offers the CLI only when it is installed on this machine', () => {
    for (const installed of [true, false, undefined]) {
      expect({
        installed,
        cli: harnessTerminalCli('claude-acp', { claude: installed }, true),
      }).toEqual({ installed, cli: installed === true ? 'claude' : null });
    }
  });

  test('a machine with no terminal never gets the offer, however present the CLI', () => {
    expect(harnessTerminalCli('claude-acp', { claude: true }, false)).toBeNull();
  });

  test('an agent with no harness CLI of its own yields nothing', () => {
    expect(harnessTerminalCli('some-agent-with-no-cli', { claude: true }, true)).toBeNull();
  });

  test('the agent ids the registry maps all resolve to a launchable CLI', () => {
    expect(harnessTerminalCli('claude-acp', { claude: true }, true)).toBe('claude');
    expect(harnessTerminalCli('codex-acp', { codex: true }, true)).toBe('codex');
  });
});

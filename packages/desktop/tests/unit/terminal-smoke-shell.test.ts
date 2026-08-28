import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  seedTerminalShellProfiles,
  terminalSmokeEnvironment,
  terminalSmokeShellCommands,
  writeFakeClaudeShim,
} from '../smoke/_helpers/terminal-smoke-shell.ts';

const cleanup: string[] = [];

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  cleanup.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of cleanup.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('terminal smoke shell commands', () => {
  test('composes PowerShell commands without POSIX syntax', () => {
    const commands = terminalSmokeShellCommands('win32');

    expect(commands.cwd).toBe('Get-Location');
    expect(commands.arithmetic('HARNESS', 6, 7, 'DONE')).toBe(
      'Write-Output "HARNESS_$((6*7))_DONE"',
    );
    expect(commands.columns('COLS')).toBe('Write-Output "COLS=$($Host.UI.RawUI.WindowSize.Width)"');
    expect(commands.setEnvironment('OK_MARK', 'survived')).toBe("$env:OK_MARK='survived'");
    expect(commands.readEnvironment('OK_MARK', 'marker')).toBe(
      'Write-Output "marker=[$env:OK_MARK]"',
    );
    expect(commands.processId('SHELLPID')).toBe('Write-Output "SHELLPID=$PID"');
    expect(commands.oscTitle('program', 'OSC_FED')).toBe(
      '[Console]::Write("$([char]27)]0;program$([char]7)"); Write-Output \'OSC_FED\'',
    );
    expect(commands.scroll('START', 'FIRST', 'ROW_', 3)).toBe(
      "Write-Output 'START','FIRST'; 1..3 | ForEach-Object { 'ROW_{0:D3}' -f $_ }",
    );
  });

  test('keeps the existing POSIX command contracts on macOS and Linux', () => {
    for (const platform of ['darwin', 'linux'] as const) {
      const commands = terminalSmokeShellCommands(platform);
      expect(commands.cwd).toBe('pwd');
      expect(commands.arithmetic('HARNESS', 6, 7, 'DONE')).toBe('echo HARNESS_$((6*7))_DONE');
      expect(commands.columns('COLS')).toBe('echo COLS=$(tput cols)');
      expect(commands.setEnvironment('OK_MARK', 'survived')).toBe("export OK_MARK='survived'");
      expect(commands.readEnvironment('OK_MARK', 'marker')).toBe('echo "marker=[$OK_MARK]"');
      expect(commands.processId('SHELLPID')).toBe('printf \'SHELLPID=%s\\n\' "$$"');
    }
  });
});

describe('terminal smoke shell fixtures', () => {
  test('uses a hermetic Windows system PATH without adding a POSIX SHELL', () => {
    expect(
      terminalSmokeEnvironment('C:\\fixture-home', {
        platform: 'win32',
        env: { Path: 'C:\\developer-bin', SystemRoot: 'D:\\Windows' },
        pathPrefix: 'C:\\fixture-bin',
        restrictPath: true,
        pinPosixZsh: true,
      }),
    ).toEqual({
      HOME: 'C:\\fixture-home',
      USERPROFILE: 'C:\\fixture-home',
      Path: [
        'C:\\fixture-bin',
        'D:\\Windows\\System32',
        'D:\\Windows',
        'D:\\Windows\\System32\\WindowsPowerShell\\v1.0',
      ].join(';'),
    });
  });

  test('keeps the POSIX login-shell fixture and delimiter', () => {
    expect(
      terminalSmokeEnvironment('/tmp/fixture-home', {
        platform: 'linux',
        env: { PATH: '/developer/bin' },
        pathPrefix: '/tmp/fixture-bin',
        restrictPath: true,
        pinPosixZsh: true,
      }),
    ).toEqual({
      HOME: '/tmp/fixture-home',
      PATH: '/tmp/fixture-bin:/usr/bin:/bin:/usr/sbin:/sbin',
      SHELL: '/bin/zsh',
    });
  });

  test('writes executable shims for POSIX and PATHEXT-visible shims for Windows', () => {
    const posixBin = temporaryDirectory('ok-terminal-posix-shim-');
    const windowsBin = temporaryDirectory('ok-terminal-windows-shim-');

    const posixPath = writeFakeClaudeShim(posixBin, 'interactive', 'darwin');
    const windowsPath = writeFakeClaudeShim(windowsBin, 'interactive', 'win32');

    expect(posixPath).toBe(join(posixBin, 'claude'));
    expect(statSync(posixPath).mode & 0o111).not.toBe(0);
    expect(readFileSync(posixPath, 'utf8')).toContain('exec cat');
    expect(windowsPath).toBe(join(windowsBin, 'claude.cmd'));
    expect(readFileSync(windowsPath, 'utf8')).toContain('more.com');
  });

  test('writes login profiles only for POSIX shells', () => {
    const posixHome = temporaryDirectory('ok-terminal-posix-home-');
    const windowsHome = temporaryDirectory('ok-terminal-windows-home-');

    seedTerminalShellProfiles(
      posixHome,
      { pathPrefix: '/tmp/fake-bin', restrictPath: true },
      'linux',
    );
    seedTerminalShellProfiles(
      windowsHome,
      { pathPrefix: 'C:\\fake-bin', restrictPath: true },
      'win32',
    );

    expect(readFileSync(join(posixHome, '.zprofile'), 'utf8')).toBe(
      'export PATH="/tmp/fake-bin:/usr/bin:/bin:/usr/sbin:/sbin"\n',
    );
    expect(readFileSync(join(posixHome, '.zshrc'), 'utf8')).toBe(
      'export PATH="/tmp/fake-bin:/usr/bin:/bin:/usr/sbin:/sbin"\n',
    );
    expect(existsSync(join(windowsHome, '.zprofile'))).toBe(false);
    expect(existsSync(join(windowsHome, '.zshrc'))).toBe(false);
  });
});

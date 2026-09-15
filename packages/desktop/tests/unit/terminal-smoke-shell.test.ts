import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  readWindowsShellProfileFailure,
  seedTerminalShellProfiles,
  terminalSmokeEnvironment,
  terminalSmokeShellCommands,
  windowsPSReadLineHistoryPath,
  windowsPSReadLineStateCommand,
  windowsPSReadLineStateField,
  windowsShellProfileFailurePath,
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
    expect(commands.output('MARK_ONE')).toBe("Write-Output 'MARK_ONE'");
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
      expect(commands.output('MARK_ONE')).toBe("printf '%s\\n' 'MARK_ONE'");
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

  test('writes a zsh login profile for POSIX and no zsh profile for Windows', () => {
    const posixHome = temporaryDirectory('ok-terminal-posix-home-');
    const windowsHome = temporaryDirectory('ok-terminal-windows-home-');

    seedTerminalShellProfiles(
      posixHome,
      { posixPathPrefix: '/tmp/fake-bin', posixRestrictPath: true },
      'linux',
    );
    seedTerminalShellProfiles(
      windowsHome,
      { posixPathPrefix: 'C:\\fake-bin', posixRestrictPath: true },
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

  test('leaves the POSIX login PATH alone when no PATH option asks for it, and still seeds Windows', () => {
    const posixHome = temporaryDirectory('ok-terminal-posix-unpinned-');
    const posixFalse = temporaryDirectory('ok-terminal-posix-restrict-false-');
    const windowsHome = temporaryDirectory('ok-terminal-windows-unpinned-');

    seedTerminalShellProfiles(posixHome, {}, 'linux');
    seedTerminalShellProfiles(posixFalse, { posixRestrictPath: false }, 'linux');
    seedTerminalShellProfiles(windowsHome, {}, 'win32');

    expect(existsSync(join(posixHome, '.zprofile'))).toBe(false);
    expect(existsSync(join(posixHome, '.zshrc'))).toBe(false);
    expect(existsSync(join(posixFalse, '.zprofile'))).toBe(false);
    expect(existsSync(join(posixFalse, '.zshrc'))).toBe(false);
    expect(
      existsSync(join(windowsHome, 'Documents', 'PowerShell', 'Microsoft.PowerShell_profile.ps1')),
    ).toBe(true);
  });

  test('seeds a PowerShell profile that pins history per run, turns prediction off, and cannot write to the terminal, for both Windows shell rungs', () => {
    const windowsHome = temporaryDirectory('ok-terminal-windows-profile-');

    seedTerminalShellProfiles(windowsHome, {}, 'win32');

    for (const directory of ['PowerShell', 'WindowsPowerShell']) {
      const profile = readFileSync(
        join(windowsHome, 'Documents', directory, 'Microsoft.PowerShell_profile.ps1'),
        'utf8',
      );
      expect(profile.startsWith('\ufeff')).toBe(true);
      expect(profile).toContain(
        `Set-PSReadLineOption -HistorySavePath '${windowsPSReadLineHistoryPath(windowsHome)}'`,
      );
      expect(profile).toContain('Set-PSReadLineOption -PredictionSource None');
      expect(profile).toContain('Import-Module PSReadLine -ErrorAction SilentlyContinue');
    }
  });

  test('records a profile failure where the harness reads it back, never on the terminal', () => {
    const windowsHome = temporaryDirectory('ok-terminal-profile-failure-');
    const failurePath = windowsShellProfileFailurePath(windowsHome);
    cleanup.push(failurePath);

    seedTerminalShellProfiles(windowsHome, {}, 'win32');

    expect(readWindowsShellProfileFailure(windowsHome)).toEqual({ kind: 'absent' });

    const profile = readFileSync(
      join(windowsHome, 'Documents', 'PowerShell', 'Microsoft.PowerShell_profile.ps1'),
      'utf8',
    );
    expect(/Set-Content -LiteralPath '([^']*)'/.exec(profile)?.[1]).toBe(failurePath);

    const record = [
      'Set-PSReadLineOption : A parameter cannot be found that matches parameter name',
      "'PredictionSource'.",
      'At C:\\Users\\runner\\Documents\\PowerShell\\Microsoft.PowerShell_profile.ps1:7 char:26',
      '+       Set-PSReadLineOption -PredictionSource None',
      '    + CategoryInfo          : InvalidArgument: (:) [Set-PSReadLineOption], ParameterBindingException',
      '    + FullyQualifiedErrorId : NamedParameterNotFound,Microsoft.PowerShell.PSConsoleReadLine',
    ].join('\r\n');
    writeFileSync(failurePath, `\r\n${record}\r\n\r\n`);
    expect(readWindowsShellProfileFailure(windowsHome)).toEqual({ kind: 'record', text: record });

    writeFileSync(failurePath, ' \r\n\t\n');
    expect(readWindowsShellProfileFailure(windowsHome)).toEqual({ kind: 'absent' });
  });

  test('reports an unreadable failure record as unreadable, not as no record', () => {
    const windowsHome = temporaryDirectory('ok-terminal-profile-unreadable-');
    const failurePath = windowsShellProfileFailurePath(windowsHome);
    mkdirSync(failurePath, { recursive: true });
    cleanup.push(failurePath);

    const outcome = readWindowsShellProfileFailure(windowsHome);

    expect(outcome).toEqual({ kind: 'unreadable', code: 'EISDIR' });
  });

  test('keeps the profile failure record strictly inside the run home', () => {
    const relative = win32.relative('C:\\run-home', windowsShellProfileFailurePath('C:\\run-home'));

    expect(relative).toBe('ok-shell-profile-error.log');
  });

  test('keeps the PSReadLine history file strictly inside the run home', () => {
    const relative = win32.relative('C:\\run-home', windowsPSReadLineHistoryPath('C:\\run-home'));

    expect(relative).not.toBe('');
    expect(relative.startsWith('..')).toBe(false);
    expect(win32.isAbsolute(relative)).toBe(false);
  });

  test('builds a PSReadLine state probe that compares against the run home and never echoes its own marker', () => {
    const command = windowsPSReadLineStateCommand('PSRL_FIXED', 'C:\\run home');

    expect(command).not.toContain('PSRL_FIXED=');
    expect(command).toContain(
      "$okOptions.HistorySavePath.StartsWith('C:\\run home', [System.StringComparison]::OrdinalIgnoreCase)",
    );
    expect(command).toContain(
      "Write-Output ('PSRL_FIXED' + '=' + $okVersion + '|' + $okPrediction + '|' + $okHistory + '|' + 'END')",
    );
  });

  test('reads each state field only from a terminated probe line, ignoring glued neighbour rows', () => {
    const glued = 'PSRL_FIXED=2.4.5|None|True|ENDPS C:\\project>';

    expect(windowsPSReadLineStateField('PSRL_FIXED', glued, 'version')).toBe('2.4.5');
    expect(windowsPSReadLineStateField('PSRL_FIXED', glued, 'prediction')).toBe('None');
    expect(windowsPSReadLineStateField('PSRL_FIXED', glued, 'history')).toBe('True');
    expect(
      windowsPSReadLineStateField('PSRL_FIXED', 'PSRL_FIXED=2.4.5|None|Tru', 'history'),
    ).toBeNull();
    expect(
      windowsPSReadLineStateField(
        'PSRL_FIXED',
        windowsPSReadLineStateCommand('PSRL_FIXED', 'C:\\h'),
        'history',
      ),
    ).toBeNull();
  });
});

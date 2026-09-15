import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, win32 } from 'node:path';
import { psQuoteArg } from '@inkeep/open-knowledge-core';
import { getWindowsEnvValue, windowsPathKey } from '../../../src/shared/windows-env.ts';

const POSIX_SYSTEM_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
const WINDOWS_PSREADLINE_HISTORY_SEGMENTS = ['PSReadLine', 'ConsoleHost_history.txt'] as const;
const WINDOWS_PROFILE_DIRECTORIES = ['PowerShell', 'WindowsPowerShell'] as const;
const WINDOWS_PROFILE_FILE = 'Microsoft.PowerShell_profile.ps1';
const PSREADLINE_PREDICTION_FLOOR = '2.1.0';
const UTF8_BOM = '\ufeff';
const WINDOWS_PROFILE_FAILURE_FILE = 'ok-shell-profile-error.log';

function quotePosix(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function validateEnvironmentName(name: string): void {
  if (!/^[A-Z_][A-Z0-9_]*$/i.test(name)) {
    throw new Error(`invalid terminal smoke environment name: ${name}`);
  }
}

export interface TerminalSmokeShellCommands {
  readonly cwd: string;
  arithmetic(prefix: string, left: number, right: number, suffix: string): string;
  columns(marker: string): string;
  oscTitle(title: string, marker: string): string;
  output(value: string): string;
  processId(marker: string): string;
  readEnvironment(name: string, label: string): string;
  scroll(sentinel: string, start: string, prefix: string, count: number): string;
  setEnvironment(name: string, value: string): string;
}

export function terminalSmokeShellCommands(
  platform: NodeJS.Platform = process.platform,
): TerminalSmokeShellCommands {
  if (platform === 'win32') {
    return {
      cwd: 'Get-Location',
      arithmetic: (prefix, left, right, suffix) =>
        `Write-Output "${prefix}_$((${left}*${right}))_${suffix}"`,
      columns: (marker) => `Write-Output "${marker}=$($Host.UI.RawUI.WindowSize.Width)"`,
      oscTitle: (title, marker) =>
        `[Console]::Write("$([char]27)]0;${title}$([char]7)"); Write-Output ${psQuoteArg(marker)}`,
      output: (value) => `Write-Output ${psQuoteArg(value)}`,
      processId: (marker) => `Write-Output "${marker}=$PID"`,
      readEnvironment: (name, label) => {
        validateEnvironmentName(name);
        return `Write-Output "${label}=[$env:${name}]"`;
      },
      scroll: (sentinel, start, prefix, count) =>
        `Write-Output ${psQuoteArg(sentinel)},${psQuoteArg(start)}; 1..${count} | ForEach-Object { ${psQuoteArg(`${prefix}{0:D3}`)} -f $_ }`,
      setEnvironment: (name, value) => {
        validateEnvironmentName(name);
        return `$env:${name}=${psQuoteArg(value)}`;
      },
    };
  }

  return {
    cwd: 'pwd',
    arithmetic: (prefix, left, right, suffix) => `echo ${prefix}_$((${left}*${right}))_${suffix}`,
    columns: (marker) => `echo ${marker}=$(tput cols)`,
    oscTitle: (title, marker) =>
      `printf '\\033]0;${title}\\007'; printf '%s\\n' ${quotePosix(marker)}`,
    output: (value) => `printf '%s\\n' ${quotePosix(value)}`,
    processId: (marker) => `printf '${marker}=%s\\n' "$$"`,
    readEnvironment: (name, label) => {
      validateEnvironmentName(name);
      return `echo "${label}=[$${name}]"`;
    },
    scroll: (sentinel, start, prefix, count) =>
      `printf '%s\\n' ${quotePosix(sentinel)} ${quotePosix(start)}; i=1; while [ "$i" -le ${count} ]; do printf '${prefix}%03d\\n' "$i"; i=$((i+1)); done`,
    setEnvironment: (name, value) => {
      validateEnvironmentName(name);
      return `export ${name}=${quotePosix(value)}`;
    },
  };
}

export interface InputReadyProbe {
  marker: string;
  command: string;
}

export function buildInputReadyProbe(
  platform: NodeJS.Platform = process.platform,
): InputReadyProbe {
  const token = `OK_INPUT_READY_${randomUUID().replaceAll('-', '')}`;
  return {
    marker: `${token}_42_READY`,
    command: terminalSmokeShellCommands(platform).arithmetic(token, 6, 7, 'READY'),
  };
}

interface TerminalSmokeEnvironmentOptions {
  env?: Record<string, string | undefined>;
  pathPrefix?: string;
  pinPosixZsh?: boolean;
  platform?: NodeJS.Platform;
  restrictPath?: boolean;
}

export function terminalSmokeEnvironment(
  tmpHome: string,
  options: TerminalSmokeEnvironmentOptions = {},
): Record<string, string> {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? (process.env as Record<string, string | undefined>);
  const pathKey = windowsPathKey(env);
  let basePath: string;
  if (!options.restrictPath) {
    basePath = getWindowsEnvValue(env, 'PATH') ?? '';
  } else if (platform === 'win32') {
    const systemRoot = getWindowsEnvValue(env, 'SystemRoot') ?? 'C:\\Windows';
    basePath = [
      win32.join(systemRoot, 'System32'),
      systemRoot,
      win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0'),
    ].join(';');
  } else {
    basePath = POSIX_SYSTEM_PATH;
  }

  const separator = platform === 'win32' ? ';' : ':';
  const path = options.pathPrefix
    ? [options.pathPrefix, basePath].filter(Boolean).join(separator)
    : basePath;
  return {
    HOME: tmpHome,
    ...(platform === 'win32' ? { USERPROFILE: tmpHome } : {}),
    [pathKey]: path,
    ...(options.pinPosixZsh && platform !== 'win32' ? { SHELL: '/bin/zsh' } : {}),
  };
}

interface TerminalShellProfileOptions {
  posixPathPrefix?: string;
  posixRestrictPath?: boolean;
}

export function seedTerminalShellProfiles(
  tmpHome: string,
  options: TerminalShellProfileOptions,
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform === 'win32') {
    const profile = windowsShellProfile(tmpHome);
    for (const directory of WINDOWS_PROFILE_DIRECTORIES) {
      const profileDirectory = join(tmpHome, 'Documents', directory);
      mkdirSync(profileDirectory, { recursive: true });
      writeFileSync(join(profileDirectory, WINDOWS_PROFILE_FILE), profile);
    }
    return;
  }
  if (!options.posixPathPrefix && !options.posixRestrictPath) return;
  const path = terminalSmokeEnvironment(tmpHome, {
    env: { PATH: process.env.PATH },
    pathPrefix: options.posixPathPrefix,
    platform,
    restrictPath: options.posixRestrictPath,
  }).PATH;
  const escapedPath = path.replace(/["\\$`]/g, '\\$&');
  const profile = `export PATH="${escapedPath}"\n`;
  writeFileSync(join(tmpHome, '.zprofile'), profile);
  writeFileSync(join(tmpHome, '.zshrc'), profile);
}

export function windowsPSReadLineHistoryPath(tmpHome: string): string {
  return win32.join(tmpHome, ...WINDOWS_PSREADLINE_HISTORY_SEGMENTS);
}

export function windowsShellProfileFailurePath(tmpHome: string): string {
  return win32.join(tmpHome, WINDOWS_PROFILE_FAILURE_FILE);
}

/*
 * UPSTREAM(PowerShell/PSReadLine#2189): the host supplies PSReadLine, so a bundled version older
 * than a parameter rejects it with a statement-terminating error.
 */
function windowsShellProfile(tmpHome: string): string {
  const history = psQuoteArg(windowsPSReadLineHistoryPath(tmpHome));
  const failure = psQuoteArg(windowsShellProfileFailurePath(tmpHome));
  return (
    UTF8_BOM +
    [
      'try {',
      '  Import-Module PSReadLine -ErrorAction SilentlyContinue',
      '  $okPSReadLine = Get-Module PSReadLine',
      '  if ($okPSReadLine) {',
      `    Set-PSReadLineOption -HistorySavePath ${history}`,
      `    if ($okPSReadLine.Version -ge [version]'${PSREADLINE_PREDICTION_FLOOR}') {`,
      '      Set-PSReadLineOption -PredictionSource None',
      '    }',
      '  }',
      `} catch { $_ | Out-String | Set-Content -LiteralPath ${failure} -Encoding utf8 -ErrorAction SilentlyContinue }`,
      '',
    ].join('\r\n')
  );
}

export type WindowsShellProfileFailure =
  | { readonly kind: 'absent' }
  | { readonly kind: 'record'; readonly text: string }
  | { readonly kind: 'unreadable'; readonly code: string };

export function readWindowsShellProfileFailure(home: string): WindowsShellProfileFailure {
  const path = windowsShellProfileFailurePath(home);
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code === 'ENOENT') return { kind: 'absent' };
    return { kind: 'unreadable', code: code ?? String(error) };
  }
  const trimmed = text.trim();
  return trimmed ? { kind: 'record', text: trimmed } : { kind: 'absent' };
}

export const WINDOWS_PSREADLINE_STATE_ABSENT = 'absent';
export const WINDOWS_PSREADLINE_PREDICTION_UNSUPPORTED = 'unsupported';
const WINDOWS_PSREADLINE_STATE_END = 'END';

export type WindowsPSReadLineStateField = 'version' | 'prediction' | 'history';

const WINDOWS_PSREADLINE_STATE_GROUPS = {
  version: 1,
  prediction: 2,
  history: 3,
} as const satisfies Record<WindowsPSReadLineStateField, number>;

export function windowsPSReadLineStateField(
  marker: string,
  text: string,
  field: WindowsPSReadLineStateField,
): string | null {
  const match = new RegExp(
    `${marker}=([^|]*)\\|([^|]*)\\|([^|]*)\\|${WINDOWS_PSREADLINE_STATE_END}`,
  ).exec(text);
  if (!match) return null;
  return match[WINDOWS_PSREADLINE_STATE_GROUPS[field]] ?? null;
}

export function windowsPSReadLineStateCommand(marker: string, tmpHome: string): string {
  const home = psQuoteArg(tmpHome);
  const absent = psQuoteArg(WINDOWS_PSREADLINE_STATE_ABSENT);
  return [
    '$okModule = Get-Module PSReadLine',
    '$okOptions = if ($okModule) { Get-PSReadLineOption } else { $null }',
    `$okVersion = if ($okModule) { [string]$okModule.Version } else { ${absent} }`,
    `$okPrediction = if (-not $okOptions) { ${absent} } elseif ($okOptions.PSObject.Properties['PredictionSource']) { [string]$okOptions.PredictionSource } else { ${psQuoteArg(WINDOWS_PSREADLINE_PREDICTION_UNSUPPORTED)} }`,
    `$okHistory = if ($okOptions) { [string]$okOptions.HistorySavePath.StartsWith(${home}, [System.StringComparison]::OrdinalIgnoreCase) } else { ${absent} }`,
    `Write-Output (${psQuoteArg(marker)} + '=' + $okVersion + '|' + $okPrediction + '|' + $okHistory + '|' + ${psQuoteArg(WINDOWS_PSREADLINE_STATE_END)})`,
  ].join('; ');
}

export type FakeClaudeMode = 'interactive' | 'version';

export function writeFakeClaudeShim(
  binDir: string,
  mode: FakeClaudeMode,
  platform: NodeJS.Platform = process.platform,
): string {
  mkdirSync(binDir, { recursive: true });
  if (platform === 'win32') {
    const shim = join(binDir, 'claude.cmd');
    const contents =
      mode === 'interactive'
        ? '@echo off\r\nif /i "%~1"=="--version" (\r\n  echo claude 0.0.0-fake\r\n  exit /b 0\r\n)\r\necho FAKE_CLAUDE_TUI_READY\r\nmore.com\r\n'
        : '@echo off\r\necho claude 0.0.0-fake\r\n';
    writeFileSync(shim, contents);
    return shim;
  }

  const shim = join(binDir, 'claude');
  const contents =
    mode === 'interactive'
      ? '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "claude 0.0.0-fake"; exit 0; fi\necho FAKE_CLAUDE_TUI_READY\nexec cat\n'
      : '#!/bin/sh\necho "claude 0.0.0-fake"\n';
  writeFileSync(shim, contents, { mode: 0o755 });
  return shim;
}

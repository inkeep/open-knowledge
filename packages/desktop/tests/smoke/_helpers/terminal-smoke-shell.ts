import { mkdirSync, writeFileSync } from 'node:fs';
import { join, win32 } from 'node:path';
import { psQuoteArg } from '@inkeep/open-knowledge-core';
import { getWindowsEnvValue, windowsPathKey } from '../../../src/shared/windows-env.ts';

const POSIX_SYSTEM_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';

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

/** Commands used by live terminal smokes against either PowerShell or a POSIX shell. */
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

interface TerminalSmokeEnvironmentOptions {
  env?: Record<string, string | undefined>;
  pathPrefix?: string;
  pinPosixZsh?: boolean;
  platform?: NodeJS.Platform;
  restrictPath?: boolean;
}

/** Hermetic home/PATH overrides for terminal smoke Electron launches. */
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
  pathPrefix?: string;
  restrictPath?: boolean;
}

/** Seed zsh startup files without writing POSIX artifacts into Windows profiles. */
export function seedTerminalShellProfiles(
  tmpHome: string,
  options: TerminalShellProfileOptions,
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform === 'win32') return;
  const path = terminalSmokeEnvironment(tmpHome, {
    env: { PATH: process.env.PATH },
    pathPrefix: options.pathPrefix,
    platform,
    restrictPath: options.restrictPath,
  }).PATH;
  const escapedPath = path.replace(/["\\$`]/g, '\\$&');
  const profile = `export PATH="${escapedPath}"\n`;
  writeFileSync(join(tmpHome, '.zprofile'), profile);
  writeFileSync(join(tmpHome, '.zshrc'), profile);
}

export type FakeClaudeMode = 'interactive' | 'version';

/** Write the fake Claude executable in the shape each platform's PATH probe discovers. */
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

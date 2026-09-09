import { type ExecFileSyncOptionsWithStringEncoding, execFileSync } from 'node:child_process';
import { win32 } from 'node:path';

interface ProcessStartOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  run?: (command: string, args: string[], options: ExecFileSyncOptionsWithStringEncoding) => string;
}

export function readRemovalProcessStart(
  pid: number,
  options: ProcessStartOptions = {},
): number | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const run = options.run ?? execFileSync;
  try {
    let output: string;
    const commandOptions: ExecFileSyncOptionsWithStringEncoding = {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 5000,
      windowsHide: true,
      env: { ...env, LC_ALL: 'C', TZ: 'UTC0' },
    };
    if (platform === 'win32') {
      const systemRoot = Object.entries(env)
        .find(([key]) => key.toLowerCase() === 'systemroot')?.[1]
        ?.trim();
      const powershell = win32.join(
        systemRoot && win32.isAbsolute(systemRoot) ? systemRoot : 'C:\\Windows',
        'System32',
        'WindowsPowerShell',
        'v1.0',
        'powershell.exe',
      );
      output = run(
        powershell,
        [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `$ErrorActionPreference = 'Stop'; (Get-Process -Id ${pid}).StartTime.ToUniversalTime().ToString('O')`,
        ],
        commandOptions,
      ).trim();
    } else if (platform === 'darwin' || platform === 'linux') {
      const raw = run('/bin/ps', ['-p', String(pid), '-o', 'lstart='], commandOptions).trim();
      if (!/^\w{3}\s+\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4}$/.test(raw)) return null;
      output = `${raw} UTC`;
    } else {
      return null;
    }
    const startedAt = Date.parse(output);
    return Number.isFinite(startedAt) ? startedAt : null;
  } catch {
    return null;
  }
}

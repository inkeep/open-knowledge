import { execFileSync } from 'node:child_process';
import { win32 } from 'node:path';
import { getWindowsEnvValue } from '../shared/windows-env.ts';

interface WindowsConsoleProcess {
  processId: number;
  name: string;
  executablePath: string | null;
  commandLine: string | null;
  creationDate: string;
}

export interface WindowsUpdateSurvivorSweepResult {
  candidateCount: number;
  terminatedCount: number;
  failedCount: number;
  scanFailed: boolean;
  revalidationFailed: boolean;
}

interface WindowsUpdateSurvivorSweepOptions {
  installTree: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  listProcesses?: () => readonly WindowsConsoleProcess[];
  revalidateProcesses?: (processIds: readonly number[]) => readonly WindowsConsoleProcess[];
  terminateProcess?: (pid: number) => void;
  logger?: {
    info: (event: Record<string, unknown>) => void;
    warn: (event: Record<string, unknown>) => void;
  };
}

const EMPTY_RESULT: WindowsUpdateSurvivorSweepResult = {
  candidateCount: 0,
  terminatedCount: 0,
  failedCount: 0,
  scanFailed: false,
  revalidationFailed: false,
};

const PROCESS_QUERY_FIELDS =
  "Select-Object @{Name='processId';Expression={[int]$_.ProcessId}}, @{Name='name';Expression={$_.Name}}, @{Name='executablePath';Expression={$_.ExecutablePath}}, @{Name='commandLine';Expression={$_.CommandLine}}, @{Name='creationDate';Expression={if ($null -eq $_.CreationDate) {$null} else {$_.CreationDate.ToUniversalTime().ToString('O')}}}";

const PROCESS_QUERY_TIMEOUT_MS = 5_000;

function processQuery(filter: string): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
    `$items = Get-CimInstance Win32_Process -Filter "${filter}" | ${PROCESS_QUERY_FIELDS}`,
    'ConvertTo-Json -Compress -InputObject @($items)',
  ].join('; ');
}

function parseProcessList(raw: string): WindowsConsoleProcess[] {
  const trimmed = raw.trim().replace(/^\uFEFF/u, '');
  if (trimmed.length === 0) return [];
  const parsed: unknown = JSON.parse(trimmed);
  if (!Array.isArray(parsed)) throw new Error('process query did not return an array');
  const processes: WindowsConsoleProcess[] = [];
  for (const value of parsed) {
    if (typeof value !== 'object' || value === null) continue;
    const record = value as Record<string, unknown>;
    if (
      !Number.isInteger(record.processId) ||
      (record.processId as number) <= 0 ||
      typeof record.name !== 'string' ||
      typeof record.creationDate !== 'string'
    )
      continue;
    processes.push({
      processId: record.processId as number,
      name: record.name,
      executablePath: typeof record.executablePath === 'string' ? record.executablePath : null,
      commandLine: typeof record.commandLine === 'string' ? record.commandLine : null,
      creationDate: record.creationDate,
    });
  }
  return processes;
}

/**
 * One PowerShell spawn per call. `processIds`, when given, is re-queried as a
 * single `ProcessId = a OR ProcessId = b` filter rather than one query each, so
 * a sweep costs at most two cold PowerShell/WMI starts no matter how many
 * console hosts leaked — this runs on the main process immediately before an
 * update installs. The ids are integers `parseProcessList` already validated,
 * so interpolating them into the filter cannot inject.
 */
function listWindowsConsoleProcesses(
  env: NodeJS.ProcessEnv,
  processIds?: readonly number[],
): WindowsConsoleProcess[] {
  const systemRoot = getWindowsEnvValue(env, 'SystemRoot') ?? 'C:\\Windows';
  const powershell = win32.join(
    systemRoot,
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
  const output = execFileSync(
    powershell,
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      processQuery(
        processIds === undefined
          ? "Name = 'OpenConsole.exe' OR Name = 'conhost.exe'"
          : processIds.map((processId) => `ProcessId = ${processId}`).join(' OR '),
      ),
    ],
    {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 1024 * 1024,
      timeout: PROCESS_QUERY_TIMEOUT_MS,
    },
  );
  return parseProcessList(output);
}

function normalizeWindowsPath(path: string): string {
  return win32.resolve(path).replaceAll('/', '\\').toLowerCase();
}

function commandExecutablePath(commandLine: string): string | null {
  const trimmed = commandLine.trimStart();
  if (trimmed.length === 0) return null;
  if (trimmed.startsWith('"')) {
    const end = trimmed.indexOf('"', 1);
    return end > 1 ? trimmed.slice(1, end) : null;
  }
  return trimmed.match(/^\S+/u)?.[0] ?? null;
}

function belongsToInstallTree(process: WindowsConsoleProcess, installTree: string): boolean {
  const root = normalizeWindowsPath(installTree);
  const rootPrefix = root.endsWith('\\') ? root : `${root}\\`;
  if (process.executablePath && win32.isAbsolute(process.executablePath)) {
    const executable = normalizeWindowsPath(process.executablePath);
    if (executable === root || executable.startsWith(rootPrefix)) return true;
  }
  const commandExecutable = process.commandLine ? commandExecutablePath(process.commandLine) : null;
  if (commandExecutable && win32.isAbsolute(commandExecutable)) {
    const executable = normalizeWindowsPath(commandExecutable);
    return executable === root || executable.startsWith(rootPrefix);
  }
  return false;
}

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : 'unknown';
}

/**
 * Remove console hosts that can hold files inside the installed app tree open
 * while an in-place update replaces that tree. Process-name matching alone is
 * insufficient: conhost.exe is shared Windows infrastructure, so ownership is
 * proven by an executable path or command line rooted under this installation.
 */
export function sweepWindowsUpdateSurvivors(
  options: WindowsUpdateSurvivorSweepOptions,
): WindowsUpdateSurvivorSweepResult {
  const platform = options.platform ?? process.platform;
  if (platform !== 'win32') return EMPTY_RESULT;
  if (!win32.isAbsolute(options.installTree)) {
    options.logger?.warn({
      event: 'windows-update-survivor-scan-failed',
      code: 'invalid-install-tree',
    });
    return { ...EMPTY_RESULT, scanFailed: true };
  }

  let listed: readonly WindowsConsoleProcess[];
  try {
    listed = (
      options.listProcesses ?? (() => listWindowsConsoleProcesses(options.env ?? process.env))
    )();
  } catch (error) {
    options.logger?.warn({
      event: 'windows-update-survivor-scan-failed',
      code: errorCode(error),
    });
    return { ...EMPTY_RESULT, scanFailed: true };
  }

  const candidates = new Map<number, WindowsConsoleProcess>();
  for (const candidate of listed) {
    const name = candidate.name.toLowerCase();
    if (name !== 'openconsole.exe' && name !== 'conhost.exe') continue;
    if (belongsToInstallTree(candidate, options.installTree)) {
      candidates.set(candidate.processId, candidate);
    }
  }

  const terminateProcess = options.terminateProcess ?? ((pid: number) => process.kill(pid));
  const revalidateProcesses =
    options.revalidateProcesses ??
    ((processIds: readonly number[]) =>
      options.listProcesses
        ? options.listProcesses().filter((entry) => processIds.includes(entry.processId))
        : listWindowsConsoleProcesses(options.env ?? process.env, processIds));

  // One re-query for the whole candidate set, matched back by PID below: the
  // scan-to-kill window is what makes revalidation necessary, but the re-query
  // is itself an out-of-process call that can fail or time out, and a failure
  // there leaves every identity unproven, so nothing gets terminated.
  const revalidated = new Map<number, WindowsConsoleProcess>();
  let revalidationFailed = false;
  if (candidates.size > 0) {
    try {
      for (const entry of revalidateProcesses([...candidates.keys()])) {
        revalidated.set(entry.processId, entry);
      }
    } catch (error) {
      revalidationFailed = true;
      options.logger?.warn({
        event: 'windows-update-survivor-revalidate-failed',
        code: errorCode(error),
      });
    }
  }

  let terminatedCount = 0;
  let failedCount = 0;
  if (!revalidationFailed) {
    for (const candidate of candidates.values()) {
      const latest = revalidated.get(candidate.processId) ?? null;
      if (
        latest === null ||
        latest.creationDate !== candidate.creationDate ||
        latest.name.toLowerCase() !== candidate.name.toLowerCase() ||
        !belongsToInstallTree(latest, options.installTree)
      ) {
        options.logger?.warn({
          event: 'windows-update-survivor-identity-changed',
          processName: candidate.name.toLowerCase(),
        });
        continue;
      }
      try {
        terminateProcess(candidate.processId);
        terminatedCount += 1;
      } catch (error) {
        const code = errorCode(error);
        if (code === 'ESRCH') continue;
        failedCount += 1;
        options.logger?.warn({
          event: 'windows-update-survivor-terminate-failed',
          processName: candidate.name.toLowerCase(),
          code,
        });
      }
    }
  }

  const result = {
    candidateCount: candidates.size,
    terminatedCount,
    failedCount,
    scanFailed: false,
    revalidationFailed,
  };
  if (failedCount > 0 || revalidationFailed) {
    options.logger?.warn({ event: 'windows-update-survivor-sweep-incomplete', ...result });
  } else {
    options.logger?.info({ event: 'windows-update-survivor-sweep', ...result });
  }
  return result;
}

import { spawnSync } from 'node:child_process';

type LinuxPackageKind = 'deb' | 'rpm';

export interface ManualInstallPlan {
  packageKind: LinuxPackageKind;
  command: string;
}

export interface LinuxManualInstallContext extends ManualInstallPlan {
  version: string;
  installerPath: string;
}

export function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function manualInstallPlanFor(installerPath: string | null): ManualInstallPlan | null {
  if (!installerPath) return null;
  const lower = installerPath.toLowerCase();
  if (lower.endsWith('.deb')) {
    return {
      packageKind: 'deb',
      command: `sudo apt install -- ${shellSingleQuote(installerPath)}`,
    };
  }
  if (lower.endsWith('.rpm')) {
    return {
      packageKind: 'rpm',
      command: `sudo dnf install ${shellSingleQuote(installerPath)}`,
    };
  }
  return null;
}

export type InstallFailureClass = 'cancelled' | 'infrastructure';

export function classifyInstallFailure(message: string | undefined): InstallFailureClass {
  if (message && /exited with code 126\b/.test(message)) return 'cancelled';
  return 'infrastructure';
}

export const GRAPHICAL_AUTH_COMMANDS = ['gksudo', 'kdesudo', 'pkexec', 'beesu'] as const;

const COMMAND_PROBE_TIMEOUT_MS = 2000;

const COMMAND_PROBE_TOTAL_BUDGET_MS = 4000;

export function hasCommandOnPath(
  cmd: string,
  spawn: typeof spawnSync = spawnSync,
  timeoutMs: number = COMMAND_PROBE_TIMEOUT_MS,
): boolean {
  if (!/^[A-Za-z0-9_.-]+$/.test(cmd)) {
    console.warn('[linux-install-fallback] refusing to probe a non-bare command name', { cmd });
    return false;
  }
  try {
    const result = spawn(`command -v ${cmd}`, {
      shell: true,
      stdio: 'ignore',
      timeout: timeoutMs,
      windowsHide: true,
    });
    return result.error == null && result.status === 0;
  } catch (err) {
    console.warn('[linux-install-fallback] command probe threw', { cmd, err });
    return false;
  }
}

export function detectGraphicalAuthCommand(
  hasCommand: (cmd: string, timeoutMs: number) => boolean = (cmd, timeoutMs) =>
    hasCommandOnPath(cmd, spawnSync, timeoutMs),
  now: () => number = Date.now,
): string | null {
  const deadline = now() + COMMAND_PROBE_TOTAL_BUDGET_MS;
  for (const cmd of GRAPHICAL_AUTH_COMMANDS) {
    const remainingMs = deadline - now();
    if (remainingMs <= 0) {
      console.warn('[linux-install-fallback] auth-wrapper probe budget exhausted', { cmd });
      return null;
    }
    if (hasCommand(cmd, Math.min(COMMAND_PROBE_TIMEOUT_MS, remainingMs))) return cmd;
  }
  return null;
}

export interface ManualInstallDialogRequest {
  message: string;
  detail: string;
  buttons: string[];
  defaultId: number;
  cancelId: number;
}

export interface ManualInstallDialogDeps {
  showDialog: (request: ManualInstallDialogRequest) => Promise<{ response: number }>;
  copyCommandToClipboard: (command: string) => void;
  relaunchApp: () => void;
}

export async function runManualInstallFallbackDialog(
  deps: ManualInstallDialogDeps,
  ctx: LinuxManualInstallContext,
): Promise<'relaunch' | 'dismissed'> {
  const request: ManualInstallDialogRequest = {
    message: `OpenKnowledge ${ctx.version} couldn't install automatically`,
    detail:
      'Administrator authorization is not available in this session, so the update ' +
      'cannot be installed for you.\n\n' +
      'To install it manually, run this in a terminal:\n\n' +
      `${ctx.command}\n\n` +
      'The downloaded update stays on disk until it is installed or replaced by a ' +
      'newer version. Relaunch restarts OpenKnowledge whether or not you have ' +
      'installed it yet.',
    buttons: ['Copy Command', 'Relaunch OpenKnowledge', 'Not Now'],
    defaultId: 0,
    cancelId: 2,
  };
  for (;;) {
    let result: { response: number };
    try {
      result = await deps.showDialog(request);
    } catch (err) {
      console.warn('[linux-install-fallback] dialog failed — treating as dismissal', {
        version: ctx.version,
        installerPath: ctx.installerPath,
        err,
      });
      return 'dismissed';
    }
    if (result.response === 0) {
      deps.copyCommandToClipboard(ctx.command);
      continue;
    }
    if (result.response === 1) {
      deps.relaunchApp();
      return 'relaunch';
    }
    return 'dismissed';
  }
}

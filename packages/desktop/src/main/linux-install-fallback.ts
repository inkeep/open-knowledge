/**
 * Linux manual-install fallback — the escape hatch for desktops where
 * electron-updater cannot obtain graphical administrator authorization.
 *
 * The normal Linux install path runs a BLOCKING privileged package install
 * inside `quitAndInstall()`, wrapped by whichever graphical auth command
 * electron-updater finds (pkexec via a PolicyKit agent, gksudo, kdesudo,
 * beesu — `LinuxUpdater.determineSudoCommand`). When none exists it falls
 * back to terminal-oriented `sudo`, which has no way to prompt in an
 * ordinary GUI launch — the install just fails. This module supplies the
 * pieces the auto-updater uses to (a) detect that shape up front, (b) tell
 * a user-cancelled auth prompt apart from broken/missing auth
 * infrastructure, and (c) hand the user a copyable, shell-safe package
 * manager command targeting the already-downloaded installer.
 *
 * Deliberately NOT here (locked scope): spawning a terminal, opening the
 * installer folder, polling package databases, or auto-detecting whether
 * the user actually installed — relaunch is unconditional and the old
 * version simply resumes showing the pending update if they didn't.
 */

import { spawnSync } from 'node:child_process';

type LinuxPackageKind = 'deb' | 'rpm';

export interface ManualInstallPlan {
  packageKind: LinuxPackageKind;
  /** Full user-facing command, shell-quoted, ready to paste into a terminal. */
  command: string;
}

/** Context handed to the dialog surface for one fallback offer. */
export interface LinuxManualInstallContext extends ManualInstallPlan {
  version: string;
  installerPath: string;
}

/**
 * POSIX single-quote escaping: wrap in `'…'`, embedded single quotes become
 * `'\''`. Handles every other shell metacharacter (spaces, `$`, backticks,
 * `;`, newlines) by construction — nothing is interpreted inside single
 * quotes.
 */
export function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * Build the user-facing install command for a staged installer, or null when
 * the path is unknown or not a recognized package format (the caller then
 * stays on the default electron-updater path).
 *
 * Command shapes are deliberately minimal and safe to paste:
 *   - deb: `sudo apt install -- '<path>'` — `--` stops option parsing so an
 *     installer path can never be read as a flag; apt treats an argument
 *     containing `/` as a local file.
 *   - rpm: `sudo dnf install '<path>'`.
 * Neither includes `--allow-unauthenticated` / `--nogpgcheck` — a user
 * pasting our command must not have signature checking silently disabled.
 */
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

/**
 * Classify a failed Linux `quitAndInstall()`. pkexec exits 126 when the user
 * dismissed the authentication dialog and 127 when authorization could not
 * be obtained at all (no registered agent, policy denial, helper failure);
 * electron-updater surfaces the code in the thrown message
 * (`Command pkexec exited with code 126` — `BaseUpdater.spawnSyncLog`).
 * Everything that is not an explicit user dismissal counts as
 * infrastructure: the sudo-fallback "no tty" failure, agent-less 127s, and
 * unrecognized shapes all mean the automatic path cannot work as launched,
 * which is exactly when the manual command is the actionable next step.
 */
export function classifyInstallFailure(message: string | undefined): InstallFailureClass {
  if (message && /exited with code 126\b/.test(message)) return 'cancelled';
  return 'infrastructure';
}

/**
 * The graphical privilege-escalation wrappers electron-updater's
 * `determineSudoCommand` probes for (its order retained). If ANY is present
 * the automatic path is worth attempting; if none is, `quitAndInstall()`
 * would fall through to terminal `sudo` and fail without a usable prompt.
 */
export const GRAPHICAL_AUTH_COMMANDS = ['gksudo', 'kdesudo', 'pkexec', 'beesu'] as const;

/** Per-probe ceiling for one `command -v` spawn. */
const COMMAND_PROBE_TIMEOUT_MS = 2000;

/**
 * Total synchronous main-process budget for one `detectGraphicalAuthCommand`
 * sweep across all four wrappers — a pathological shell (NFS-stalled rc
 * file) times out per probe, and without a shared deadline four back-to-back
 * timeouts would block the UI for 4× the per-probe bound.
 */
const COMMAND_PROBE_TOTAL_BUDGET_MS = 4000;

/**
 * `command -v` probe through a shell, mirroring electron-updater's
 * `hasCommand` so our preflight agrees with what its installer would find.
 * The timeout bounds a pathological shell — this runs on the main process,
 * once per wrapper, on every "Relaunch now" click.
 *
 * The probe is a single command STRING: an args array combined with
 * `shell: true` trips Node's DEP0190 deprecation warning on every spawn
 * (Node >= 22.15) — the very warning class this module exists to remove
 * from packaged startup. Interpolating requires the shape guard below,
 * since this export could someday be fed something beyond the hardcoded
 * `GRAPHICAL_AUTH_COMMANDS`.
 */
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
    });
    return result.error == null && result.status === 0;
  } catch (err) {
    // A throw here (EACCES on the shell, ENOMEM) routes the user to the
    // manual-install dialog even when the wrapper exists — leave a trail.
    console.warn('[linux-install-fallback] command probe threw', { cmd, err });
    return false;
  }
}

/**
 * First graphical auth wrapper on PATH, or null when none is available.
 * Probes stop once the shared budget is spent: with a hung shell every
 * remaining probe would time out anyway, so the sweep degrades to "none
 * found" rather than serially blocking the main process on each wrapper.
 */
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
  /** Production: `dialog.showMessageBox(...)` parented to the active window. */
  showDialog: (request: ManualInstallDialogRequest) => Promise<{ response: number }>;
  /** Production: `clipboard.writeText`. */
  copyCommandToClipboard: (command: string) => void;
  /** Production: `app.relaunch(); app.quit();` — unconditional, no install check. */
  relaunchApp: () => void;
}

/**
 * Drive one fallback-dialog session. "Copy Command" copies and RE-SHOWS the
 * dialog (a message box closes on any button, but the user still needs
 * Relaunch / Not now available after copying); "Relaunch OpenKnowledge"
 * relaunches unconditionally; "Not now" dismisses. One session per explicit
 * failed relaunch attempt — dismissing never re-prompts on its own, so the
 * staged update is preserved without nagging.
 */
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
      // Parent window destroyed between iterations (e.g. copied the command,
      // then closed the window before the re-show). The app state is already
      // recovered and the command may be on the clipboard — treat as
      // dismissal. Logged because a FIRST-iteration throw means the user
      // never saw the dialog at all; resolving 'dismissed' would otherwise
      // hide that entirely.
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

import { execFileSync, spawn as spawnChild } from 'node:child_process';
import { dirname } from 'node:path';
import type { Readable } from 'node:stream';
import {
  buildDesktopUninstallCleanupScript,
  type DesktopUninstallCleanupInput,
  type RunDesktopUninstallCleanupResult,
  shellQuote,
} from './desktop-uninstall.ts';

interface DesktopUninstallHandoffInput extends DesktopUninstallCleanupInput {
  appBundlePath: string;
  parentPid: number;
  parentStartedAt: string;
}

interface DesktopUninstallHandoffCommands {
  ps?: string;
  sleep?: string;
  osascript?: string;
  open?: string;
}

interface DesktopUninstallResultInput {
  appBundlePath: string;
  logPath: string;
  cleanup: RunDesktopUninstallCleanupResult;
}

interface DesktopUninstallHandoffStepDeps {
  collectFeedback: () => Promise<void>;
  launchHandoff: () => Promise<RunDesktopUninstallCleanupResult>;
  showFailure: (failure: { error: string }) => Promise<void>;
  suppressAutoInstallOnQuit: () => void;
  quit: () => void | Promise<void>;
}

export async function runDesktopUninstallHandoffStep(
  deps: DesktopUninstallHandoffStepDeps,
): Promise<void> {
  await deps.collectFeedback();
  const handoff = await deps.launchHandoff();
  if (!handoff.ok) {
    await deps.showFailure(handoff);
    return;
  }
  deps.suppressAutoInstallOnQuit();
  await deps.quit();
}

interface HandoffChild {
  stdout: Pick<Readable, 'on'> | null;
  once(event: 'error', listener: (error: Error) => void): void;
  once(event: 'close', listener: (code: number | null) => void): void;
  kill(): void;
  unref(): void;
}

interface LaunchDesktopUninstallHandoffDeps {
  spawn?: (command: string, args: readonly string[], options: object) => HandoffChild;
  readParentStartedAt?: () => string;
}

const HANDOFF_READY = 'OK_UNINSTALL_READY';
const NOTICE_SCRIPT = `on run argv
  set noticeTitle to item 1 of argv
  set noticeText to item 2 of argv
  set actionLabel to item 3 of argv
  set result to display dialog noticeText with title noticeTitle buttons {"Cleanup log", actionLabel} default button actionLabel
  return button returned of result
end run`;

function buildDesktopUninstallResultFunctions(
  input: Pick<DesktopUninstallResultInput, 'logPath' | 'appBundlePath'>,
  commands: DesktopUninstallHandoffCommands,
): string {
  return `LOG=${shellQuote(input.logPath)}
APP_BUNDLE=${shellQuote(input.appBundlePath)}
OSASCRIPT=${shellQuote(commands.osascript ?? '/usr/bin/osascript')}
OPEN=${shellQuote(commands.open ?? '/usr/bin/open')}
NOTICE_SCRIPT=${shellQuote(NOTICE_SCRIPT)}

show_result() {
  while :; do
    action=$("$OSASCRIPT" -e "$NOTICE_SCRIPT" "$1" "$2" "$3" 2>> "$LOG") || return
    if [ "$action" = 'Cleanup log' ]; then
      "$OPEN" -R "$LOG" 2>> "$LOG"
    else
      if [ "$action" = 'Reveal in Finder' ]; then
        "$OPEN" -R "$APP_BUNDLE" 2>> "$LOG"
      fi
      return
    fi
  done
}

show_failure() {
  printf '%s\\n' 'Cleanup result: failed' "$1" >> "$LOG"
  show_result 'Cleanup didn’t finish' "Some files may not have been removed. $1

Open the cleanup log for details. You can reopen OpenKnowledge to try again." 'Close'
}

show_success() {
  printf '%s\\n' 'Cleanup result: succeeded' >> "$LOG"
  show_result 'OpenKnowledge files were removed' 'OpenKnowledge’s settings and integrations were removed. Your markdown content and authored skills were kept.

Move OpenKnowledge.app to the Trash to remove the app itself.' 'Reveal in Finder'
}
`;
}

export function buildDesktopUninstallResultScript(
  input: DesktopUninstallResultInput,
  commands: DesktopUninstallHandoffCommands = {},
): string {
  return `#!/bin/sh
/bin/mkdir -p ${shellQuote(dirname(input.logPath))} || exit 1
${buildDesktopUninstallResultFunctions(input, commands)}
${input.cleanup.ok ? 'show_success' : `show_failure ${shellQuote(input.cleanup.error)}`}
`;
}

export async function showDesktopUninstallResult(
  input: DesktopUninstallResultInput,
): Promise<void> {
  await new Promise<void>((resolveResult, reject) => {
    const child = spawnChild('/bin/sh', ['-c', buildDesktopUninstallResultScript(input)], {
      cwd: '/',
      stdio: 'ignore',
      windowsHide: true,
    });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolveResult();
      else reject(new Error(`The cleanup result dialog exited with code ${code}.`));
    });
  });
}

export function buildDesktopUninstallHandoffScript(
  input: DesktopUninstallHandoffInput,
  commands: DesktopUninstallHandoffCommands = {},
): string {
  if (!Number.isSafeInteger(input.parentPid) || input.parentPid <= 0) {
    throw new Error('Invalid uninstall parent process');
  }
  if (input.parentStartedAt.trim() === '') throw new Error('Missing uninstall parent identity');
  return `#!/bin/sh
${buildDesktopUninstallResultFunctions(input, commands)}
PARENT_PID=${input.parentPid}
PARENT_STARTED_AT=${shellQuote(input.parentStartedAt)}
PS=${shellQuote(commands.ps ?? '/bin/ps')}
SLEEP=${shellQuote(commands.sleep ?? '/bin/sleep')}

fail() {
  show_failure "$1"
  exit 1
}

/bin/mkdir -p ${shellQuote(dirname(input.logPath))} || exit 1
: >> "$LOG" || exit 1
printf '${HANDOFF_READY}\\n'
exec 1>/dev/null
attempts=0
while :; do
  current_start=$("$PS" -p "$PARENT_PID" -o lstart= 2>> "$LOG")
  status=$?
  if [ "$status" -eq 1 ] && [ -z "$current_start" ]; then
    break
  fi
  if [ "$status" -ne 0 ] || [ -z "$current_start" ]; then
    fail 'Could not verify that OpenKnowledge stopped; no cleanup was started.'
  fi
  current_start=$(printf '%s' "$current_start" | /usr/bin/sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
  if [ "$current_start" != "$PARENT_STARTED_AT" ]; then
    break
  fi
  attempts=$((attempts + 1))
  if [ "$attempts" -ge 120 ]; then
    fail 'OpenKnowledge did not stop; no cleanup was started.'
  fi
  "$SLEEP" 0.5 || fail 'Could not wait for OpenKnowledge to stop; no cleanup was started.'
done

/bin/sh -c ${shellQuote(buildDesktopUninstallCleanupScript(input))}
status=$?
if [ "$status" -ne 0 ]; then
  fail 'The cleanup command reported a failure.'
fi
show_success
exit 0
`;
}

export async function launchDesktopUninstallHandoff(
  input: DesktopUninstallCleanupInput & { appBundlePath: string },
  deps: LaunchDesktopUninstallHandoffDeps = {},
): Promise<RunDesktopUninstallCleanupResult> {
  try {
    const parentStartedAt =
      deps.readParentStartedAt?.() ??
      execFileSync('/bin/ps', ['-p', String(process.pid), '-o', 'lstart='], {
        encoding: 'utf8',
        timeout: 5000,
        windowsHide: true,
      }).trim();
    const spawn = deps.spawn ?? spawnChild;
    const script = buildDesktopUninstallHandoffScript({
      ...input,
      parentPid: process.pid,
      parentStartedAt,
    });
    return await new Promise((resolveResult) => {
      const child = spawn('/bin/sh', ['-c', script], {
        cwd: '/',
        detached: true,
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      });
      if (child.stdout === null) {
        child.kill();
        resolveResult({ ok: false, error: 'The cleanup helper could not report readiness.' });
        return;
      }
      let settled = false;
      let output = '';
      const timeout = setTimeout(() => {
        child.kill();
        finish({ ok: false, error: 'The cleanup helper did not become ready.' });
      }, 5000);
      const finish = (result: RunDesktopUninstallCleanupResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (result.ok) child.unref();
        resolveResult(result);
      };
      child.stdout.on('data', (chunk: Buffer) => {
        output += chunk.toString();
        if (output.includes(`${HANDOFF_READY}\n`)) finish({ ok: true });
      });
      child.once('error', (error) => finish({ ok: false, error: error.message }));
      child.once('close', (code) =>
        finish({
          ok: false,
          error: 'The cleanup helper stopped before it was ready.',
          exitCode: code,
        }),
      );
    });
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

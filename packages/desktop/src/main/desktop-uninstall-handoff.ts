import { execFileSync, spawn as spawnChild } from 'node:child_process';
import { dirname } from 'node:path';
import type { Readable } from 'node:stream';
import {
  buildDesktopUninstallCleanupScript,
  type DesktopUninstallCleanupInput,
  type RunDesktopUninstallCleanupResult,
  shellQuote,
} from './desktop-uninstall.ts';

import { UNINSTALL_PROGRESS_READY_TIMEOUT_MS } from './desktop-uninstall-result.ts';

interface DesktopUninstallHandoffInput extends DesktopUninstallCleanupInput {
  appBundlePath: string;
  parentPid: number;
  parentStartedAt: string;
}

interface DesktopUninstallHandoffCommands {
  result?: readonly string[];
  ps?: string;
  psTimeoutSeconds?: number;
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
  resultCommand?: readonly string[];
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
  const resultCommand = commands.result?.map(shellQuote).join(' ');
  const chooseAction = resultCommand
    ? `if [ -n "$result_pid" ]; then
    if printf '%s\\000' "$1" "$2" "$3" > "$profile/result.tmp" && /bin/mv "$profile/result.tmp" "$profile/result"; then
      wait "$result_pid"
      result_status=$?
      result_pid=''
    else
      result_status=1
    fi
  elif create_result_profile; then
    ${resultCommand} "--user-data-dir=$profile" --ok-uninstall-result "$1" "$2" "$3" >> "$LOG" 2>&1 &
    result_pid=$!
    wait "$result_pid"
    result_status=$?
    result_pid=''
  else
    result_status=1
  fi
  cleanup_result_ui
  trap - EXIT HUP INT TERM
  case "$result_status" in
    0) return ;;
    10) action='Cleanup log' ;;
    11) action='Reveal in Finder' ;;
    *)
      printf 'Could not show the completion window (exit %s); using the system dialog.\\n' "$result_status" >> "$LOG"
      action=$("$OSASCRIPT" -e "$NOTICE_SCRIPT" "$1" "$2" "$3" 2>> "$LOG") || return
      ;;
  esac`
    : `action=$("$OSASCRIPT" -e "$NOTICE_SCRIPT" "$1" "$2" "$3" 2>> "$LOG") || return`;
  const progressFunctions = resultCommand
    ? `profile=''
result_pid=''

cleanup_result_ui() {
  if [ -n "$result_pid" ]; then
    kill -KILL "$result_pid" 2>/dev/null
    wait "$result_pid" 2>/dev/null
    result_pid=''
  fi
  if [ -n "$profile" ]; then /bin/rm -rf "$profile"; fi
}

create_result_profile() {
  profile=$(/usr/bin/mktemp -d "\${TMPDIR:-/tmp}/ok-uninstall-result.XXXXXX") || return 1
  trap cleanup_result_ui EXIT
  trap 'exit 1' HUP INT TERM
}

start_progress() {
  create_result_profile || return 1
  ${resultCommand} "--user-data-dir=$profile" --ok-uninstall-progress >> "$LOG" 2>&1 &
  result_pid=$!
  ready_attempts=0
  until [ -f "$profile/ready" ]; do
    if ! kill -0 "$result_pid" 2>/dev/null || [ "$ready_attempts" -ge ${Math.ceil(UNINSTALL_PROGRESS_READY_TIMEOUT_MS / 100)} ]; then
      printf 'The uninstall progress window did not become ready; no cleanup was started.\\n' >> "$LOG"
      return 1
    fi
    ready_attempts=$((ready_attempts + 1))
    "$SLEEP" 0.1 || return 1
  done
}
`
    : '';
  return `LOG=${shellQuote(input.logPath)}
APP_BUNDLE=${shellQuote(input.appBundlePath)}
OSASCRIPT=${shellQuote(commands.osascript ?? '/usr/bin/osascript')}
OPEN=${shellQuote(commands.open ?? '/usr/bin/open')}
NOTICE_SCRIPT=${shellQuote(NOTICE_SCRIPT)}
${progressFunctions}
show_result() {
  ${chooseAction}
  case "$action" in
    'Cleanup log') "$OPEN" -R "$LOG" 2>> "$LOG" ;;
    'Reveal in Finder') "$OPEN" -R "$APP_BUNDLE" 2>> "$LOG" ;;
  esac
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
  commands: DesktopUninstallHandoffCommands = {},
): Promise<void> {
  await new Promise<void>((resolveResult, reject) => {
    const child = spawnChild(
      '/bin/sh',
      ['-c', buildDesktopUninstallResultScript(input, commands)],
      {
        cwd: '/',
        stdio: 'ignore',
        windowsHide: true,
      },
    );
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
  const psTimeoutSeconds = commands.psTimeoutSeconds ?? 5;
  if (!Number.isFinite(psTimeoutSeconds) || psTimeoutSeconds <= 0) {
    throw new Error('Invalid process-query timeout');
  }
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
${commands.result?.length ? 'start_progress || exit 1' : ''}
printf '${HANDOFF_READY}\\n'
exec 1>/dev/null
read_parent_start() (
  ps_probe=$(/usr/bin/mktemp -d "\${TMPDIR:-/tmp}/ok-uninstall-ps.XXXXXX") || exit 2
  ps_output="$ps_probe/output"
  ps_ready="$ps_probe/ready"
  ps_pid=''
  watchdog=''
  cleanup_probe() {
    if [ -n "$watchdog" ]; then kill "$watchdog" 2>/dev/null; wait "$watchdog" 2>/dev/null; fi
    if [ -n "$ps_pid" ]; then kill -KILL "$ps_pid" 2>/dev/null; wait "$ps_pid" 2>/dev/null; fi
    /bin/rm -rf "$ps_probe"
  }
  trap cleanup_probe EXIT
  trap 'exit 2' HUP INT TERM
  : > "$ps_output" || exit 2
  "$PS" -p "$PARENT_PID" -o lstart= > "$ps_output" 2>> "$LOG" &
  ps_pid=$!
  (
    stop_watchdog() {
      sleeper=$!
      if [ -n "$sleeper" ] && [ "$sleeper" != "$ps_pid" ]; then
        kill "$sleeper" 2>/dev/null
        wait "$sleeper" 2>/dev/null
      fi
      exit
    }
    trap stop_watchdog TERM
    : > "$ps_ready" || exit 2
    /bin/sleep ${shellQuote(String(psTimeoutSeconds))} &
    wait "$!"
    kill -KILL "$ps_pid" 2>/dev/null
  ) >/dev/null 2>&1 &
  watchdog=$!
  ready_attempts=0
  while [ ! -f "$ps_ready" ]; do
    if [ "$ready_attempts" -ge 500 ]; then
      kill -KILL "$watchdog" 2>/dev/null
      wait "$watchdog" 2>/dev/null
      watchdog=''
      exit 2
    fi
    ready_attempts=$((ready_attempts + 1))
    /bin/sleep 0.01 || exit 2
  done
  wait "$ps_pid" 2>/dev/null
  ps_status=$?
  ps_pid=''
  /bin/cat "$ps_output" 2>> "$LOG" || exit 2
  exit "$ps_status"
)

attempts=0
while :; do
  current_start=$(read_parent_start)
  status=$?
  if [ "$status" -eq 1 ] && [ -z "$current_start" ]; then
    break
  fi
  if [ "$status" -ne 0 ]; then
    fail "Could not verify that OpenKnowledge stopped (process query exit $status); no cleanup was started."
  fi
  if [ -z "$current_start" ]; then
    fail "Could not verify that OpenKnowledge stopped (process query returned no start time); no cleanup was started."
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
    const script = buildDesktopUninstallHandoffScript(
      {
        ...input,
        parentPid: process.pid,
        parentStartedAt,
      },
      { result: deps.resultCommand },
    );
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
      const timeout = setTimeout(
        () => {
          child.kill();
          finish({ ok: false, error: 'The cleanup helper did not become ready.' });
        },
        deps.resultCommand?.length ? UNINSTALL_PROGRESS_READY_TIMEOUT_MS + 10_000 : 5000,
      );
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

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
  watchSleep?: string;
  osascript?: string;
  open?: string;
  kill?: string;
  date?: string;
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
const PROCESS_QUERY_POLL_SECONDS = 0.01;
const RESULT_WINDOW_WATCH_SECONDS = 0.2;
const PROGRESS_READY_POLL_SECONDS = 0.1;
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
  const progressReadySeconds = Math.ceil(UNINSTALL_PROGRESS_READY_TIMEOUT_MS / 1000);
  const chooseAction = resultCommand
    ? `if [ -n "$result_pid" ]; then
    if printf '%s\\000' "$1" "$2" "$3" > "$profile/result.tmp" && /bin/mv "$profile/result.tmp" "$profile/result"; then
      wait "$result_pid"
      result_status=$?
      result_pid=''
    else
      result_status=1
    fi
  elif create_result_profile && start_result_window --ok-uninstall-result "$1" "$2" "$3"; then
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
    /bin/rm -f "$profile/watched"
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

start_result_window() {
  command : > "$profile/watched" || return 1
  (
    watching=1
    stop_window() {
      if [ -n "$watching" ]; then printf 'Could not keep watching the uninstall window; it was stopped.\\n' >> "$LOG"; fi
      if "$KILL" -s 0 "$window" 2>/dev/null; then "$KILL" -s KILL "$window" 2>/dev/null; fi
      wait "$window"
      exit "$?"
    }
    ${resultCommand} "--user-data-dir=$profile" "$@" >> "$LOG" 2>&1 &
    window=$!
    trap stop_window EXIT
    while [ -f "$profile/watched" ] && "$KILL" -s 0 "$window" 2>/dev/null; do
      "$WATCH_SLEEP" ${RESULT_WINDOW_WATCH_SECONDS} || exit
    done
    watching=''
  ) >/dev/null 2>&1 &
  result_pid=$!
}

start_progress() {
  if ! create_result_profile || ! start_result_window --ok-uninstall-progress; then
    printf 'The uninstall progress window could not be started; no cleanup was started.\\n' >> "$LOG"
    return 1
  fi
  ready_deadline=$("$DATE" +%s) || {
    printf 'The uninstall progress window could not be timed; no cleanup was started.\\n' >> "$LOG"
    return 1
  }
  ready_deadline=$((ready_deadline + ${progressReadySeconds}))
  until [ -f "$profile/ready" ]; do
    if ! "$KILL" -s 0 "$result_pid" 2>/dev/null; then
      wait "$result_pid"
      window_status=$?
      result_pid=''
      printf 'The uninstall progress window exited before it was ready (exit %s); no cleanup was started.\\n' "$window_status" >> "$LOG"
      return 1
    fi
    ready_now=$("$DATE" +%s) || {
      printf 'The uninstall progress window could not be timed; no cleanup was started.\\n' >> "$LOG"
      return 1
    }
    [ "$ready_now" -le "$ready_deadline" ] || {
      printf 'The uninstall progress window did not become ready within %s seconds; no cleanup was started.\\n' '${progressReadySeconds}' >> "$LOG"
      return 1
    }
    "$SLEEP" ${PROGRESS_READY_POLL_SECONDS} || {
      printf 'The uninstall progress window could not be waited for; no cleanup was started.\\n' >> "$LOG"
      return 1
    }
  done
}
`
    : '';
  return `LOG=${shellQuote(input.logPath)}
APP_BUNDLE=${shellQuote(input.appBundlePath)}
OSASCRIPT=${shellQuote(commands.osascript ?? '/usr/bin/osascript')}
OPEN=${shellQuote(commands.open ?? '/usr/bin/open')}
KILL=${shellQuote(commands.kill ?? 'kill')}
WATCH_SLEEP=${shellQuote(commands.watchSleep ?? '/bin/sleep')}
SLEEP=${shellQuote(commands.sleep ?? '/bin/sleep')}
DATE=${shellQuote(commands.date ?? '/bin/date')}
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
  const psTimeout = shellQuote(String(psTimeoutSeconds));
  return `#!/bin/sh
${buildDesktopUninstallResultFunctions(input, commands)}
PARENT_PID=${input.parentPid}
PARENT_STARTED_AT=${shellQuote(input.parentStartedAt)}
PS=${shellQuote(commands.ps ?? '/bin/ps')}

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
  ps_pid=''
  query_timer=''
  stop_query() {
    if [ -n "$ps_pid" ]; then
      if "$KILL" -s 0 "$ps_pid" 2>/dev/null; then "$KILL" -s KILL "$ps_pid" 2>/dev/null; fi
      wait "$ps_pid" 2>/dev/null
    fi
    if [ -n "$query_timer" ]; then
      if "$KILL" -s 0 "$query_timer" 2>/dev/null; then "$KILL" -s KILL "$query_timer" 2>/dev/null; fi
      wait "$query_timer" 2>/dev/null
    fi
    /bin/rm -rf "$ps_probe"
  }
  trap stop_query EXIT
  trap 'printf "%s\\n" "The process query was interrupted." >> "$LOG"; exit 2' HUP INT TERM
  command : > "$ps_output" || exit 2
  "$PS" -p "$PARENT_PID" -o lstart= > "$ps_output" 2>> "$LOG" &
  ps_pid=$!
  >/dev/null 2>&1 /bin/sleep ${psTimeout} &
  query_timer=$!
  while "$KILL" -s 0 "$ps_pid" 2>/dev/null; do
    if ! "$KILL" -s 0 "$query_timer" 2>/dev/null; then
      printf 'The process query did not answer within %s seconds.\\n' ${psTimeout} >> "$LOG"
      exit 2
    fi
    "$SLEEP" ${PROCESS_QUERY_POLL_SECONDS} || {
      printf 'Could not wait for the process query to answer.\\n' >> "$LOG"
      exit 2
    }
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

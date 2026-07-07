/**
 * `open-knowledge stop` — SIGTERM live server + ui processes; leave stale
 * locks untouched (they belong to `ok clean`).
 *
 * Single-responsibility split from lock pruning. Exits 0 when there's
 * nothing live; exits 1 only when a SIGTERM fails (EPERM, etc).
 */

import { resolve } from 'node:path';
import { type Config, isProcessAlive, resolveLockDir } from '@inkeep/open-knowledge-server';
import { Command } from 'commander';
import { getInvocationCwd } from '../project-anchor.ts';
import { discoverLockDirs } from '../utils/process-scan.ts';
import { inspectLock, type LockState } from './lock-state.ts';
import { runPs } from './ps.ts';

interface StopTargetPlan {
  name: 'server' | 'ui';
  pid: number;
  port: number;
}

interface StopPlan {
  targets: StopTargetPlan[];
}

interface BuildStopPlanDeps {
  /** Override for tests. Defaults to `isProcessAlive` from the server package
   * (POSIX `process.kill(pid, 0)` existence probe — ESRCH/EPERM canonicalized). */
  isAlive?: (pid: number) => boolean;
}

/**
 * Pure plan builder — from two inspected lock states, list which pids to
 * SIGTERM. `alive` states produce a target unconditionally. `foreign-host`
 * states produce a target only when the PID is locally live: macOS hostname
 * drift (BonjourName ↔ FQDN across DHCP/VPN/sleep) routinely flips
 * same-machine entries to `foreign-host`, and refusing to stop them strands
 * the process. Truly-cross-host locks fail the liveness check and are left
 * alone. `missing` / `corrupt` / `dead-pid` belong to `ok clean`.
 */
export function buildStopPlan(
  server: LockState,
  ui: LockState,
  deps: BuildStopPlanDeps = {},
): StopPlan {
  const isAlive = deps.isAlive ?? isProcessAlive;
  const targets: StopTargetPlan[] = [];
  for (const [name, state] of [
    ['server', server],
    ['ui', ui],
  ] as const) {
    if (state.status === 'alive') {
      targets.push({ name, pid: state.lock.pid, port: state.lock.port });
    } else if (state.status === 'foreign-host' && isAlive(state.lock.pid)) {
      targets.push({ name, pid: state.lock.pid, port: state.lock.port });
    }
  }
  return { targets };
}

interface RunStopDeps {
  lockDir: string;
  inspect?: (name: 'server' | 'ui') => LockState;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  isAlive?: (pid: number) => boolean;
  log?: (msg: string) => void;
  error?: (msg: string) => void;
}

interface StopOutcome {
  stopped: StopTargetPlan[];
  failed: Array<{ target: StopTargetPlan; error: string }>;
  hadTargets: boolean;
}

/**
 * Execute a stop plan. Exported for tests so they can drive it without
 * going through Commander. The Commander action wraps this and translates
 * `failed.length > 0` into `process.exitCode = 1`.
 */
export function runStop(deps: RunStopDeps): StopOutcome {
  const inspect = deps.inspect ?? ((name) => inspectLock(deps.lockDir, name));
  const kill = deps.kill ?? ((pid, signal) => process.kill(pid, signal));
  const log = deps.log ?? ((msg) => console.log(msg));
  const error = deps.error ?? ((msg) => console.error(msg));

  const serverState = inspect('server');
  const uiState = inspect('ui');
  const plan = buildStopPlan(serverState, uiState, { isAlive: deps.isAlive });

  if (plan.targets.length === 0) {
    log('No running open-knowledge processes.');
    return { stopped: [], failed: [], hadTargets: false };
  }

  const stopped: StopTargetPlan[] = [];
  const failed: Array<{ target: StopTargetPlan; error: string }> = [];
  for (const target of plan.targets) {
    try {
      kill(target.pid, 'SIGTERM');
      stopped.push(target);
    } catch (err) {
      failed.push({ target, error: err instanceof Error ? err.message : String(err) });
    }
  }

  if (stopped.length > 0) {
    const rendered = stopped.map((t) => `${t.name} (pid=${t.pid}, port=${t.port})`).join(', ');
    log(`Stopped: ${rendered}`);
  }
  if (failed.length > 0) {
    const rendered = failed
      .map(({ target, error: msg }) => `${target.name} (pid=${target.pid}): ${msg}`)
      .join('; ');
    error(`Failed to stop: ${rendered}`);
  }

  return { stopped, failed, hadTargets: true };
}

/**
 * True if this lock state should be considered stoppable by `ok stop`.
 * `alive` is unconditional. `foreign-host` matches when the PID is locally
 * live — same hostname-drift logic as `buildStopPlan`. `dead-pid` /
 * `missing` / `corrupt` never match.
 */
function isStoppableState(
  state: LockState,
  isAlive: (pid: number) => boolean,
): state is Extract<LockState, { status: 'alive' | 'foreign-host' }> {
  if (state.status === 'alive') return true;
  if (state.status === 'foreign-host') return isAlive(state.lock.pid);
  return false;
}

/**
 * Find the lock dir matching a port or PID (either server or UI slot).
 * Port is checked before PID; returns null if nothing matches. Considers
 * both `alive` and same-machine `foreign-host` (hostname-drift) states.
 */
async function findLockDirByNumber(
  n: number,
  isAlive: (pid: number) => boolean = isProcessAlive,
): Promise<string | null> {
  const lockDirs = await discoverLockDirs();
  let pidMatch: string | null = null;
  for (const lockDir of lockDirs) {
    const server = inspectLock(lockDir, 'server');
    const ui = inspectLock(lockDir, 'ui');
    if (isStoppableState(server, isAlive) && server.lock.port === n) return lockDir;
    if (isStoppableState(ui, isAlive) && ui.lock.port === n) return lockDir;
    if (pidMatch === null) {
      if (isStoppableState(server, isAlive) && server.lock.pid === n) pidMatch = lockDir;
      else if (isStoppableState(ui, isAlive) && ui.lock.pid === n) pidMatch = lockDir;
    }
  }
  return pidMatch;
}

function executeStop(lockDir: string): StopOutcome {
  const outcome = runStop({ lockDir });
  if (outcome.failed.length > 0) process.exitCode = 1;
  return outcome;
}

export function stopCommand(getConfig: () => Config): Command {
  return new Command('stop')
    .description(
      'Stop open-knowledge server(s). With no argument: stops the server for the current directory. ' +
        'Pass a port number, a directory path, or "all" to target globally.',
    )
    .argument('[target...]', 'port number, directory path (spaces OK), or "all"')
    .action(async (parts: string[]) => {
      // Rejoin space-split path parts so unquoted paths like /foo/bar baz work
      const target = parts.length === 0 ? undefined : parts.join(' ');

      // No argument — cwd-scoped, but fall through to `ok ps` if nothing found here
      if (target === undefined) {
        // Lock anchor is the project root (cwd for the CLI), not contentDir —
        // `server-factory.ts` writes `<projectDir>/.ok/local/server.lock`. When
        // `content.dir` is a sub-folder (git-root-promotion case), resolving
        // through `resolveContentDir` would look in the wrong tree.
        getConfig(); // still load config to surface any project-config errors
        const lockDir = resolveLockDir(process.cwd());
        // Suppress runStop's own log so we control all output
        const outcome = runStop({ lockDir, log: () => {} });
        if (outcome.hadTargets) {
          if (outcome.stopped.length > 0) {
            const rendered = outcome.stopped
              .map((t) => `${t.name} (pid=${t.pid}, port=${t.port})`)
              .join(', ');
            console.log(`Stopped: ${rendered}`);
          }
          if (outcome.failed.length > 0) process.exitCode = 1;
        } else {
          // Nothing running in cwd — show what's running elsewhere
          await runPs({});
        }
        return;
      }

      // "all" — stop every discovered server
      if (target === 'all') {
        const lockDirs = await discoverLockDirs();
        if (lockDirs.length === 0) {
          console.log('No running open-knowledge servers found.');
          return;
        }
        let stopped = 0;
        for (const lockDir of lockDirs) {
          // Skip lockDirs with nothing stoppable to avoid noisy "no processes" messages.
          // `foreign-host` with a locally-live PID counts (hostname drift).
          const server = inspectLock(lockDir, 'server');
          const ui = inspectLock(lockDir, 'ui');
          if (!isStoppableState(server, isProcessAlive) && !isStoppableState(ui, isProcessAlive))
            continue;
          executeStop(lockDir);
          stopped++;
        }
        if (stopped === 0) console.log('No running open-knowledge servers found.');
        return;
      }

      // Pure digit string — port or PID
      if (/^\d+$/.test(target)) {
        const n = Number.parseInt(target, 10);
        const lockDir = await findLockDirByNumber(n);
        if (lockDir === null) {
          console.log(`No running open-knowledge server found with port or PID ${n}.`);
          return;
        }
        executeStop(lockDir);
        return;
      }

      // Otherwise — treat as a content directory path (handles spaces
      // natively). Resolve relative paths against the directory the user
      // invoked the CLI from — the preAction project anchor may have chdir'd
      // to the enclosing project root, which must not re-base a path the
      // user typed.
      const lockDir = resolveLockDir(resolve(getInvocationCwd(), target));
      executeStop(lockDir);
    });
}

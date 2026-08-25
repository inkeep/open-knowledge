/**
 * `open-knowledge stop` — SIGTERM the live server (plus a lingering legacy
 * `ok ui` holder, a one-release reap); leave stale locks untouched (they belong
 * to `ok clean`).
 *
 * Single-responsibility split from lock pruning. Exits 0 when there's
 * nothing live; exits 1 only when a SIGTERM fails (EPERM, etc).
 */

import { resolve } from 'node:path';
import {
  type Config,
  isProcessAlive,
  lockBaseUrl,
  resolveLockDir,
} from '@inkeep/open-knowledge-server';
import { Command } from 'commander';
import type { Logger as PinoLoggerInstance } from 'pino';
import { getCliLogger } from '../cli-logger.ts';
import { getInvocationCwd } from '../project-anchor.ts';
import { discoverLockDirs } from '../utils/process-scan.ts';
import { inspectLegacyUiLock, inspectLock, type LockState } from './lock-state.ts';
import { runPs } from './ps.ts';

/** How long to wait for the target server to answer the in-use probe. */
const CLIENT_PROBE_TIMEOUT_MS = 1500;

/**
 * Live collaboration clients on the server recorded in `<lockDir>/server.lock`,
 * or `null` when that cannot be established (no lock, no advertised URL, the
 * server does not answer, or it is old enough not to report the count).
 *
 * Provenance — who spawned the server — is deliberately not consulted: the
 * process title is rewritten at start, so no process-inspection signal
 * survives, and a terminal-spawned server with a desktop window attached is
 * exactly the case that must be caught.
 *
 * Every `null` that came from a server we DID try to reach is recorded on the
 * file logger with which failure it was. All of them proceed with the stop, so
 * the distinction survives nowhere else — a server that answered garbage and a
 * server that never answered are the same no-op on stdout.
 */
export async function probeCollabClients(
  lockDir: string,
  logger: PinoLoggerInstance | undefined = getCliLogger(),
): Promise<number | null> {
  const state = inspectLock(lockDir, 'server');
  if (state.status !== 'alive' && state.status !== 'foreign-host') return null;
  const baseUrl = lockBaseUrl(state.lock);
  if (baseUrl === null) return null;
  try {
    const res = await fetch(`${baseUrl}/api/server-info`, {
      signal: AbortSignal.timeout(CLIENT_PROBE_TIMEOUT_MS),
    });
    if (!res.ok) {
      logger?.warn(
        { lockDir, baseUrl, outcome: 'http-error', status: res.status },
        'stop client-probe failed',
      );
      return null;
    }
    const body: unknown = await res.json();
    const count = (body as { collabClients?: unknown } | null)?.collabClients;
    if (typeof count === 'number' && Number.isFinite(count)) return count;
    logger?.warn(
      { lockDir, baseUrl, outcome: 'no-client-count', received: typeof count },
      'stop client-probe failed',
    );
    return null;
  } catch (err) {
    // Unreachable, draining, or mid-start: nothing is usefully attached to a
    // server that cannot answer, so the caller proceeds.
    logger?.warn(
      {
        lockDir,
        baseUrl,
        outcome: 'unreachable',
        err,
      },
      'stop client-probe failed',
    );
    return null;
  }
}

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
  /**
   * Terminate even when the server reports live collaboration clients. Off by
   * default so the safe behavior is what any caller of this published export
   * gets without opting in.
   */
  force?: boolean;
  inspect?: (name: 'server' | 'ui') => LockState;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  isAlive?: (pid: number) => boolean;
  log?: (msg: string) => void;
  error?: (msg: string) => void;
  /** Live-client probe. `null` = could not establish → proceed. */
  probeClients?: (lockDir: string, logger?: PinoLoggerInstance) => Promise<number | null>;
  /** File logger for the durable record. Defaults to the CLI's. */
  logger?: PinoLoggerInstance;
}

interface StopOutcome {
  stopped: StopTargetPlan[];
  failed: Array<{ target: StopTargetPlan; error: string }>;
  hadTargets: boolean;
  /** Set when the stop was refused because clients are attached. */
  declined?: { clients: number };
}

/**
 * Execute a stop plan. Exported for tests so they can drive it without
 * going through Commander. The Commander action wraps this and translates
 * `failed.length > 0` into `process.exitCode = 1`.
 */
export async function runStop(deps: RunStopDeps): Promise<StopOutcome> {
  // The `ui` slot is the one-release legacy reap: `inspectLegacyUiLock` peeks a
  // leftover pre-migration `ok ui` holder so a live one still gets SIGTERM'd.
  // The current binary writes no `ui.lock`, so `server` is the only live slot.
  const inspect =
    deps.inspect ??
    ((name) =>
      name === 'ui' ? inspectLegacyUiLock(deps.lockDir) : inspectLock(deps.lockDir, name));
  const kill = deps.kill ?? ((pid, signal) => process.kill(pid, signal));
  const log = deps.log ?? ((msg) => console.log(msg));
  const error = deps.error ?? ((msg) => console.error(msg));
  const probeClients = deps.probeClients ?? probeCollabClients;
  const logger = deps.logger ?? getCliLogger();

  const serverState = inspect('server');
  const uiState = inspect('ui');
  const plan = buildStopPlan(serverState, uiState, { isAlive: deps.isAlive });

  if (plan.targets.length === 0) {
    log('No running open-knowledge processes.');
    logger?.info({ lockDir: deps.lockDir, targets: 0 }, 'stop found nothing to signal');
    return { stopped: [], failed: [], hadTargets: false };
  }

  if (deps.force !== true) {
    const clients = await probeClients(deps.lockDir, logger);
    if (clients !== null && clients > 0) {
      error(
        `Not stopping: ${clients} collaboration client${clients === 1 ? '' : 's'} ` +
          `(editor window${clients === 1 ? '' : 's'} or agents) still connected to the server at ${deps.lockDir}. ` +
          'Close them, or re-run with --force to terminate anyway.',
      );
      logger?.warn(
        { lockDir: deps.lockDir, clients, pids: plan.targets.map((t) => t.pid) },
        'stop declined: live collaboration clients',
      );
      return { stopped: [], failed: [], hadTargets: true, declined: { clients } };
    }
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
  // Durable record of WHAT was signalled and WHERE — stdout alone leaves a
  // terminated server undiagnosable from a bug bundle.
  logger?.info(
    {
      lockDir: deps.lockDir,
      signalled: stopped.map((t) => ({ name: t.name, pid: t.pid, port: t.port })),
      failed: failed.map(({ target, error: msg }) => ({ pid: target.pid, error: msg })),
      forced: deps.force === true,
    },
    'stop signalled processes',
  );
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
    const ui = inspectLegacyUiLock(lockDir);
    if (isStoppableState(server, isAlive) && server.lock.port === n) return lockDir;
    if (isStoppableState(ui, isAlive) && ui.lock.port === n) return lockDir;
    if (pidMatch === null) {
      if (isStoppableState(server, isAlive) && server.lock.pid === n) pidMatch = lockDir;
      else if (isStoppableState(ui, isAlive) && ui.lock.pid === n) pidMatch = lockDir;
    }
  }
  return pidMatch;
}

async function executeStop(lockDir: string, force: boolean): Promise<StopOutcome> {
  const outcome = await runStop({ lockDir, force });
  if (outcome.failed.length > 0 || outcome.declined !== undefined) process.exitCode = 1;
  return outcome;
}

/**
 * The "found nothing here" message. Names the target, and distinguishes
 * "nothing is running for this directory" from "nothing is running at all" —
 * conflating the two is what made a stop against the wrong directory read as
 * a clean no-op.
 */
export function formatNoTargetMessage(
  targetDir: string,
  otherRunningServers: number,
  opts: {
    /**
     * Set by a caller that prints the `ok ps` listing itself, so the message
     * doesn't tell the user to run what is about to appear below it.
     */
    listingFollows?: boolean;
  } = {},
): string {
  if (otherRunningServers === 0) {
    return `Nothing was running for ${targetDir}, and no other open-knowledge servers are running.`;
  }
  const agreement = otherRunningServers === 1 ? ' is' : 's are';
  const pointer = opts.listingFollows === true ? '' : ' — run `ok ps` to list them';
  return (
    `Nothing was running for ${targetDir}. ${otherRunningServers} other open-knowledge server` +
    `${agreement} running${pointer}.`
  );
}

/**
 * Count servers running OUTSIDE `exceptLockDir`, so a stop that found nothing
 * here can say so without claiming nothing is running anywhere.
 */
async function countOtherRunningServers(exceptLockDir: string): Promise<number> {
  const lockDirs = await discoverLockDirs();
  let count = 0;
  for (const lockDir of lockDirs) {
    if (lockDir === exceptLockDir) continue;
    if (
      isStoppableState(inspectLock(lockDir, 'server'), isProcessAlive) ||
      // Legacy `ok ui` holder: the current binary writes no `ui.lock`, so this
      // only matches a leftover pre-migration process.
      isStoppableState(inspectLegacyUiLock(lockDir), isProcessAlive)
    ) {
      count++;
    }
  }
  return count;
}

export function stopCommand(getConfig: () => Config): Command {
  return new Command('stop')
    .description(
      'Stop open-knowledge server(s). With no argument: stops the server for the current directory. ' +
        'Pass a port number, a directory path, or "all" to target globally.',
    )
    .argument('[target...]', 'port number, directory path (spaces OK), or "all"')
    .option('--force', 'Stop even when editor windows or agents are still connected to the server')
    .action(async (parts: string[], options: { force?: boolean }) => {
      const force = options.force === true;
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
        const outcome = await runStop({ lockDir, force, log: () => {} });
        if (outcome.hadTargets) {
          if (outcome.stopped.length > 0) {
            const rendered = outcome.stopped
              .map((t) => `${t.name} (pid=${t.pid}, port=${t.port})`)
              .join(', ');
            console.log(`Stopped: ${rendered}`);
          }
          if (outcome.failed.length > 0 || outcome.declined !== undefined) process.exitCode = 1;
        } else {
          // Nothing running in cwd — same phrasing as an explicitly targeted
          // directory (one formatter, one wording), then the listing itself
          // rather than the pointer to it.
          const others = await countOtherRunningServers(lockDir);
          console.log(formatNoTargetMessage(process.cwd(), others, { listingFollows: others > 0 }));
          if (others > 0) await runPs({});
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
          const ui = inspectLegacyUiLock(lockDir);
          if (!isStoppableState(server, isProcessAlive) && !isStoppableState(ui, isProcessAlive))
            continue;
          await executeStop(lockDir, force);
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
        await executeStop(lockDir, force);
        return;
      }

      // Otherwise — treat as a content directory path (handles spaces
      // natively). Resolve relative paths against the directory the user
      // invoked the CLI from — the preAction project anchor may have chdir'd
      // to the enclosing project root, which must not re-base a path the
      // user typed.
      const targetDir = resolve(getInvocationCwd(), target);
      const lockDir = resolveLockDir(targetDir);
      // Buffer runStop's own output: its generic "nothing here" line is
      // replaced below by one that names the target and the wider state.
      const buffered: string[] = [];
      const outcome = await runStop({ lockDir, force, log: (msg) => buffered.push(msg) });
      if (outcome.failed.length > 0 || outcome.declined !== undefined) process.exitCode = 1;
      if (outcome.hadTargets) {
        for (const line of buffered) console.log(line);
      } else {
        console.log(formatNoTargetMessage(targetDir, await countOtherRunningServers(lockDir)));
      }
    });
}

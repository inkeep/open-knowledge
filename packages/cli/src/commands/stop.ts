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
import { describeLockOwnershipRefusal, inspectLock, type LockState } from './lock-state.ts';
import { runPs } from './ps.ts';
import { buildStopV1, stopV1Failure } from './stop-v1.ts';
import type { V1Project, V1StopTarget } from './supervision-json-v1.ts';
import { addV1FormatOption, writeV1Document } from './supervision-json-v1-output.ts';

const CLIENT_PROBE_TIMEOUT_MS = 1500;

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
      redirect: 'manual',
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
  name: 'server';
  pid: number;
  port: number;
}

interface StopPlan {
  targets: StopTargetPlan[];
}

interface BuildStopPlanDeps {
  isAlive?: (pid: number) => boolean;
}

export function buildStopPlan(server: LockState, deps: BuildStopPlanDeps = {}): StopPlan {
  const isAlive = deps.isAlive ?? isProcessAlive;
  return {
    targets: isStoppableState(server, isAlive)
      ? [{ name: 'server', pid: server.lock.pid, port: server.lock.port }]
      : [],
  };
}

interface RunStopDeps {
  lockDir: string;
  force?: boolean;
  inspect?: () => LockState;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  isAlive?: (pid: number) => boolean;
  log?: (msg: string) => void;
  error?: (msg: string) => void;
  probeClients?: (lockDir: string, logger?: PinoLoggerInstance) => Promise<number | null>;
  logger?: PinoLoggerInstance;
}

interface StopOutcome {
  stopped: StopTargetPlan[];
  failed: Array<{ target: StopTargetPlan; error: string }>;
  hadTargets: boolean;
  declined?: { clients: number };
  decision: {
    code:
      | 'signalled'
      | 'already-stopped'
      | 'clients-connected'
      | 'ownership-unverified'
      | 'signal-failed';
    detail: string | null;
  };
}

export async function runStop(deps: RunStopDeps): Promise<StopOutcome> {
  const inspect = deps.inspect ?? (() => inspectLock(deps.lockDir, 'server'));
  const kill = deps.kill ?? ((pid, signal) => process.kill(pid, signal));
  const log = deps.log ?? ((msg) => console.log(msg));
  const error = deps.error ?? ((msg) => console.error(msg));
  const probeClients = deps.probeClients ?? probeCollabClients;
  const logger = deps.logger ?? getCliLogger();

  const serverState = inspect();
  const plan = buildStopPlan(serverState, { isAlive: deps.isAlive });

  if (plan.targets.length === 0) {
    log('No running open-knowledge processes.');
    logger?.info({ lockDir: deps.lockDir, targets: 0 }, 'stop found nothing to signal');
    return {
      stopped: [],
      failed: [],
      hadTargets: false,
      decision: {
        code:
          serverState.status === 'unverified-owner' || serverState.status === 'read-error'
            ? 'ownership-unverified'
            : 'already-stopped',
        detail:
          serverState.status === 'unverified-owner'
            ? describeLockOwnershipRefusal(serverState)
            : null,
      },
    };
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
      return {
        stopped: [],
        failed: [],
        hadTargets: true,
        declined: { clients },
        decision: {
          code: 'clients-connected',
          detail: `${clients} collaboration clients are connected.`,
        },
      };
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

  return {
    stopped,
    failed,
    hadTargets: true,
    decision:
      failed.length > 0
        ? { code: 'signal-failed', detail: failed.map((item) => item.error).join('; ') }
        : { code: 'signalled', detail: 'SIGTERM sent.' },
  };
}

function isStoppableState(
  state: LockState,
  isAlive: (pid: number) => boolean,
): state is Extract<LockState, { status: 'alive' | 'foreign-host' }> {
  if (state.status === 'alive') return true;
  if (state.status === 'foreign-host') return isAlive(state.lock.pid);
  return false;
}

export async function findLockDirByNumber(
  n: number,
  isAlive: (pid: number) => boolean = isProcessAlive,
  discover: () => Promise<string[]> = discoverLockDirs,
  inspect: (lockDir: string) => LockState = (lockDir) => inspectLock(lockDir, 'server'),
): Promise<string | null> {
  const lockDirs = await discover();
  let pidMatch: string | null = null;
  for (const lockDir of lockDirs) {
    const server = inspect(lockDir);
    if (!isStoppableState(server, isAlive)) continue;
    if (server.lock.port === n) return lockDir;
    if (pidMatch === null && server.lock.pid === n) pidMatch = lockDir;
  }
  return pidMatch;
}

async function executeStop(lockDir: string, force: boolean): Promise<StopOutcome> {
  const outcome = await runStop({ lockDir, force });
  if (outcome.failed.length > 0 || outcome.declined !== undefined) process.exitCode = 1;
  return outcome;
}

export function formatNoTargetMessage(
  targetDir: string,
  otherRunningServers: number,
  opts: {
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

async function countOtherRunningServers(exceptLockDir: string): Promise<number> {
  const lockDirs = await discoverLockDirs();
  let count = 0;
  for (const lockDir of lockDirs) {
    if (lockDir === exceptLockDir) continue;
    if (isStoppableState(inspectLock(lockDir, 'server'), isProcessAlive)) {
      count++;
    }
  }
  return count;
}

export function stopCommand(
  getConfig: () => Config,
  getV1Context?: () => { project: V1Project; failure: string | null },
): Command {
  return addV1FormatOption(
    new Command('stop')
      .description(
        'Stop open-knowledge server(s). With no argument: stops the server for the enclosing project — run it from anywhere inside the project. ' +
          'Pass a port number, a directory path, or "all" to target globally.',
      )
      .argument('[target...]', 'port number, directory path (spaces OK), or "all"')
      .option(
        '--force',
        'Stop even when editor windows or agents are still connected to the server',
      ),
  ).action(async (parts: string[], options: { force?: boolean; format?: string }) => {
    const force = options.force === true;
    const target = parts.length === 0 ? undefined : parts.join(' ');

    if (options.format === 'json-v1') {
      const context = getV1Context?.() ?? {
        project: { root: process.cwd(), resolution: 'cwd' as const },
        failure: null,
      };
      const kind: V1StopTarget['kind'] =
        target === undefined
          ? 'project'
          : target === 'all'
            ? 'all'
            : /^\d+$/.test(target)
              ? 'number'
              : 'path';
      const selector: V1StopTarget = { kind, value: target ?? null, projectRoot: null };
      if (context.failure !== null) {
        writeV1Document(stopV1Failure(selector, force, 'project-unavailable', context.failure));
        return;
      }
      try {
        writeV1Document(await buildStopV1({ target, force, projectRoot: context.project.root }));
      } catch (error) {
        writeV1Document(
          stopV1Failure(
            selector,
            force,
            'operation-failed',
            error instanceof Error ? error.message : String(error),
          ),
        );
      }
      return;
    }

    if (target === undefined) {
      getConfig();
      const lockDir = resolveLockDir(process.cwd());
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
        const others = await countOtherRunningServers(lockDir);
        console.log(formatNoTargetMessage(process.cwd(), others, { listingFollows: others > 0 }));
        if (others > 0) await runPs({});
      }
      return;
    }

    if (target === 'all') {
      const lockDirs = await discoverLockDirs();
      if (lockDirs.length === 0) {
        console.log('No running open-knowledge servers found.');
        return;
      }
      let stopped = 0;
      for (const lockDir of lockDirs) {
        if (!isStoppableState(inspectLock(lockDir, 'server'), isProcessAlive)) continue;
        await executeStop(lockDir, force);
        stopped++;
      }
      if (stopped === 0) console.log('No running open-knowledge servers found.');
      return;
    }

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

    const targetDir = resolve(getInvocationCwd(), target);
    const lockDir = resolveLockDir(targetDir);
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

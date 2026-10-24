import {
  CHECKOUT_CLI_COMMAND,
  currentCliCommandName,
  DEV_CHANNEL,
  desktopChannelLabel,
  resolveDesktopProductName,
} from '@inkeep/open-knowledge-core';
import {
  assessLockHolder,
  isProcessAlive,
  lockBaseUrl,
  type ProcessLockMetadata,
  type ProcessStart,
  type ProcessStartCause,
  type UnverifiedLockHolderCause,
} from '@inkeep/open-knowledge-server';
import type { Logger as PinoLoggerInstance } from 'pino';
import { getCliLogger } from '../cli-logger.ts';
import { escapeDisplayPath } from '../utils/escape-display-path.ts';
import { discoverLockDirs } from '../utils/process-scan.ts';
import {
  describeHolderStartReadFailure,
  type HolderProcessStartOptions,
  type NativeFailure,
  readHolderProcessStart,
} from './holder-process-start.ts';
import {
  describeForeignOwner,
  describeOtherHomeFolderRemedy,
  describeUnrecordedOwner,
  inspectLock,
  type LockState,
} from './lock-state.ts';

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

interface StopTarget {
  name: 'server';
  pid: number;
}

interface StopTargetPlan extends StopTarget {
  port: number;
}

interface StopPlan {
  targets: StopTargetPlan[];
  lock?: ProcessLockMetadata;
}

interface BuildStopPlanDeps {
  isAlive?: (pid: number) => boolean;
}

export function buildStopPlan(server: LockState, deps: BuildStopPlanDeps = {}): StopPlan {
  const isAlive = deps.isAlive ?? isProcessAlive;
  if (!isStoppableState(server, isAlive)) return { targets: [] };
  return {
    targets: [{ name: 'server', pid: server.lock.pid, port: server.lock.port }],
    lock: server.lock,
  };
}

interface RunStopDeps {
  lockDir: string;
  force?: boolean;
  inspect?: () => LockState;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  isAlive?: (pid: number) => boolean;
  readProcessStart?: (pid: number, options?: HolderProcessStartOptions) => ProcessStart | null;
  log?: (msg: string) => void;
  error?: (msg: string) => void;
  probeClients?: (lockDir: string, logger?: PinoLoggerInstance) => Promise<number | null>;
  logger?: PinoLoggerInstance;
  selfChannel?: 'stable' | 'beta' | 'dev';
  platform?: NodeJS.Platform;
  refuseHolderStartedAfterLock?: boolean;
}

interface UnconfirmedStartHolder {
  readonly cause: ProcessStartCause;
  readonly pid: number;
  readonly lockPath: string;
  readonly platform: NodeJS.Platform;
  readonly nativeFailures: readonly NativeFailure[];
}

type UnverifiedHolder =
  | UnconfirmedStartHolder
  | {
      readonly cause: 'foreign-host';
      readonly pid: number;
      readonly lockPath: string;
      readonly lock: ProcessLockMetadata;
      readonly platform: NodeJS.Platform;
    }
  | { readonly cause: 'unverified-owner'; readonly pid: number; readonly lockPath: string };

interface StopFailure {
  target: StopTarget;
  error: string;
  unverified?: UnverifiedHolder;
}

export interface StopOutcome {
  stopped: StopTargetPlan[];
  failed: StopFailure[];
  hadTargets: boolean;
  declined?: { clients: number } | { otherChannel: string };
  decision: {
    code:
      | 'signalled'
      | 'already-stopped'
      | 'clients-connected'
      | 'channel-mismatch'
      | 'ownership-unverified'
      | 'signal-failed';
    detail: string | null;
  };
}

function currentChannel(logger: PinoLoggerInstance | undefined): RunStopDeps['selfChannel'] {
  try {
    return resolveDesktopProductName();
  } catch (err) {
    logger?.warn(
      { err },
      `stop channel check skipped: ${err instanceof Error ? err.message : String(err)}`,
    );
    return undefined;
  }
}

export async function runStop(deps: RunStopDeps): Promise<StopOutcome> {
  const inspect = deps.inspect ?? (() => inspectLock(deps.lockDir, 'server'));
  const kill = deps.kill ?? ((pid, signal) => process.kill(pid, signal));
  const log = deps.log ?? ((msg) => console.log(msg));
  const error = deps.error ?? ((msg) => console.error(msg));
  const probeClients = deps.probeClients ?? probeCollabClients;
  const logger = deps.logger ?? getCliLogger();
  const platform = deps.platform ?? process.platform;

  const serverState = inspect();
  const plan = buildStopPlan(serverState, { isAlive: deps.isAlive });
  const { lock } = plan;
  let decision: StopOutcome['decision'] = { code: 'already-stopped', detail: null };
  const stopped: StopTargetPlan[] = [];
  const failed: StopFailure[] = [];
  const refuse = (target: StopTarget, holder: UnverifiedHolder): void => {
    logger?.warn(
      {
        lockDir: deps.lockDir,
        lockPath: holder.lockPath,
        lockPid: holder.pid,
        platform,
        cause: holder.cause,
        ...('nativeFailures' in holder && holder.nativeFailures.length > 0
          ? { nativeFailures: holder.nativeFailures }
          : {}),
      },
      'stop declined: lock holder identity unverified',
    );
    decision = {
      code: 'ownership-unverified',
      detail: describeUnverifiedHolderForStop(holder, logger !== undefined),
    };
    failed.push({
      target,
      error: describeUnverifiedHolderForStop(holder, logger !== undefined),
      unverified: holder,
    });
  };
  const report = (): StopOutcome => {
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
    return { stopped, failed, hadTargets: true, decision };
  };

  if (serverState.status === 'unverified-owner') {
    const { pid, lockPath } = serverState;
    refuse({ name: 'server', pid }, { cause: 'unverified-owner', pid, lockPath });
    return report();
  }

  if (lock === undefined) {
    log('No running open-knowledge processes.');
    logger?.info({ lockDir: deps.lockDir, targets: 0 }, 'stop found nothing to signal');
    return {
      stopped: [],
      failed: [],
      hadTargets: false,
      decision: {
        code: serverState.status === 'read-error' ? 'ownership-unverified' : 'already-stopped',
        detail: serverState.status === 'read-error' ? serverState.error : null,
      },
    };
  }

  const holder =
    serverState.status === 'alive' || serverState.status === 'foreign-host'
      ? serverState.lock.channel
      : undefined;
  if (deps.force !== true && typeof holder === 'string' && holder.length > 0) {
    const self = deps.selfChannel ?? currentChannel(logger);
    if (self !== undefined && holder !== self) {
      error(
        `Not stopping: the server at ${deps.lockDir} belongs to ${desktopChannelLabel(holder)}. ` +
          (holder === DEV_CHANNEL
            ? `Stop it from that dev build, or run \`${CHECKOUT_CLI_COMMAND} stop\` with OK_CHANNEL=dev set, or re-run with --force to terminate anyway.`
            : 'Stop it from that app or its CLI, or re-run with --force to terminate anyway.'),
      );
      logger?.warn(
        {
          lockDir: deps.lockDir,
          holderChannel: holder,
          selfChannel: self,
          pids: plan.targets.map((t) => t.pid),
        },
        'stop declined: server belongs to another channel',
      );
      return {
        stopped: [],
        failed: [],
        hadTargets: true,
        declined: { otherChannel: holder },
        decision: {
          code: 'channel-mismatch',
          detail: `The server belongs to ${desktopChannelLabel(holder)}. Stop it from that app or its CLI, or re-run with --force to terminate anyway.`,
        },
      };
    }
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

  for (const target of plan.targets) {
    const nativeFailures: NativeFailure[] = [];
    const holderStart = (deps.readProcessStart ?? readHolderProcessStart)(target.pid, {
      platform,
      onNativeFailure: (failure) => {
        nativeFailures.push(failure);
      },
    });
    const assessment = assessLockHolder(lock, {
      isAlive: deps.isAlive ?? isProcessAlive,
      readProcessStart: () => holderStart,
      refuseHolderStartedAfterLock: deps.refuseHolderStartedAfterLock,
    });
    switch (assessment.verdict) {
      case 'writer':
        try {
          kill(target.pid, 'SIGTERM');
          stopped.push(target);
          decision = { code: 'signalled', detail: 'SIGTERM sent.' };
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          failed.push({ target, error: detail });
          decision = { code: 'signal-failed', detail };
        }
        break;
      case 'gone':
        decision = {
          code: 'already-stopped',
          detail: 'The server exited before it could be signalled.',
        };
        log(`${target.name} (pid=${target.pid}) had already exited`);
        break;
      case 'replaced':
        decision = {
          code: 'already-stopped',
          detail: 'The PID now belongs to another process; no signal was sent.',
        };
        error(
          `Process ${target.pid} is no longer the server that wrote ${serverState.lockPath}; it was not signalled. ` +
            `Run \`${currentCliCommandName()} clean\` to remove the stale lock.`,
        );
        break;
      case 'unverified':
        refuse(
          target,
          unverifiedHolder(assessment.cause, {
            pid: target.pid,
            lockPath: serverState.lockPath,
            lock,
            platform,
            nativeFailures,
          }),
        );
        break;
      default: {
        const exhaustive: never = assessment;
        return exhaustive;
      }
    }
  }

  return report();
}

function unverifiedHolder(
  cause: UnverifiedLockHolderCause,
  found: {
    pid: number;
    lockPath: string;
    lock: ProcessLockMetadata;
    platform: NodeJS.Platform;
    nativeFailures: readonly NativeFailure[];
  },
): UnverifiedHolder {
  const { pid, lockPath } = found;
  switch (cause) {
    case 'foreign-host':
      return { cause, pid, lockPath, lock: found.lock, platform: found.platform };
    case 'unverified-owner':
      return { cause, pid, lockPath };
    default:
      return {
        cause,
        pid,
        lockPath,
        platform: found.platform,
        nativeFailures: found.nativeFailures,
      };
  }
}

const STOP_NOT_SIGNALLED = 'it was not signalled, and --force does not override this check.';

function describeUnverifiedHolderForStop(holder: UnverifiedHolder, causeRecorded: boolean): string {
  const { pid, lockPath } = holder;
  switch (holder.cause) {
    case 'foreign-host': {
      const { lock } = holder;
      if (typeof lock.machineId !== 'string') {
        return (
          `The server lock at ${lockPath} ${describeForeignOwner(lock)}, and the start of process ${pid}, which is running on this machine, does not confirm it as the server that wrote the lock; ` +
          `${STOP_NOT_SIGNALLED} If ${escapeDisplayPath(lock.hostname)} is another machine, stop the server there. ` +
          `If it is an earlier name of this machine, confirm that process ${pid} is an OpenKnowledge server before ending it yourself, and once no OpenKnowledge server is running for this project, remove ${lockPath}.`
        );
      }
      return (
        `The server lock at ${lockPath} ${describeForeignOwner(lock)}, so process ${pid}, which is running on this machine, cannot be confirmed as the server that wrote it; ` +
        `${STOP_NOT_SIGNALLED} ${describeOtherHomeFolderRemedy(lock, holder.platform)}`
      );
    }
    case 'unverified-owner':
      return (
        `The server lock at ${lockPath} ${describeUnrecordedOwner(pid)}, so it cannot be confirmed as the server that wrote the lock; ` +
        `${STOP_NOT_SIGNALLED} Check whether process ${pid} is an OpenKnowledge server, and if it is, stop it yourself. ` +
        'Do not remove the lock file while that process is running.'
      );
    default: {
      const refusal = describeUnconfirmedHolderStart(
        holder,
        STOP_NOT_SIGNALLED,
        `Once you have confirmed no OpenKnowledge server is running for this project, remove ${lockPath}.`,
        causeRecorded,
      );
      if (holder.cause !== 'writer-identity-unrecorded') return refusal;
      return `${refusal} A server you start again with this release records its machine ID, so \`${currentCliCommandName()} stop\` can confirm it.`;
    }
  }
}

export function describeUnconfirmedHolderStart(
  holder: UnconfirmedStartHolder,
  notSignalled: string,
  afterManualStop: string,
  causeRecorded: boolean,
): string {
  const { pid, lockPath, platform, nativeFailures } = holder;
  const confirmFirst = `Before ending process ${pid} yourself, confirm that it is an OpenKnowledge server.`;
  switch (holder.cause) {
    case 'process-start-unreadable':
      return (
        `Could not read when process ${pid} started, so it cannot be confirmed as the server that wrote ${lockPath}; ` +
        `${notSignalled} ` +
        describeHolderStartReadFailure({ platform, pid, nativeFailures, causeRecorded }) +
        `${confirmFirst} ${afterManualStop}`
      );
    case 'process-start-incomparable':
      return (
        `The start of process ${pid} cannot be compared with the start recorded in ${lockPath}, so it cannot be confirmed as the server that wrote the lock; ` +
        `${notSignalled} ${confirmFirst} ${afterManualStop}`
      );
    case 'process-start-mismatch':
      return (
        `Process ${pid} started before the start recorded in ${lockPath}, so it cannot be confirmed as the server that wrote the lock; ` +
        `${notSignalled} ${confirmFirst} ${afterManualStop}`
      );
    case 'process-started-after-lock':
      return (
        `Process ${pid} started after the server lock at ${lockPath} was written, so it cannot be confirmed as the server that wrote the lock; ` +
        `${notSignalled} ${confirmFirst} ${afterManualStop}`
      );
    case 'recorded-start-in-future':
      return (
        `The server lock at ${lockPath} records a start later than the current time on this machine, so process ${pid} cannot be confirmed as the server that wrote it; ` +
        `${notSignalled} ${confirmFirst} ${afterManualStop}`
      );
    case 'writer-identity-unrecorded':
      return (
        `The server lock at ${lockPath} records neither a machine ID nor a process start, as locks written by version 0.25.0 and earlier do, so process ${pid} cannot be confirmed as the server that wrote it; ` +
        `${notSignalled} ${confirmFirst} ${afterManualStop}`
      );
    default: {
      const exhaustive: never = holder.cause;
      return exhaustive;
    }
  }
}

export function isStoppableState(
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

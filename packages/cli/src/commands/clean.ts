import {
  type Config,
  isLockProcessRunning,
  LOCK_FILE_ACCESS_REMEDY,
  type LockRemoval,
  removeLockIfUnchanged,
  resolveLockDir,
} from '@inkeep/open-knowledge-server';
import { Command } from 'commander';
import { describeLockOwnershipRefusal, inspectLock, type LockState } from './lock-state.ts';

interface PruneTarget {
  name: 'server';
  lockPath: string;
  reason: 'dead-pid' | 'reused-pid' | 'corrupt';
  text: string;
}

interface CleanPlan {
  prune: PruneTarget[];
  refusal?: { lockPath: string; error: string };
}

function pruneOnly(server: Extract<LockState, { status: PruneTarget['reason'] }>): CleanPlan {
  return {
    prune: [
      { name: 'server', lockPath: server.lockPath, reason: server.status, text: server.text },
    ],
  };
}

export function buildCleanPlan(server: LockState): CleanPlan {
  switch (server.status) {
    case 'read-error':
      return {
        prune: [],
        refusal: {
          lockPath: server.lockPath,
          error: `Cannot read the server lock: ${server.error}. ${LOCK_FILE_ACCESS_REMEDY}`,
        },
      };
    case 'corrupt':
      if (server.foreignHost) {
        return {
          prune: [],
          refusal: {
            lockPath: server.lockPath,
            error: describeLockOwnershipRefusal(server),
          },
        };
      }
      return pruneOnly(server);
    case 'dead-pid':
    case 'reused-pid':
      return pruneOnly(server);
    case 'unverified-owner':
    case 'foreign-host':
      return {
        prune: [],
        refusal: { lockPath: server.lockPath, error: describeLockOwnershipRefusal(server) },
      };
    case 'alive':
    case 'missing':
      return { prune: [] };
    default: {
      const exhaustive: never = server;
      return exhaustive;
    }
  }
}

interface RunCleanDeps {
  lockDir: string;
  inspect?: () => LockState;
  unlink?: (path: string) => void;
  log?: (msg: string) => void;
  error?: (msg: string) => void;
}

interface CleanOutcome {
  pruned: PruneTarget[];
  failed: Array<{ target: Pick<PruneTarget, 'name' | 'lockPath'>; error: string }>;
}

const unremovedLockReasons: Record<Exclude<LockRemoval, 'removed'>, string> = {
  changed: 'the lock changed after it was checked, so it was left in place',
  missing: 'the lock was removed after it was checked',
};

function removeUnlessChanged(target: PruneTarget): void {
  const removal = removeLockIfUnchanged(target.lockPath, target.text);
  if (removal !== 'removed') throw new Error(unremovedLockReasons[removal]);
}

export function runClean(deps: RunCleanDeps): CleanOutcome {
  const inspect =
    deps.inspect ?? (() => inspectLock(deps.lockDir, 'server', { isAlive: isLockProcessRunning }));
  const log = deps.log ?? ((msg) => console.log(msg));
  const error = deps.error ?? ((msg) => console.error(msg));

  const injectedUnlink = deps.unlink;
  const unlink = injectedUnlink
    ? (target: PruneTarget) => injectedUnlink(target.lockPath)
    : removeUnlessChanged;
  const plan = buildCleanPlan(inspect());

  if (plan.refusal) {
    error(`${plan.refusal.lockPath}: ${plan.refusal.error}`);
    return {
      pruned: [],
      failed: [
        { target: { name: 'server', lockPath: plan.refusal.lockPath }, error: plan.refusal.error },
      ],
    };
  }
  if (plan.prune.length === 0) {
    log('No stale locks.');
    return { pruned: [], failed: [] };
  }

  const pruned: PruneTarget[] = [];
  const failed: Array<{ target: Pick<PruneTarget, 'name' | 'lockPath'>; error: string }> = [];
  for (const target of plan.prune) {
    try {
      unlink(target);
      pruned.push(target);
    } catch (err) {
      failed.push({ target, error: err instanceof Error ? err.message : String(err) });
    }
  }

  if (pruned.length > 0) {
    const detail = pruned.map((t) => `${t.name} (${t.reason})`).join(', ');
    log(`Pruned ${pruned.length} stale lock${pruned.length === 1 ? '' : 's'}: ${detail}`);
  }
  if (failed.length > 0) {
    const rendered = failed
      .map(({ target, error: msg }) => `${target.name} (${target.lockPath}): ${msg}`)
      .join('; ');
    error(`Failed to prune: ${rendered}`);
  }

  return { pruned, failed };
}

export function cleanCommand(getConfig: () => Config): Command {
  return new Command('clean')
    .description('Prune a stale / corrupt open-knowledge lock file (never touches live locks)')
    .action(() => {
      getConfig();
      const lockDir = resolveLockDir(process.cwd());
      const outcome = runClean({ lockDir });
      if (outcome.failed.length > 0) {
        process.exitCode = 1;
      }
    });
}

import { unlinkSync } from 'node:fs';
import { isLockProcessRunning } from '@inkeep/open-knowledge-server';
import { describeLockOwnershipRefusal, inspectLock, type LockState } from './lock-state.ts';

interface PruneTarget {
  name: 'server';
  lockPath: string;
  reason: 'dead-pid' | 'corrupt';
}

interface CleanPlan {
  prune: PruneTarget[];
  refusal?: { lockPath: string; error: string };
}

export function buildCleanPlan(server: LockState): CleanPlan {
  switch (server.status) {
    case 'read-error':
      return {
        prune: [],
        refusal: {
          lockPath: server.lockPath,
          error: `Cannot read the server lock: ${server.error}. Restore file and parent-directory access, then retry.`,
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
      return { prune: [{ name: 'server', lockPath: server.lockPath, reason: server.status }] };
    case 'dead-pid':
      return { prune: [{ name: 'server', lockPath: server.lockPath, reason: server.status }] };
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
  decision: {
    code:
      | 'stale-removed'
      | 'nothing-to-clean'
      | 'live-retained'
      | 'ownership-unverified'
      | 'read-failed'
      | 'remove-failed';
    detail: string | null;
    lockPath: string;
  };
}

export function runClean(deps: RunCleanDeps): CleanOutcome {
  const inspect =
    deps.inspect ?? (() => inspectLock(deps.lockDir, 'server', { isAlive: isLockProcessRunning }));
  const unlink = deps.unlink ?? ((path) => unlinkSync(path));
  const log = deps.log ?? ((msg) => console.log(msg));
  const error = deps.error ?? ((msg) => console.error(msg));

  const state = inspect();
  const plan = buildCleanPlan(state);

  if (plan.refusal) {
    error(`${plan.refusal.lockPath}: ${plan.refusal.error}`);
    return {
      pruned: [],
      failed: [
        { target: { name: 'server', lockPath: plan.refusal.lockPath }, error: plan.refusal.error },
      ],
      decision: {
        code: state.status === 'read-error' ? 'read-failed' : 'ownership-unverified',
        detail: plan.refusal.error,
        lockPath: state.lockPath,
      },
    };
  }
  if (plan.prune.length === 0) {
    log('No stale locks.');
    return {
      pruned: [],
      failed: [],
      decision: {
        code: state.status === 'alive' ? 'live-retained' : 'nothing-to-clean',
        detail: null,
        lockPath: state.lockPath,
      },
    };
  }

  const pruned: PruneTarget[] = [];
  const failed: Array<{ target: Pick<PruneTarget, 'name' | 'lockPath'>; error: string }> = [];
  for (const target of plan.prune) {
    try {
      unlink(target.lockPath);
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

  return {
    pruned,
    failed,
    decision:
      failed.length > 0
        ? {
            code: 'remove-failed',
            detail: failed.map((item) => item.error).join('; '),
            lockPath: state.lockPath,
          }
        : { code: 'stale-removed', detail: null, lockPath: state.lockPath },
  };
}

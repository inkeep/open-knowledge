import { unlinkSync } from 'node:fs';
import { type Config, resolveLockDir } from '@inkeep/open-knowledge-server';
import { Command } from 'commander';
import { inspectLock, type LockState } from './lock-state.ts';

interface PruneTarget {
  name: 'server';
  lockPath: string;
  reason: 'dead-pid' | 'corrupt';
}

interface CleanPlan {
  prune: PruneTarget[];
}

export function buildCleanPlan(server: LockState): CleanPlan {
  const prune: PruneTarget[] = [];
  if (server.status === 'dead-pid' || server.status === 'corrupt') {
    prune.push({ name: 'server', lockPath: server.lockPath, reason: server.status });
  }
  return { prune };
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
  failed: Array<{ target: PruneTarget; error: string }>;
}

export function runClean(deps: RunCleanDeps): CleanOutcome {
  const inspect = deps.inspect ?? (() => inspectLock(deps.lockDir, 'server'));
  const unlink = deps.unlink ?? ((path) => unlinkSync(path));
  const log = deps.log ?? ((msg) => console.log(msg));
  const error = deps.error ?? ((msg) => console.error(msg));

  const plan = buildCleanPlan(inspect());

  if (plan.prune.length === 0) {
    log('No stale locks.');
    return { pruned: [], failed: [] };
  }

  const pruned: PruneTarget[] = [];
  const failed: Array<{ target: PruneTarget; error: string }> = [];
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

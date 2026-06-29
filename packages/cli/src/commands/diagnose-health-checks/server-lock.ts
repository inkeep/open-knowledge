import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { resolveLockDir } from '@inkeep/open-knowledge-server';
import { inspectLock, type LockState } from '../lock-state.ts';
import type { CheckContext, CheckDefinition, CheckResult } from './types.ts';

interface ServerLockCheckDeps {
  inspect?: (lockDir: string, name: 'server' | 'ui') => LockState;
}

export function makeServerLockCheck(deps: ServerLockCheckDeps = {}): CheckDefinition {
  const inspect = deps.inspect ?? inspectLock;
  return {
    name: 'server-lock',
    run: async (ctx: CheckContext): Promise<CheckResult> => {
      const lockDir = resolveLockDir(ctx.cwd);
      if (!existsSync(lockDir)) {
        return {
          name: 'server-lock',
          status: 'pass',
          summary: 'no server lock (no `.ok/local/` yet)',
        };
      }
      const state = inspect(lockDir, 'server');
      switch (state.status) {
        case 'missing':
          return {
            name: 'server-lock',
            status: 'pass',
            summary: 'no server holding the lock',
          };
        case 'alive':
          return {
            name: 'server-lock',
            status: 'fail',
            summary: `server lock held by pid ${state.lock.pid} on this host`,
            remediation: 'Stop the other OpenKnowledge process or run `ok stop`.',
            detail: `lockPath: ${state.lockPath}; port: ${state.lock.port}; started: ${state.lock.startedAt}`,
          };
        case 'foreign-host':
          return {
            name: 'server-lock',
            status: 'warn',
            summary: `lock claimed by ${state.lock.hostname} (foreign host)`,
            remediation: `Run \`ok clean\` to prune the stale lock at ${resolve(lockDir, 'server.lock')}.`,
            detail: `lockPath: ${state.lockPath}; pid: ${state.lock.pid}`,
          };
        case 'dead-pid':
          return {
            name: 'server-lock',
            status: 'warn',
            summary: `stale lock for non-existent pid ${state.lock.pid}`,
            remediation: 'Run `ok clean` to prune.',
            detail: `lockPath: ${state.lockPath}`,
          };
        case 'corrupt':
          return {
            name: 'server-lock',
            status: 'warn',
            summary: 'server.lock is corrupt (unparseable or invalid pid)',
            remediation: `Delete ${state.lockPath} and rerun.`,
          };
        default: {
          const _exhaustive: never = state;
          return _exhaustive;
        }
      }
    },
  };
}

/**
 * `shadow-repo` check — resolves the shadow gitdir for the project and
 * verifies its `HEAD` ref is readable. Warn (not fail) when the project
 * isn't initialized OR no shadow repo exists yet — same posture as the
 * `config-yaml` check. Fail surfaces the typed errors
 * `MalformedGitPointerError` / `GitDirAccessError` thrown by `resolveShadowDir`.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { resolveShadowDir } from '@inkeep/open-knowledge-core/shadow-repo-layout';
import { GitDirAccessError, MalformedGitPointerError } from '@inkeep/open-knowledge-server';
import type { CheckContext, CheckDefinition, CheckResult } from './types.ts';

interface ShadowRepoCheckDeps {
  /** Replaceable so tests can simulate alternative shadow gitdir layouts. */
  resolve?: (projectRoot: string) => string;
}

export function makeShadowRepoCheck(deps: ShadowRepoCheckDeps = {}): CheckDefinition {
  const resolveDir = deps.resolve ?? resolveShadowDir;
  return {
    name: 'shadow-repo',
    run: async (ctx: CheckContext): Promise<CheckResult> => {
      const gitDir = resolve(ctx.cwd, '.git');
      if (!existsSync(gitDir)) {
        return {
          name: 'shadow-repo',
          status: 'warn',
          summary: 'no .git/ at project root (shadow repo not initialized)',
          remediation: 'Run `ok start` once to initialize the shadow repo.',
        };
      }
      let shadowDir: string;
      try {
        shadowDir = resolveDir(ctx.cwd);
      } catch (err) {
        if (err instanceof MalformedGitPointerError || err instanceof GitDirAccessError) {
          return {
            name: 'shadow-repo',
            status: 'fail',
            summary: `cannot resolve shadow gitdir: ${err.message}`,
          };
        }
        throw err;
      }
      if (!existsSync(shadowDir)) {
        return {
          name: 'shadow-repo',
          status: 'warn',
          summary: `shadow repo at ${shadowDir} not yet initialized`,
          remediation: 'Run `ok start` once to initialize the shadow repo.',
        };
      }
      const headPath = resolve(shadowDir, 'HEAD');
      if (!existsSync(headPath)) {
        return {
          name: 'shadow-repo',
          status: 'fail',
          summary: `shadow repo at ${shadowDir} is missing HEAD`,
        };
      }
      let head: string;
      try {
        head = readFileSync(headPath, 'utf-8').trim();
      } catch (err) {
        return {
          name: 'shadow-repo',
          status: 'fail',
          summary: `cannot read shadow HEAD: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
      return {
        name: 'shadow-repo',
        status: 'pass',
        summary: `${shadowDir} (HEAD: ${head})`,
      };
    },
  };
}

/**
 * Seed a freshly-created worktree's per-machine git auto-sync choice from the
 * root project's resolved setting, so opening a worktree doesn't re-ask the
 * onboarding prompt for every branch (a worktree inherits the root's
 * auto-sync on/off).
 *
 * Two settings back auto-sync (`packages/core/src/config/schema.ts`):
 *   - `autoSync.enabled` — per-machine, project-local (`.ok/local/config.yml`,
 *     gitignored). The user's actual on/off choice. A new worktree is a new
 *     project dir, so this starts unset → the onboarding modal would fire again.
 *   - `autoSync.default` — committed (`.ok/config.yml`, shared via git). A
 *     worktree already inherits this from its branch.
 *
 * We resolve the root's effective choice (per-machine `enabled`, else committed
 * `default`) and, when it's a definite on/off, write it into the new worktree's
 * project-local config. The onboarding gate then reads a non-null `enabled` and
 * suppresses the prompt. When the root itself is unanswered we write nothing —
 * the worktree prompts normally, exactly as the root would.
 *
 * `inheritedNoticePending` is a loose key (the schema's `autoSync` is a
 * `looseObject`, so it round-trips without a schema change): the worktree window
 * reads it to show a one-time "auto-sync is on/off, inherited from <project>"
 * notice, then clears it.
 */

import { existsSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { resolveConfigPath, writeConfigPatch } from '@inkeep/open-knowledge-core/server';
import { parse as parseYaml } from 'yaml';
import { getLogger } from './desktop-logger.ts';

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Read one config file's `autoSync.<key>` boolean leaf; null if absent/other. */
function readAutoSyncBool(path: string, key: 'enabled' | 'default'): boolean | null {
  if (!existsSync(path)) return null;
  let parsed: unknown;
  try {
    parsed = parseYaml(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
  if (!isObject(parsed)) return null;
  const autoSync = parsed.autoSync;
  if (!isObject(autoSync)) return null;
  const value = autoSync[key];
  return typeof value === 'boolean' ? value : null;
}

/**
 * The root project's resolved auto-sync choice: the per-machine
 * `autoSync.enabled` if set, else the committed `autoSync.default`. `null` when
 * neither is answered (→ the worktree should prompt normally).
 */
export function resolveRootAutoSync(mainRoot: string): boolean | null {
  const enabled = readAutoSyncBool(resolveConfigPath('project-local', mainRoot), 'enabled');
  if (enabled !== null) return enabled;
  return readAutoSyncBool(resolveConfigPath('project', mainRoot), 'default');
}

/**
 * Seed the new worktree's per-machine `autoSync.enabled` from the root's
 * resolved choice + arm the one-time inherited notice. No-op when the root is
 * unanswered. Best-effort: a write failure is logged, never thrown (the worktree
 * already exists — a missing seed just falls back to the normal prompt).
 */
export async function seedWorktreeAutoSync(worktreePath: string, mainRoot: string): Promise<void> {
  const inherited = resolveRootAutoSync(mainRoot);
  if (inherited === null) return;
  const result = await writeConfigPatch({
    cwd: worktreePath,
    scope: 'project-local',
    patch: {
      autoSync: {
        enabled: inherited,
        inheritedNoticePending: true,
        inheritedFrom: basename(mainRoot),
      },
    },
  });
  if (!result.ok) {
    getLogger('worktree-autosync').warn(
      { worktreePath, reason: result.error.code },
      'failed to seed inherited autoSync.enabled',
    );
  }
}

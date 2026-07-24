/**
 * Seed a freshly-created worktree's per-machine git sync mode from the root
 * project's resolved setting, so opening a worktree doesn't re-ask the
 * onboarding prompt for every branch (a worktree inherits the root's sync
 * choice).
 *
 * Two settings back sync (`packages/core/src/config/schema.ts`):
 *   - `autoSync.mode` — per-machine, project-local (`.ok/local/config.yml`,
 *     gitignored). This machine's actual off/pull/full choice (supersedes the
 *     legacy `autoSync.enabled` boolean). A new worktree is a new project dir,
 *     so this starts unset → the onboarding modal would fire again.
 *   - `autoSync.default` — committed (`.ok/config.yml`, shared via git). A
 *     worktree already inherits this from its branch.
 *
 * We resolve the root's effective mode (per-machine choice, else committed
 * default) and, when it's a definite off/pull/full, write it into the new
 * worktree's project-local config. The onboarding gate then reads a non-null
 * mode and suppresses the prompt. When the root itself is unanswered we write
 * nothing — the worktree prompts normally, exactly as the root would.
 *
 * `inheritedNoticePending` is a loose key (the schema's `autoSync` is a
 * `looseObject`, so it round-trips without a schema change): the worktree window
 * reads it to show a one-time "sync is on/off, inherited from <project>" notice,
 * then clears it.
 */

import { existsSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';
import {
  normalizeStoredMode,
  resolveEffectiveAutoSyncMode,
  type StoredSyncMode,
  type SyncMode,
  type SyncModeChangeSource,
} from '@inkeep/open-knowledge-core';
import { resolveConfigPath, writeConfigPatch } from '@inkeep/open-knowledge-core/server';
import { parse as parseYaml } from 'yaml';
import { getLogger } from './desktop-logger.ts';

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Read one config file's `autoSync` node; null if absent/unparseable/other. */
function readAutoSyncNode(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  let parsed: unknown;
  try {
    parsed = parseYaml(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
  if (!isObject(parsed)) return null;
  return isObject(parsed.autoSync) ? parsed.autoSync : null;
}

function asBool(v: unknown): boolean | null {
  return typeof v === 'boolean' ? v : null;
}
function asModeOrBool(v: unknown): StoredSyncMode | boolean | null {
  // normalizeStoredMode accepts the legacy 'pull' alias for 'follow'; a boolean
  // stays a boolean (the even-older enabled-style seed).
  const mode = normalizeStoredMode(v);
  if (mode !== null) return mode;
  return typeof v === 'boolean' ? v : null;
}

/**
 * The root project's resolved sync mode: the per-machine `autoSync.mode` (or the
 * legacy `enabled` boolean) if set, else the committed `autoSync.default`. `null`
 * when neither is answered (→ the worktree should prompt normally).
 */
export function resolveRootAutoSyncMode(mainRoot: string): SyncMode | null {
  const local = readAutoSyncNode(resolveConfigPath('project-local', mainRoot));
  const committed = readAutoSyncNode(resolveConfigPath('project', mainRoot));
  return resolveEffectiveAutoSyncMode({
    local: { mode: normalizeStoredMode(local?.mode), enabled: asBool(local?.enabled) },
    committedDefault: asModeOrBool(committed?.default),
  });
}

/**
 * Seed the new worktree's per-machine `autoSync.mode` from the root's resolved
 * choice + arm the one-time inherited notice. No-op when the root is unanswered.
 * Best-effort: a write failure is logged, never thrown (the worktree already
 * exists — a missing seed just falls back to the normal prompt).
 */
export async function seedWorktreeAutoSync(worktreePath: string, mainRoot: string): Promise<void> {
  const inherited = resolveRootAutoSyncMode(mainRoot);
  if (inherited === null) return;
  const result = await writeConfigPatch({
    cwd: worktreePath,
    scope: 'project-local',
    patch: {
      autoSync: {
        mode: inherited,
        inheritedNoticePending: true,
        inheritedFrom: basename(mainRoot),
      },
    },
  });
  if (!result.ok) {
    getLogger('worktree-autosync').warn(
      { worktreePath, reason: result.error.code },
      'failed to seed inherited autoSync.mode',
    );
    return;
  }
  // Attribute the activation here: once seeded, the mode is an ordinary
  // per-machine `autoSync.mode`, so the booting server can't tell it apart from
  // a user's own choice (it collapses to the `config` source). The seed site is
  // the only place that knows the origin is worktree inheritance. Bounded fields
  // only — the parent project name and worktree path are unbounded, so they stay
  // out of the telemetry payload.
  const source: SyncModeChangeSource = 'worktree-inherit';
  getLogger('worktree-autosync').info({ to: inherited, source }, 'seeded inherited autoSync mode');
}

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
  const mode = normalizeStoredMode(v);
  if (mode !== null) return mode;
  return typeof v === 'boolean' ? v : null;
}

export function resolveRootAutoSyncMode(mainRoot: string): SyncMode | null {
  const local = readAutoSyncNode(resolveConfigPath('project-local', mainRoot));
  const committed = readAutoSyncNode(resolveConfigPath('project', mainRoot));
  return resolveEffectiveAutoSyncMode({
    local: { mode: normalizeStoredMode(local?.mode), enabled: asBool(local?.enabled) },
    committedDefault: asModeOrBool(committed?.default),
  });
}

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
  const source: SyncModeChangeSource = 'worktree-inherit';
  getLogger('worktree-autosync').info({ to: inherited, source }, 'seeded inherited autoSync mode');
}

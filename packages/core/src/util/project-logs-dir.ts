import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SPAWN_ERROR_LOG } from '../constants/lifecycle.ts';
import { okUserHomeDir } from '../constants/ok-user-home.ts';

export function projectLogsKeyForCanonicalPath(projectPath: string): string {
  return createHash('sha256').update(projectPath).digest('hex');
}

export function isProjectLogsKey(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value);
}

export function projectSpawnErrorLogPath(projectDir: string, home?: string): string {
  return join(okProjectLogsDir(projectDir, home), SPAWN_ERROR_LOG);
}

export function okProjectLogsDir(projectDir: string, home?: string): string {
  let projectPath = resolve(projectDir);
  try {
    projectPath = realpathSync.native(projectPath);
  } catch {}
  const key = projectLogsKeyForCanonicalPath(projectPath);
  return join(okUserHomeDir(home), 'logs', 'projects', key);
}

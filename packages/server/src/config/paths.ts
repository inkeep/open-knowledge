
import { resolve } from 'node:path';
import { LOCAL_DIR, OK_DIR } from '@inkeep/open-knowledge-core';
import type { Config } from './schema.ts';

export function resolveContentDir(config: Config, cwd: string): string {
  return resolve(cwd, config.content.dir);
}

export function getLocalDir(projectDir: string): string {
  return resolve(projectDir, OK_DIR, LOCAL_DIR);
}

export function resolveLockDir(projectDir: string): string {
  return getLocalDir(projectDir);
}

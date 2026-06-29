
import { resolve } from 'node:path';
import { getLocalDir } from '@inkeep/open-knowledge-server';
import type { Config } from './schema.ts';

export function resolveContentDir(config: Config, cwd: string): string {
  return resolve(cwd, config.content.dir);
}

export function resolveLockDir(projectDir: string): string {
  return getLocalDir(projectDir);
}

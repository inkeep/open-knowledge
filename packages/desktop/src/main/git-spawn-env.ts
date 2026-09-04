import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter } from 'node:path';
import { augmentGitSpawnPath } from '@inkeep/open-knowledge-core';

let cachedPath: string | null = null;

function isDir(dir: string): boolean {
  try {
    return existsSync(dir) && statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

export function gitSpawnEnv(): Record<string, string | undefined> {
  if (cachedPath === null) {
    cachedPath = augmentGitSpawnPath(process.env.PATH, {
      platform: process.platform,
      homeDir: homedir(),
      isDir,
      delimiter,
    });
  }
  return {
    ...process.env,
    LANG: 'C',
    LC_ALL: 'C',
    PATH: cachedPath,
  };
}

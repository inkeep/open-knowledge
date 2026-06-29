import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

export interface GhDetectResult {
  available: boolean;
  token?: string;
}

export type ExecFileSyncFn = typeof execFileSync;
type FileExistsFn = (path: string) => boolean;

const KNOWN_GH_PATHS: readonly string[] = [
  '/opt/homebrew/bin/gh', // macOS Apple Silicon Homebrew
  '/usr/local/bin/gh', // macOS Intel Homebrew / manual install
  '/opt/local/bin/gh', // macOS MacPorts
  '/snap/bin/gh', // Linux snap
  '/usr/bin/gh', // Linux distro packages
];

interface DetectGhOptions {
  _exec?: ExecFileSyncFn;
  _fileExists?: FileExistsFn;
}

export function detectGh(host?: string, options: DetectGhOptions = {}): GhDetectResult {
  const exec = options._exec ?? execFileSync;
  const fileExists = options._fileExists ?? existsSync;
  const args = ['auth', 'token', ...(host ? ['--hostname', host] : [])];
  const candidates: string[] = ['gh', ...KNOWN_GH_PATHS.filter(fileExists)];

  for (const cmd of candidates) {
    try {
      const token = exec(cmd, args, {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 5000,
      })
        .toString()
        .trim();
      if (token.length > 0) return { available: true, token };
    } catch {
    }
  }
  return { available: false };
}

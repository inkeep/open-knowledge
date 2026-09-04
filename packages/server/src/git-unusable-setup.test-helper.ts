import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BROKEN_GIT_STDERR =
  "xcrun: error: unable to load libxcrun (dlopen(/Applications/Xcode.app/Contents/Developer/usr/lib/libxcrun.dylib, 0x0005): tried: '/Applications/Xcode.app/Contents/Developer/usr/lib/libxcrun.dylib' (mach-o file, but is an incompatible architecture (have 'arm64', need 'arm64e')), '/System/Volumes/Preboot/Cryptexes/OS/Applications/Xcode.app/Contents/Developer/usr/lib/libxcrun.dylib' (no such file)).";

function makeBrokenGitDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ok356-brokengit-'));
  const gitPath = join(dir, 'git');
  writeFileSync(
    gitPath,
    `#!/bin/sh\n# Present-but-broken git stub — catch-all: every subcommand fails identically.\necho ${JSON.stringify(BROKEN_GIT_STDERR)} >&2\nexit 1\n`,
    'utf-8',
  );
  chmodSync(gitPath, 0o755);
  return dir;
}

async function withBrokenGitDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = makeBrokenGitDir();
  try {
    await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value, configurable: true });
}

export async function withBrokenBareGitOnly(fn: () => Promise<void>): Promise<void> {
  await withBrokenGitDir(async (dir) => {
    const origPath = process.env.PATH;
    process.env.PATH = dir;
    try {
      await fn();
    } finally {
      if (origPath === undefined) delete process.env.PATH;
      else process.env.PATH = origPath;
    }
  });
}

export async function withUnusableGitEverywhere(fn: () => Promise<void>): Promise<void> {
  await withBrokenGitDir(async (dir) => {
    const origPath = process.env.PATH;
    const origPlatform = process.platform;
    process.env.PATH = dir;
    setPlatform(origPlatform === 'win32' ? 'linux' : 'win32');
    try {
      await fn();
    } finally {
      setPlatform(origPlatform);
      if (origPath === undefined) delete process.env.PATH;
      else process.env.PATH = origPath;
    }
  });
}

export function isRecoverableGitSignal(value: unknown): boolean {
  if (value == null) return false;
  const code = (value as { code?: unknown }).code;
  if (code === 'GIT_NOT_AVAILABLE' || code === 'GIT_TOO_OLD') return true;
  const name = (value as { name?: unknown }).name;
  if (name === 'GitNotAvailableError' || name === 'GitTooOldError') return true;
  const msg = value instanceof Error ? value.message : typeof value === 'string' ? value : '';
  return (
    msg.includes('GIT_NOT_AVAILABLE') ||
    msg.includes('GIT_TOO_OLD') ||
    msg.includes('OpenKnowledge needs Git') ||
    msg.includes('OpenKnowledge requires Git') ||
    msg.includes('ok diagnose health')
  );
}

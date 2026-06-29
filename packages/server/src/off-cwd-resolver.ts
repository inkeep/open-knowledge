import { realpath as fsRealpath } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { readConfigSafely, resolveConfigPath } from '@inkeep/open-knowledge-core/server';
import { isProcessAlive } from './process-alive.ts';
import { discoverLockDirs } from './process-scan.ts';
import { readUiLock } from './ui-lock.ts';

export interface OffCwdCandidate {
  readonly lockDir: string;
  readonly contentDir: string;
  readonly baseUrl: string;
  readonly alive: boolean;
}

export interface OffCwdResolverDeps {
  readonly discover: () => Promise<readonly string[]>;
  readonly inspect: (lockDir: string) => Promise<OffCwdCandidate | null>;
  readonly realpath: (p: string) => Promise<string>;
}

export interface OffCwdResolution {
  readonly baseUrl: string;
  readonly docName: string;
}

function isPathInside(target: string, dir: string): boolean {
  if (target === dir) return true;
  const prefix = dir.endsWith(sep) ? dir : dir + sep;
  return target.startsWith(prefix);
}

function toDocName(contentDir: string, target: string): string {
  const rel = relative(contentDir, target).split(sep).join('/');
  return rel.replace(/\.(md|mdx)$/i, '');
}

export async function resolveOffCwdTarget(
  absTarget: string,
  deps: OffCwdResolverDeps,
): Promise<OffCwdResolution | null> {
  const target = await deps.realpath(resolve(absTarget)).catch(() => resolve(absTarget));
  const lockDirs = await deps.discover();
  const candidates = await Promise.all(lockDirs.map((d) => deps.inspect(d).catch(() => null)));

  let best: OffCwdCandidate | null = null;
  for (const c of candidates) {
    if (c === null || !c.alive) continue;
    if (!isPathInside(target, c.contentDir)) continue;
    if (best === null || c.contentDir.length > best.contentDir.length) best = c;
  }
  if (best === null) return null;
  return { baseUrl: best.baseUrl, docName: toDocName(best.contentDir, target) };
}

export function projectDirOfLockDir(lockDir: string): string {
  return dirname(dirname(lockDir));
}

export function createOffCwdResolverDeps(): OffCwdResolverDeps {
  return {
    discover: () => discoverLockDirs(),
    realpath: (p) => fsRealpath(p).catch(() => p),
    inspect: async (lockDir) => {
      const projectDir = projectDirOfLockDir(lockDir);
      let contentDir: string;
      try {
        const config = readConfigSafely({
          absPath: resolveConfigPath('project', projectDir),
          sideline: false,
          warn: () => {},
        });
        const contentRel = config.value.content?.dir ?? '.';
        const abs = resolve(projectDir, contentRel);
        contentDir = await fsRealpath(abs).catch(() => abs);
      } catch (err) {
        process.stderr.write(
          `[off-cwd-resolver] skipping ${lockDir} (config unreadable): ${err instanceof Error ? err.message : String(err)}\n`,
        );
        return null;
      }
      const lock = readUiLock(lockDir);
      const port = lock?.port ?? 0;
      const alive = lock != null && port > 0 && isProcessAlive(lock.pid);
      return { lockDir, contentDir, baseUrl: `http://localhost:${port}`, alive };
    },
  };
}

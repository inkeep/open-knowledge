
import { existsSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, resolve, sep } from 'node:path';
import { SeedRootDirError } from './types.ts';

export function assertEntryPathInProject(projectDir: string, relPath: unknown): string {
  if (typeof relPath !== 'string' || relPath === '') {
    throw new SeedRootDirError(`entry path must be a non-empty string, got: ${typeof relPath}`);
  }
  if (relPath.includes('\0')) {
    throw new SeedRootDirError('entry path must not contain null bytes');
  }
  if (isAbsolute(relPath)) {
    throw new SeedRootDirError(`entry path must be relative, got: ${relPath}`);
  }
  if (relPath.split(/[/\\]/).some((seg) => seg === '..')) {
    throw new SeedRootDirError(`entry path must not contain '..' segments, got: ${relPath}`);
  }

  const projectAbs = resolve(projectDir);
  const candidateAbs = resolve(projectAbs, relPath);
  if (candidateAbs !== projectAbs && !candidateAbs.startsWith(projectAbs + sep)) {
    throw new SeedRootDirError(
      `entry path must resolve inside the project directory, got: ${relPath}`,
    );
  }

  assertNoSymlinkEscape(candidateAbs, projectAbs);
  return candidateAbs;
}

function assertNoSymlinkEscape(target: string, projectAbs: string): void {
  let projectRoot: string;
  try {
    projectRoot = realpathSync(projectAbs);
  } catch {
    return;
  }

  let cur = target;
  for (;;) {
    if (existsSync(cur)) {
      let canonical: string;
      try {
        canonical = realpathSync(cur);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ELOOP') {
          throw new SeedRootDirError(`entry path traverses a symlink cycle: ${target}`);
        }
        throw err;
      }
      if (canonical !== projectRoot && !canonical.startsWith(projectRoot + sep)) {
        throw new SeedRootDirError(
          `entry path resolves outside the project directory via symlink: ${target}`,
        );
      }
      return;
    }
    const parent = dirname(cur);
    if (parent === cur) {
      throw new SeedRootDirError(
        `entry path has no existing ancestor inside the project directory: ${target}`,
      );
    }
    cur = parent;
  }
}

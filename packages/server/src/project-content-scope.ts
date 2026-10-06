import { readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { resolveExistingNativeAncestor } from './directory-root.ts';
import { isProjectRoot } from './fs/find-project-root.ts';
import { isWithinDir } from './path-utils.ts';

export class NestedProjectScopeError extends Error {
  constructor(projectRoot: string) {
    super(`This path belongs to the nested project at ${projectRoot}. Open that project instead.`);
    this.name = 'NestedProjectScopeError';
  }
}

function assertNoProjectBetween(path: string, root: string, canonicalRoot: string | null): void {
  let cursor = path;
  while (cursor !== root && isWithinDir(cursor, root)) {
    try {
      if (isProjectRoot(cursor) && existingRealPath(cursor) !== canonicalRoot) {
        throw new NestedProjectScopeError(cursor);
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ELOOP' && code !== 'EACCES' && code !== 'EPERM') throw error;
    }
    cursor = dirname(cursor);
  }
}

function existingRealPath(path: string): string | null {
  try {
    return resolveExistingNativeAncestor(path).ancestor;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') return null;
    throw error;
  }
}

export function assertProjectContentScope(fullPath: string, contentDir: string): void {
  const path = resolve(fullPath);
  const root = resolve(contentDir);
  const canonicalRoot = existingRealPath(root);
  assertNoProjectBetween(path, root, canonicalRoot);
  const canonicalPath = existingRealPath(path);
  if (canonicalPath !== null && canonicalRoot !== null) {
    assertNoProjectBetween(canonicalPath, canonicalRoot, canonicalRoot);
  }
}

export function assertProjectContentSubtree(folderPath: string, contentDir: string): void {
  assertProjectContentScope(folderPath, contentDir);
  const pending = [folderPath];
  while (pending.length > 0) {
    const directory = pending.pop();
    if (directory === undefined) break;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const child = join(directory, entry.name);
      if (isProjectRoot(child)) throw new NestedProjectScopeError(child);
      pending.push(child);
    }
  }
}

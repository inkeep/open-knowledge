import { readdirSync, statSync } from 'node:fs';
import { extname, relative, resolve, sep } from 'node:path';
import { OK_DIR } from '@inkeep/open-knowledge-core';
import { isSupportedDocFile, registerDocExtension, stripDocExtension } from '../doc-extensions.ts';
import { errnoCode } from '../http/handler-utils.ts';

export function isReservedProjectStatePath(path: string): boolean {
  return path.split('/').some((segment) => {
    const normalized = segment.toLowerCase();
    return normalized === OK_DIR || normalized === '.git';
  });
}

export interface ManagedDocEnumDeps {
  contentDir: string;
  contentFilter?:
    | { isDirExcluded(relPath: string): boolean; isExcluded(relPath: string): boolean }
    | undefined;
  docNameForPath: (relPath: string) => string;
}

export function listManagedDocNamesUnderFolder(
  sourcePathRoot: string,
  deps: ManagedDocEnumDeps,
): string[] {
  const { contentDir, contentFilter, docNameForPath } = deps;
  const docNames: string[] = [];
  try {
    if (!statSync(sourcePathRoot).isDirectory()) return docNames;
  } catch (err) {
    const code = errnoCode(err);
    if (code === 'ENOENT' || code === 'ENOTDIR') return docNames;
    throw err;
  }

  function walk(dir: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = resolve(dir, entry.name);
      const relPath = relative(contentDir, fullPath).split(sep).join('/');
      if (isReservedProjectStatePath(relPath)) continue;
      if (entry.isDirectory()) {
        if (contentFilter?.isDirExcluded(relPath)) continue;
        walk(fullPath);
        continue;
      }
      if (!entry.isFile() || !isSupportedDocFile(relPath) || contentFilter?.isExcluded(relPath)) {
        continue;
      }
      const docName = docNameForPath(relPath);
      registerDocExtension(stripDocExtension(relPath), extname(relPath));
      docNames.push(docName);
    }
  }

  walk(sourcePathRoot);
  docNames.sort((a, b) => a.localeCompare(b));
  return docNames;
}

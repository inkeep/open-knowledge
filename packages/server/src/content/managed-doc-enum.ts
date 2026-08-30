import { readdirSync, statSync } from 'node:fs';
import { extname, relative, resolve, sep } from 'node:path';
import { OK_DIR } from '@inkeep/open-knowledge-core';
import { isSupportedDocFile, registerDocExtension, stripDocExtension } from '../doc-extensions.ts';
import { errnoCode } from '../http/handler-utils.ts';

/**
 * Disk-truth enumeration of managed documents under a folder. Every
 * destructive or copying file operation (delete, duplicate, rename)
 * enumerates descendants from DISK, deliberately not from the lagging file
 * index — the disk-enum regression tests guard exactly that property. Shared
 * by the FileOps service and the managed-rename spine; do not fork it.
 */

/**
 * True when any `/`-separated segment of `path` is `.ok` or `.git`, at any
 * depth — nested `<folder>/.ok/` is a first-class OK shape (folder metadata +
 * templates), so a top-level-only check is not a boundary. Segments compare
 * case-insensitively: on the default case-insensitive macOS filesystem an
 * externally-addressed `.OK/x` IS `.ok/x`. Same segment walk as
 * `pathHasAlwaysSkipSegment` in content-filter.ts.
 */
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
  /** Maps a doc file's contentDir-relative path to its docName (extension policy lives with the caller). */
  docNameForPath: (relPath: string) => string;
}

export function listManagedDocNamesUnderFolder(
  sourcePathRoot: string,
  deps: ManagedDocEnumDeps,
): string[] {
  const { contentDir, contentFilter, docNameForPath } = deps;
  const docNames: string[] = [];
  // A file at the folder path (e.g. `kind: 'folder'` on a doc) must NOT reach
  // `readdirSync` — that throws ENOTDIR and 500s. Return empty for that and a
  // TOCTOU vanish (ENOENT) so the caller's type-mismatch / not-found check
  // emits the correct 4xx. Any other stat error (EACCES, EIO, ELOOP) means
  // the folder exists but is unreadable: returning empty there would move the
  // directory and skip link rewriting — the exact bug this fix addresses — so
  // rethrow and let it surface as a 500.
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

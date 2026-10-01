import { lstatSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { SUPPORTED_DOC_EXTENSIONS } from '@inkeep/open-knowledge-core';
import { isWithinContentDir } from '../content-path.ts';

export interface AuditScope {
  kind: 'dir' | 'file';
  path: string;
}

export function auditScopeNotFoundTitle(path: string): string {
  return `Scope ${JSON.stringify(path)} was not found. Use an existing file or directory; a document stem without .md or .mdx resolves .mdx before .md. Explicit document extensions must exist as written.`;
}

export { AUDIT_EMPTY_SCOPE_WARNING } from '@inkeep/open-knowledge-core';

export type AuditScopeResolution =
  | { ok: true; scope: AuditScope }
  | { ok: false; path: string; title: string };

export function resolveAuditScope(
  targetPath: string | undefined,
  contentDir: string,
): AuditScopeResolution {
  const root = resolve(contentDir);
  const path = resolve(root, targetPath ?? '');
  if (!readScopeEntry(root, true)?.isDirectory()) {
    return {
      ok: false,
      path: root,
      title: `Content directory ${JSON.stringify(root)} was not found. Set content.dir to an existing directory.`,
    };
  }
  const entry = readScopeEntry(path);
  if (entry !== undefined) {
    const stat = entry.isSymbolicLink() ? readScopeEntry(path, true) : entry;
    if (stat?.isFile()) return { ok: true, scope: { kind: 'file', path } };
    if (stat?.isDirectory()) return { ok: true, scope: { kind: 'dir', path } };
  } else if (
    path !== root &&
    isWithinContentDir(path, root) &&
    !SUPPORTED_DOC_EXTENSIONS.some((extension) => path.toLowerCase().endsWith(extension))
  ) {
    for (const extension of SUPPORTED_DOC_EXTENSIONS) {
      const candidate = `${path}${extension}`;
      if (readScopeEntry(candidate, true)?.isFile()) {
        return { ok: true, scope: { kind: 'file', path: candidate } };
      }
    }
  }
  return { ok: false, path, title: auditScopeNotFoundTitle(targetPath ?? '.') };
}

export function isAbsentPathError(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error.code === 'ENOENT' ||
      error.code === 'ENOTDIR' ||
      error.code === 'ENAMETOOLONG' ||
      error.code === 'ELOOP' ||
      error.code === 'ERR_INVALID_ARG_VALUE')
  );
}

export function readScopeEntry(path: string, followSymlinks = false) {
  try {
    return followSymlinks ? statSync(path) : lstatSync(path);
  } catch (error) {
    if (isAbsentPathError(error)) return undefined;
    throw error;
  }
}

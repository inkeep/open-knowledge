import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { resolveExistingNativeAncestor } from './directory-root.ts';
import { isProjectRoot } from './fs/find-project-root.ts';
import { SymlinkEscapeError } from './fs-safety.ts';
import { normalizeFsPath, tracedAtomicFs, tracedRenameSync } from './fs-traced.ts';
import { errnoCode } from './http/handler-utils.ts';
import { getLogger } from './logger.ts';
import { assertProjectContentScope, NestedProjectScopeError } from './project-content-scope.ts';
import { type ContentScope, contentScopeContainsPath } from './server-authority.ts';
import { withSpanSync } from './telemetry.ts';

export class ContentScopeAdmissionError extends Error {
  constructor() {
    super('This server does not own this content path. Open the project or file that owns it.');
    this.name = 'ContentScopeAdmissionError';
  }
}

export class ServerMutationShuttingDownError extends Error {
  readonly problemType: 'urn:ok:error:auth-failed' | 'urn:ok:error:concurrent-operation';

  constructor(authOperation: boolean) {
    super('The server is shutting down.');
    this.name = 'ServerMutationShuttingDownError';
    this.problemType = authOperation
      ? 'urn:ok:error:auth-failed'
      : 'urn:ok:error:concurrent-operation';
  }
}

export function contentScopedAtomicFs(assertPath: (path: string) => void): typeof tracedAtomicFs {
  return {
    writeFile: tracedAtomicFs.writeFile,
    rename: async (from, to) => {
      assertPath(to);
      tracedRenameSync(from, to);
    },
  };
}

export function canonicalContentPath(path: string): string {
  try {
    const { ancestor, missingSegments } = resolveExistingNativeAncestor(path);
    return resolve(ancestor, ...missingSegments);
  } catch (error) {
    if (errnoCode(error) === 'ELOOP') throw new SymlinkEscapeError('symlink cycle in path');
    throw error;
  }
}

export function snapshotServerContentScope(
  contentDir: string,
  singleDocRelPath?: string,
): ContentScope {
  return withSpanSync(
    'ok.boot.content-scope',
    { attributes: { 'content.scope.kind': singleDocRelPath === undefined ? 'tree' : 'file' } },
    (span) => {
      const scope = scanServerContentScope(contentDir, singleDocRelPath);
      span.setAttribute(
        'content.scope.exclusions',
        scope.kind === 'tree' ? scope.excluded.length : 0,
      );
      return scope;
    },
  );
}

function scanServerContentScope(contentDir: string, singleDocRelPath?: string): ContentScope {
  const root = canonicalContentPath(contentDir);
  if (singleDocRelPath !== undefined) {
    return { kind: 'file', path: canonicalContentPath(resolve(contentDir, singleDocRelPath)) };
  }
  const excluded: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    if (directory === undefined) break;
    try {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const child = join(directory, entry.name);
        try {
          if (isProjectRoot(child)) {
            excluded.push(canonicalContentPath(child));
          } else {
            pending.push(child);
          }
        } catch (error) {
          const code = errnoCode(error);
          if (code !== 'ENOENT' && code !== 'ENOTDIR' && code !== 'EACCES' && code !== 'EPERM')
            throw error;
          getLogger('server-content-policy').warn(
            { path: normalizeFsPath(child), code },
            'Unreadable nested-project marker remains in the parent authority scope',
          );
        }
      }
    } catch (error) {
      const code = errnoCode(error);
      if (code !== 'ENOENT' && code !== 'ENOTDIR' && code !== 'EACCES' && code !== 'EPERM') {
        throw error;
      }
      if (code === 'EACCES' || code === 'EPERM')
        getLogger('server-content-policy').warn(
          { path: normalizeFsPath(directory), code },
          'Unreadable directory remains in the parent authority scope',
        );
    }
  }
  return { kind: 'tree', path: root, excluded };
}

export function assertCapturedServerContentPath(scope: ContentScope, path: string): string {
  const canonical = canonicalContentPath(path);
  if (scope.kind === 'file') {
    if (!contentScopeContainsPath(scope, canonical)) throw new ContentScopeAdmissionError();
    return canonical;
  }
  const excluded = scope.excluded.find((root) =>
    contentScopeContainsPath({ kind: 'tree', path: root, excluded: [] }, canonical),
  );
  if (excluded !== undefined) throw new NestedProjectScopeError(excluded);
  if (!contentScopeContainsPath(scope, canonical)) throw new ContentScopeAdmissionError();
  return canonical;
}

export function assertServerContentPath(scope: ContentScope, path: string): void {
  const canonical = assertCapturedServerContentPath(scope, path);
  if (scope.kind === 'tree') assertProjectContentScope(canonical, scope.path);
}

export function assertServerContentSubtree(scope: ContentScope, path: string): void {
  assertServerContentPath(scope, path);
  if (scope.kind === 'file') throw new ContentScopeAdmissionError();
  const canonical = canonicalContentPath(path);
  const excluded = scope.excluded.find((root) =>
    contentScopeContainsPath({ kind: 'tree', path: canonical, excluded: [] }, root),
  );
  if (excluded !== undefined) throw new NestedProjectScopeError(excluded);
}

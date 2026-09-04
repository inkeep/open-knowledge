import { realpathSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { isWithinContentDir } from './content-path.ts';
import { normalizeFsPath } from './fs-traced.ts';
import { errnoCode } from './http/handler-utils.ts';
import type { PinoLogger } from './logger.ts';

export class SymlinkEscapeError extends Error {
  constructor(message: string) {
    super(`symlink-escape: ${message}`);
    this.name = 'SymlinkEscapeError';
  }
}

export class ContentRootUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContentRootUnavailableError';
  }
}

export function assertNoSymlinkEscape(fullPath: string, resolvedContentDir: string): void {
  let contentRoot: string;
  try {
    contentRoot = realpathSync(resolvedContentDir);
  } catch (err) {
    const code = errnoCode(err);
    if (code === 'ENOENT') {
      throw new ContentRootUnavailableError('content directory does not exist');
    }
    throw err;
  }

  let cur = fullPath;
  for (;;) {
    try {
      const canonical = realpathSync(cur);
      if (!isWithinContentDir(canonical, contentRoot)) {
        throw new SymlinkEscapeError('path resolves outside content directory');
      }
      return;
    } catch (err) {
      const code = errnoCode(err);
      if (code === 'ELOOP') {
        throw new SymlinkEscapeError('symlink cycle in path');
      }
      if (code !== 'ENOENT') throw err;
      const parent = dirname(cur);
      if (parent === cur) throw err;
      const withinRaw =
        parent === resolvedContentDir || parent.startsWith(`${resolvedContentDir}${sep}`);
      const withinCanonical = parent === contentRoot || parent.startsWith(`${contentRoot}${sep}`);
      if (!withinRaw && !withinCanonical) {
        throw err;
      }
      cur = parent;
    }
  }
}

export class PathContainmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PathContainmentError';
  }
}

export function isContainmentRejection(err: unknown): boolean {
  return err instanceof PathContainmentError || err instanceof SymlinkEscapeError;
}

function logCanonicalizationFault(log: PinoLogger, path: string, err: unknown): void {
  log.warn(
    { path: normalizeFsPath(path), code: errnoCode(err), err },
    '[fs-safety] reserved-path canonicalization fell back to the lexical path; a symlink-based reserved-subtree check may be stale for this request',
  );
}

export function canonicalRelPathForNewTarget(
  fullPath: string,
  resolvedContentDir: string,
  log: PinoLogger,
  realpath: typeof realpathSync = realpathSync,
  p: Pick<typeof import('node:path').posix, 'join' | 'relative' | 'dirname' | 'sep'> = {
    join,
    relative,
    dirname,
    sep,
  },
): string {
  const toPosix = (s: string): string => s.split(p.sep).join('/');
  let contentRoot: string;
  try {
    contentRoot = realpath(resolvedContentDir);
  } catch (err) {
    if (errnoCode(err) !== 'ENOENT') logCanonicalizationFault(log, resolvedContentDir, err);
    contentRoot = resolvedContentDir;
  }
  let cur = fullPath;
  for (;;) {
    try {
      const canonicalAncestor = realpath(cur);
      const canonicalFull = p.join(canonicalAncestor, p.relative(cur, fullPath));
      return toPosix(p.relative(contentRoot, canonicalFull));
    } catch (err) {
      if (errnoCode(err) !== 'ENOENT') {
        logCanonicalizationFault(log, cur, err);
        return toPosix(p.relative(contentRoot, fullPath));
      }
      const parent = p.dirname(cur);
      if (parent === cur) return toPosix(p.relative(contentRoot, fullPath));
      cur = parent;
    }
  }
}

export function isAlreadyExistsError(err: unknown): boolean {
  const code = errnoCode(err);
  return (
    code === 'EEXIST' ||
    code === 'ERR_FS_CP_EEXIST' ||
    code === 'ERR_FS_CP_DIR_TO_NON_DIR' ||
    code === 'ERR_FS_CP_NON_DIR_TO_DIR'
  );
}

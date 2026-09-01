import { lstatSync, readlinkSync, realpathSync } from 'node:fs';
import { basename, dirname, relative, resolve } from 'node:path';
import { SymlinkEscapeError } from './apply-managed-rename.ts';
import { isWithinDir, toPosix } from './path-utils.ts';

export interface RealpathGuardOptions {
  allowShareableOkArtifact?: (projectRelPosixPath: string) => boolean;
}

export function assertRealpathWithinDir(
  targetAbsPath: string,
  rootDir: string,
  opts: RealpathGuardOptions = {},
): void {
  const resolvedRoot = resolve(rootDir);
  let canonicalRoot: string;
  try {
    canonicalRoot = realpathSync(resolvedRoot);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw new SymlinkEscapeError('root directory does not exist');
    throw err;
  }

  let cur = resolve(targetAbsPath);
  const pendingSuffix: string[] = [];
  for (let steps = 0; ; steps++) {
    if (steps > 256) throw new SymlinkEscapeError('too many symlink resolutions in path');
    try {
      const canonical = realpathSync(cur);
      if (!isWithinDir(canonical, canonicalRoot)) {
        throw new SymlinkEscapeError(`path resolves outside ${rootDir}`);
      }
      const canonicalRel = toPosix(relative(canonicalRoot, canonical));
      const effectiveRel =
        pendingSuffix.length === 0
          ? canonicalRel
          : [canonicalRel, ...pendingSuffix].filter((seg) => seg !== '').join('/');
      if (resolvesIntoInternalStateDir(effectiveRel)) {
        const exemptable =
          effectiveRel.split('/')[0] === '.ok' &&
          opts.allowShareableOkArtifact !== undefined &&
          opts.allowShareableOkArtifact(effectiveRel);
        if (!exemptable) {
          throw new SymlinkEscapeError('path resolves into the .git/.ok state tree');
        }
      }
      return;
    } catch (err) {
      if (err instanceof SymlinkEscapeError) throw err;
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ELOOP') throw new SymlinkEscapeError('symlink cycle in path');
      if (code !== 'ENOENT') throw err;
      let linkTarget: string | null = null;
      try {
        if (lstatSync(cur).isSymbolicLink()) linkTarget = readlinkSync(cur);
      } catch {}
      if (linkTarget !== null) {
        cur = resolve(dirname(cur), linkTarget);
        continue;
      }
      const parent = dirname(cur);
      if (parent === cur) throw err;
      pendingSuffix.unshift(basename(cur));
      if (parent !== resolvedRoot && !isWithinDir(parent, resolvedRoot)) {
        throw new SymlinkEscapeError(`path resolves outside ${rootDir}`);
      }
      cur = parent;
    }
  }
}

function resolvesIntoInternalStateDir(effectiveRel: string): boolean {
  if (effectiveRel === '' || effectiveRel.startsWith('..')) return false;
  const first = (effectiveRel.split('/')[0] ?? '').toLowerCase();
  return first === '.git' || first === '.ok';
}

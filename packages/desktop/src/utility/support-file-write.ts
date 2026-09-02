import {
  closeSync,
  constants,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { TerminalLaunchCommand } from '@inkeep/open-knowledge-core';
import { isPathWithinProject } from '../shared/path-containment.ts';

export const TERMINAL_SUPPORT_FILE_ESCAPE_CODE = 'ERR_TERMINAL_SUPPORT_FILE_ESCAPE';

function refuseEscape(detail: string, cause?: unknown): NodeJS.ErrnoException {
  return Object.assign(
    new Error(`support file would escape the project root: ${detail}`, { cause }),
    { code: TERMINAL_SUPPORT_FILE_ESCAPE_CODE },
  );
}

function splitRelativePath(relativePath: string): { segments: string[]; leaf: string } {
  if (relativePath.length === 0 || relativePath.includes('\0') || relativePath.includes('\\')) {
    throw refuseEscape('malformed relative path');
  }
  const parts = relativePath.split('/');
  if (parts.some((part) => part.length === 0 || part === '.' || part === '..')) {
    throw refuseEscape('malformed relative path');
  }
  const leaf = parts.pop();
  if (leaf === undefined || parts.length === 0) throw refuseEscape('malformed relative path');
  return { segments: parts, leaf };
}

export function materializeSupportFileSync(
  cwd: string,
  file: NonNullable<TerminalLaunchCommand['supportFile']>,
): void {
  const platform = process.platform;
  const { segments, leaf } = splitRelativePath(file.relativePath);

  const root = realpathSync(cwd);

  let dir = root;
  for (const segment of segments) {
    const next = join(dir, segment);
    try {
      mkdirSync(next);
    } catch (err) {
      if ((err as NodeJS.ErrnoException | null)?.code !== 'EEXIST') throw err;
    }
    try {
      dir = realpathSync(next);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | null)?.code;
      if (code !== 'ENOENT' && code !== 'ELOOP') throw error;
      throw refuseEscape(`directory segment ${segment} cannot be resolved`, error);
    }
    if (!isPathWithinProject(dir, root, platform)) {
      throw refuseEscape(`directory segment ${segment} resolves outside the project`);
    }
  }

  const target = join(dir, leaf);
  if (lstatSync(target, { throwIfNoEntry: false })?.isSymbolicLink() === true) {
    throw refuseEscape('settings file is a symlink');
  }
  const fd = openSync(
    target,
    constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    writeFileSync(fd, file.contents, { encoding: 'utf8' });
  } finally {
    closeSync(fd);
  }
}

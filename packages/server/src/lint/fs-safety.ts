import { isAbsolute, relative } from 'node:path';
import { tracedRenameSync, tracedUnlinkSync, tracedWriteFileSync } from '../fs-traced.ts';

export function isInside(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

export function writeFileAtomic(file: string, content: string): void {
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
  try {
    tracedWriteFileSync(tmp, content, 'utf-8');
    tracedRenameSync(tmp, file);
  } catch (err) {
    try {
      tracedUnlinkSync(tmp);
    } catch {}
    throw err;
  }
}

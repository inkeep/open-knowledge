import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tracedMkdirSync, tracedWriteFileSync } from './fs-traced.ts';

export interface CopyDirOptions {
  readonly filter?: (src: string) => boolean;
}

export function copyDirSync(
  sourceDir: string,
  destDir: string,
  options: CopyDirOptions = {},
): void {
  tracedMkdirSync(destDir, { recursive: true });
  for (const entry of readdirSync(sourceDir)) {
    const src = join(sourceDir, entry);
    if (options.filter?.(src) === false) continue;
    const dest = join(destDir, entry);
    if (statSync(src).isDirectory()) {
      copyDirSync(src, dest, options);
    } else {
      tracedWriteFileSync(dest, readFileSync(src));
    }
  }
}

/**
 * Recursive directory copy that works when the SOURCE lives inside an
 * Electron `app.asar` archive.
 *
 * Electron's asar fs-shim DOES patch `cpSync` — but it patches it by extracting
 * the single FILE at the source path out of the archive and delegating to the
 * real `cpSync` (`overrideAPISync` in Electron's `lib/node/asar-fs-wrapper.ts`).
 * A directory node carries no `size`/`offset`, so `Archive::CopyFileOut` fails
 * on it and the shim itself throws `ENOENT ... not found in .../app.asar`
 * before any recursion runs. Observable directly: `cpSync` on a FILE inside the
 * archive succeeds, on a DIRECTORY it throws, while `existsSync`, `statSync`,
 * `readdirSync` and `readFileSync` succeed on either. Walking the tree with
 * those shimmed primitives is the only copy form that survives packaging, and
 * the desktop main process reaches this module with
 * `@inkeep/open-knowledge-server` (and its bundled `assets/skills/**`) packed
 * inside the asar.
 *
 * `asarUnpack` is not the alternative: the shim consults `info.unpacked` only
 * after the same file-info lookup that a directory node already fails.
 *
 * Symlinks in the source are dereferenced rather than recreated — the sources
 * this copies are our own bundled skill assets, which hold none, and a link
 * copied into a user's editor dir would dangle anyway.
 *
 * No `rmSync` here: callers that need wipe-then-copy freshness (so a bundle
 * bump that drops a file leaves no orphan) do it at their own call site, where
 * the symlink-escape guard also belongs.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tracedMkdirSync, tracedWriteFileSync } from './fs-traced.ts';

export interface CopyDirOptions {
  /**
   * Receives the absolute SOURCE path of each entry BELOW `sourceDir`; return
   * `false` to skip it (and, for a directory, its subtree). Two deliberate
   * departures from `cpSync`'s filter: no destination path is passed, and the
   * predicate is never invoked for `sourceDir` itself — pruning at the root
   * cannot cancel the copy the way it does there.
   */
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

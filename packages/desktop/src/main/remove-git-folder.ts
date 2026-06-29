import { existsSync, promises as fsPromises, realpathSync } from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';

const REJECT_PREFIX = 'ok:fs:remove-git-folder rejected:';

interface RemoveGitFolderDeps {
  /** Set of `gitRoot` strings the renderer may legitimately request. Populated
   *  by the main process on every `findEnclosingGitRoot` return. Tests pass a
   *  hand-built set. */
  readonly allowedGitRoots: ReadonlySet<string>;
}

export async function removeGitFolder(gitRoot: unknown, deps: RemoveGitFolderDeps): Promise<void> {
  if (typeof gitRoot !== 'string' || gitRoot.length === 0) {
    throw new Error(`${REJECT_PREFIX} gitRoot must be a non-empty string`);
  }
  if (!isAbsolute(gitRoot) || resolve(gitRoot) !== gitRoot) {
    throw new Error(`${REJECT_PREFIX} gitRoot must be an absolute, resolved path`);
  }
  if (!deps.allowedGitRoots.has(gitRoot)) {
    throw new Error(`${REJECT_PREFIX} gitRoot was not surfaced by a recent probe`);
  }
  const target = join(gitRoot, '.git');
  if (!existsSync(target)) {
    return;
  }
  try {
    const canonical = realpathSync(target);
    if (basename(canonical) !== '.git') {
      throw new Error(`${REJECT_PREFIX} resolved symlink target is not a .git entry`);
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return;
    if (err instanceof Error && err.message.startsWith(REJECT_PREFIX)) throw err;
    throw new Error(`${REJECT_PREFIX} could not resolve path (${code ?? 'unknown'})`, {
      cause: err,
    });
  }
  await fsPromises.rm(target, { recursive: true, force: true });
}

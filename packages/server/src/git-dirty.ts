import { createGitInstance } from './git-handle.ts';
import { listNames, listPorcelainPaths } from './git-paths.ts';

export interface DirtyOverlapResult {
  conflicts: boolean;
  files: string[];
}

export async function dirtyFilesOverlapWith(
  cwd: string,
  targetRef: string,
): Promise<DirtyOverlapResult> {
  const { git } = createGitInstance(cwd, { credentialConfig: [] });

  const [dirtyResult, changedResult] = await Promise.allSettled([
    listPorcelainPaths(git),
    listNames(git, ['diff', '--name-only', `HEAD..${targetRef}`]),
  ]);

  if (changedResult.status === 'rejected') throw changedResult.reason;
  if (dirtyResult.status === 'rejected') throw dirtyResult.reason;

  const dirtyList = dirtyResult.value;
  const changed = changedResult.value;

  const dirty = new Set(dirtyList);
  if (dirty.size === 0) return { conflicts: false, files: [] };

  if (changed.length === 0) return { conflicts: false, files: [] };

  const overlap = new Set<string>();
  for (const path of changed) {
    if (dirty.has(path)) overlap.add(path);
  }

  if (overlap.size === 0) return { conflicts: false, files: [] };
  return { conflicts: true, files: Array.from(overlap).sort() };
}

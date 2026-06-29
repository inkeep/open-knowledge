import { createGitInstance } from './git-handle.ts';

export interface DirtyOverlapResult {
  conflicts: boolean;
  files: string[];
}

function parsePorcelainPaths(porcelain: string): string[] {
  const paths: string[] = [];
  for (const line of porcelain.split('\n')) {
    if (line.length < 4) continue;
    const rest = line.slice(3);
    const renameIdx = rest.indexOf(' -> ');
    const path = renameIdx >= 0 ? rest.slice(renameIdx + 4) : rest;
    if (path.length > 0) paths.push(path);
  }
  return paths;
}

function parseDiffPaths(diffOutput: string): string[] {
  return diffOutput
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export async function dirtyFilesOverlapWith(
  cwd: string,
  targetRef: string,
): Promise<DirtyOverlapResult> {
  const { git } = createGitInstance(cwd);

  const [porcelain, diff] = await Promise.all([
    git.raw(['status', '--porcelain']),
    git.raw(['diff', '--name-only', `HEAD..${targetRef}`]),
  ]);

  const dirty = new Set(parsePorcelainPaths(porcelain));
  if (dirty.size === 0) return { conflicts: false, files: [] };

  const changed = parseDiffPaths(diff);
  if (changed.length === 0) return { conflicts: false, files: [] };

  const overlap = new Set<string>();
  for (const path of changed) {
    if (dirty.has(path)) overlap.add(path);
  }

  if (overlap.size === 0) return { conflicts: false, files: [] };
  return { conflicts: true, files: Array.from(overlap).sort() };
}

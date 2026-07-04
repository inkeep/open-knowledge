import { createGitInstance, splitNulSeparatedPaths } from './git-handle.ts';

export interface DirtyOverlapResult {
  conflicts: boolean;
  files: string[];
}

function parsePorcelainPaths(porcelain: string): string[] {
  // -z porcelain: NUL-separated "XY PATH" records; a rename/copy emits the
  // original path as the following record, without a status prefix.
  const paths: string[] = [];
  const records = porcelain.split('\0');
  for (let i = 0; i < records.length; i++) {
    const record = records[i] ?? '';
    if (record.length < 4) continue;
    paths.push(record.slice(3));
    if (record[0] === 'R' || record[0] === 'C') i++;
  }
  return paths;
}

export async function dirtyFilesOverlapWith(
  cwd: string,
  targetRef: string,
): Promise<DirtyOverlapResult> {
  const { git } = createGitInstance(cwd);

  const [porcelain, diff] = await Promise.all([
    git.raw(['status', '--porcelain', '-z']),
    git.raw(['diff', '--name-only', '-z', `HEAD..${targetRef}`]),
  ]);

  const dirty = new Set(parsePorcelainPaths(porcelain));
  if (dirty.size === 0) return { conflicts: false, files: [] };

  const changed = splitNulSeparatedPaths(diff);
  if (changed.length === 0) return { conflicts: false, files: [] };

  const overlap = new Set<string>();
  for (const path of changed) {
    if (dirty.has(path)) overlap.add(path);
  }

  if (overlap.size === 0) return { conflicts: false, files: [] };
  return { conflicts: true, files: Array.from(overlap).sort() };
}

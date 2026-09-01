import { statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { resolveGitDirDetailed } from '@inkeep/open-knowledge-core/shadow-repo-layout';

export type ResolvedGitDirKind =
  | 'directory'
  | 'linked'
  | 'absent'
  | 'malformed-pointer'
  | 'inaccessible';

function readHeadState(gitDir: string): 'present' | 'missing' | 'inaccessible' {
  try {
    statSync(join(gitDir, 'HEAD'));
    return 'present';
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'inaccessible';
  }
}

export function readGitDirKind(projectPath: string): ResolvedGitDirKind {
  if (!isAbsolute(projectPath)) return 'absent';
  try {
    const resolved = resolveGitDirDetailed(projectPath);
    if (resolved.kind === 'directory' || resolved.kind === 'linked') {
      if (resolved.projectSubPath !== '') return 'absent';
      try {
        statSync(resolved.path);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        return code === 'ENOENT' || code === 'ENOTDIR' ? 'malformed-pointer' : 'inaccessible';
      }
      const head = readHeadState(resolved.path);
      if (head !== 'present') return head === 'missing' ? 'absent' : 'inaccessible';
    }
    return resolved.kind;
  } catch {
    return 'absent';
  }
}

import { isAbsolute } from 'node:path';
import { resolveGitDirDetailed } from '@inkeep/open-knowledge-core/shadow-repo-layout';

export type ResolvedGitDirKind =
  | 'directory'
  | 'linked'
  | 'absent'
  | 'malformed-pointer'
  | 'inaccessible';

export function readGitDirKind(projectPath: string): ResolvedGitDirKind {
  if (!isAbsolute(projectPath)) return 'absent';
  try {
    return resolveGitDirDetailed(projectPath).kind;
  } catch {
    return 'absent';
  }
}

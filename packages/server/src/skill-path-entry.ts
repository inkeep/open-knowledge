import { lstatSync, realpathSync } from 'node:fs';
import { parseSkillDir } from '@inkeep/open-knowledge-core/skills-catalog';

export type SkillPathEntry =
  | { kind: 'absent' }
  | {
      kind: 'symlink';
      resolution: 'target' | 'elsewhere' | 'dangling';
    }
  | {
      kind: 'dir';
      identity: 'is-target' | 'same-content' | 'different';
    }
  | { kind: 'other' };

export function inspectSkillPathEntry(
  path: string,
  referenceDir: string,
  referenceHash: string,
): SkillPathEntry {
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(path);
  } catch {
    return { kind: 'absent' };
  }

  if (st.isSymbolicLink()) {
    try {
      return realpathSync(path) === realpathSync(referenceDir)
        ? { kind: 'symlink', resolution: 'target' }
        : { kind: 'symlink', resolution: 'elsewhere' };
    } catch {
      return { kind: 'symlink', resolution: 'dangling' };
    }
  }

  if (!st.isDirectory()) return { kind: 'other' };

  try {
    if (realpathSync(path) === realpathSync(referenceDir)) {
      return { kind: 'dir', identity: 'is-target' };
    }
  } catch {
    return { kind: 'dir', identity: 'different' };
  }
  return parseSkillDir(path)?.contentHash === referenceHash
    ? { kind: 'dir', identity: 'same-content' }
    : { kind: 'dir', identity: 'different' };
}

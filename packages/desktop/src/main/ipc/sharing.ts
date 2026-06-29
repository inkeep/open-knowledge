
import {
  addOkPathsToGitExclude,
  getExcludedOkPaths,
  getOkArtifactPaths,
  probeTrackedOkPaths,
  readSharingMode,
  removeOkPathsFromGitExclude,
  type SharingMode,
} from '@inkeep/open-knowledge';

export interface SharingStatusResult {
  /** Discriminant for the single `ok:sharing:dispatch` channel (see ipc-channels.ts).
   *  Lets renderer code narrow on `result.kind === 'status'` without
   *  consulting a parallel channel. */
  kind: 'status';
  mode: SharingMode;
  excluded: string[];
  trackedUpstream: string[];
}

export type SharingSetModeResult =
  | { kind: 'applied'; mode: SharingMode }
  | { kind: 'refused-tracked'; tracked: string[]; remediation: string }
  | {
      kind: 'no-exclude';
      reason: 'no-git' | 'no-info-dir' | 'malformed-pointer' | 'inaccessible';
    };

export function handleSharingStatus(projectPath: string): SharingStatusResult {
  try {
    const mode = readSharingMode(projectPath);
    const excluded = [...getExcludedOkPaths(projectPath)];
    const trackedUpstream = probeTrackedOkPaths(
      projectPath,
      getOkArtifactPaths(projectPath),
    ).tracked;
    return { kind: 'status', mode, excluded, trackedUpstream };
  } catch {
    return { kind: 'status', mode: 'no-git', excluded: [], trackedUpstream: [] };
  }
}

export function handleSharingSetMode(
  projectPath: string,
  mode: 'shared' | 'local-only',
): SharingSetModeResult {
  const paths = getOkArtifactPaths(projectPath);
  if (mode === 'local-only') {
    const result = addOkPathsToGitExclude(projectPath, paths);
    if (result.kind === 'refused-tracked') {
      return {
        kind: 'refused-tracked',
        tracked: [...result.tracked],
        remediation: result.remediation,
      };
    }
    if (result.kind === 'no-exclude') {
      return { kind: 'no-exclude', reason: result.reason };
    }
    return { kind: 'applied', mode: readSharingMode(projectPath) };
  }
  const result = removeOkPathsFromGitExclude(projectPath, paths);
  if (result.kind === 'no-exclude') {
    return { kind: 'no-exclude', reason: result.reason };
  }
  return { kind: 'applied', mode: readSharingMode(projectPath) };
}

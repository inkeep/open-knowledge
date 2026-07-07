/**
 * IPC handler implementations for the sharing-mode toggle in the per-project
 * Settings panel.
 *
 * Single channel `ok:sharing:dispatch` with discriminated args
 * (`kind: 'status'` | `kind: 'set-mode'`):
 *   - `status`   — pure read; returns mode + excluded paths +
 *                  trackedUpstream[] for the SharingSection UI.
 *   - `set-mode` — toggle. Routes through the same `addOkPathsToGitExclude` /
 *                  `removeOkPathsFromGitExclude` primitives the CLI uses, so
 *                  behavior cannot drift between desktop and CLI.
 *
 * Project scoping: each editor window has one bound projectPath via the
 * window-manager context. The renderer never passes a project path; main
 * looks it up from `event.sender`.
 */

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

/**
 * Pure read — never mutates. Returns the current sharing-mode posture
 * for a project. Safe to invoke from a mount effect; no rate-limiting
 * needed (the underlying `readSharingMode` and `getExcludedOkPaths` are
 * synchronous fs reads bounded by the artifact set).
 */
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
    // `probeTrackedOkPaths` shells out to `git` (which may be absent from
    // Electron's inherited PATH), and the fs reads can hit a TOCTOU /
    // permission throw. Degrade to a safe status so SharingSection renders
    // instead of the IPC promise rejecting and stranding it in its Skeleton.
    return { kind: 'status', mode: 'no-git', excluded: [], trackedUpstream: [] };
  }
}

/**
 * Toggle the mode. `local-only` calls `addOkPathsToGitExclude` which runs
 * the tracked-files probe internally; on refusal we return the
 * pre-formatted remediation for the renderer to render in a modal /
 * sticky toast. `shared` removes OK paths unconditionally.
 *
 * Robust against a malformed `mode` argument from the wire — defaults to
 * the safer `shared` write rather than refusing the call.
 */
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
        // `addOkPathsToGitExclude` attaches the pre-formatted remediation
        // (typed `string`); the renderer shows the same copy the CLI prints.
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

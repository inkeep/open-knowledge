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
  readSkillsShared,
  removeOkPathsFromGitExclude,
  type SharingMode,
  setSkillsShared,
} from '@inkeep/open-knowledge';

export interface SharingStatusResult {
  /** Discriminant for the single `ok:sharing:dispatch` channel (see ipc-channels.ts).
   *  Lets renderer code narrow on `result.kind === 'status'` without
   *  consulting a parallel channel. */
  kind: 'status';
  mode: SharingMode;
  excluded: string[];
  trackedUpstream: string[];
  /** True when local-only but `.ok/skills/` is carved back out as shareable
   *  (see `readSkillsShared`). Always false outside local-only. Drives the
   *  Skills UI "share skills" toggle position. */
  skillsShared: boolean;
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
    const skillsShared = readSkillsShared(projectPath);
    return { kind: 'status', mode, excluded, trackedUpstream, skillsShared };
  } catch {
    // `probeTrackedOkPaths` shells out to `git` (which may be absent from
    // Electron's inherited PATH), and the fs reads can hit a TOCTOU /
    // permission throw. Degrade to a safe status so SharingSection renders
    // instead of the IPC promise rejecting and stranding it in its Skeleton.
    return {
      kind: 'status',
      mode: 'no-git',
      excluded: [],
      trackedUpstream: [],
      skillsShared: false,
    };
  }
}

/**
 * Toggle whether `.ok/skills/` stays shareable while the rest of `.ok/`
 * remains local-only. Delegates to the shared `setSkillsShared` primitive, so
 * desktop and CLI cannot drift. Only meaningful in local-only mode; the
 * renderer gates the toggle's visibility. Returns the same discriminated
 * result shape as `set-mode` (no `refused-tracked` arm — carving skills OUT
 * only removes exclusion, it never hides a tracked file).
 */
export function handleSharingSetSkillsShared(
  projectPath: string,
  shared: boolean,
): SharingSetModeResult {
  const result = setSkillsShared(projectPath, shared);
  if (result.kind === 'no-exclude') {
    return { kind: 'no-exclude', reason: result.reason };
  }
  return { kind: 'applied', mode: readSharingMode(projectPath) };
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

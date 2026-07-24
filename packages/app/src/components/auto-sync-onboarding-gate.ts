/**
 * Pure decision function for the AutoSync onboarding modal.
 *
 * Returns which prompt variant to show, or `null` to stay hidden. The dialog
 * opens once per machine per project when every gate condition aligns:
 *   1. The user has not yet dismissed it this session.
 *   2. A git remote exists for the project (`hasRemote === true`).
 *   3. The project-local CRDT binding has synced from disk
 *      (`projectLocalSynced === true`) — the flash-free guard. Without
 *      this, the dialog briefly mounts during the cold-start window
 *      before the Hocuspocus provider's first 'synced' event lands.
 *   4. The committed project binding has synced (`projectSynced === true`) —
 *      the same flash-free guard for the committed `autoSync.default` read in
 *      condition 7. Until the committed doc lands, `default` reads as the
 *      schema default (`null`), so a project that ships a default would flash
 *      the modal open and then close once the real value arrives.
 *   5. The local config is hydrated (`projectLocalConfig !== null`).
 *   6. This machine hasn't answered yet — the resolved local mode is `null`.
 *      `resolveLocalAutoSyncMode` reads `autoSync.mode` and falls back to the
 *      legacy `autoSync.enabled` boolean, so a machine that answered under
 *      either shape is treated as answered.
 *   7. The maintainer has NOT committed an `autoSync.default` seed
 *      (`modeFromCommittedDefault(default)` is `null`). A committed default
 *      (off/pull/full, or the legacy boolean) pre-answers the prompt for
 *      everyone who clones the project, so the modal is suppressed; only a
 *      null/absent default still asks.
 *   8. The push-permission probe HAS resolved to a forking verdict. `allowed`
 *      returns the full-sync variant; `denied` (incl. the anonymous no-network
 *      short-circuit, the common case on share-linked clones) returns the
 *      pull-only variant. `unknown` (probe failed) and `undefined` (probe
 *      pending) both suppress: showing a full-sync prompt to a maybe-denied
 *      user promises pushes we can't keep, and Settings stays available for a
 *      later opt-in. The pending suppression is also the flash-free guard.
 *
 * Extracted from EditorPane into a pure function so each input contributes
 * to an independently testable truth table. The cheapest checks come first
 * to short-circuit before the more expensive reads.
 */
import {
  modeFromCommittedDefault,
  resolveLocalAutoSyncMode,
  type StoredSyncMode,
} from '@inkeep/open-knowledge-core';

/** Which onboarding prompt to show; `follow` explains one-directional sync. */
export type AutoSyncOnboardingVariant = 'full' | 'follow';

export interface AutoSyncOnboardingGateInputs {
  /** Local React state — has the user already dismissed this session? */
  autoSyncOnboardingDismissed: boolean;
  /** Server status: does a git remote exist? */
  hasRemote: boolean | undefined;
  /** CRDT lifecycle: has the project-local config doc finished its first sync? */
  projectLocalSynced: boolean | undefined;
  /** CRDT lifecycle: has the committed project config doc finished its first sync? */
  projectSynced: boolean | undefined;
  /** Project-local config — null until the binding hydrates. */
  projectLocalConfig: {
    autoSync?: { mode?: StoredSyncMode | null; enabled?: boolean | null } | null;
  } | null;
  /** Committed project config — carries the maintainer's autoSync.default seed. */
  projectConfig: { autoSync?: { default?: boolean | StoredSyncMode | null } | null } | null;
  /** Push-permission probe outcome. */
  pushPermissionCheckStatus: 'allowed' | 'denied' | 'unknown' | undefined;
}

export function resolveAutoSyncOnboarding(
  inputs: AutoSyncOnboardingGateInputs,
): AutoSyncOnboardingVariant | null {
  const aligned =
    !inputs.autoSyncOnboardingDismissed &&
    inputs.hasRemote === true &&
    inputs.projectLocalSynced === true &&
    inputs.projectSynced === true &&
    inputs.projectLocalConfig !== null &&
    resolveLocalAutoSyncMode(inputs.projectLocalConfig.autoSync ?? undefined) === null &&
    modeFromCommittedDefault(inputs.projectConfig?.autoSync?.default) === null;
  if (!aligned) return null;

  switch (inputs.pushPermissionCheckStatus) {
    case 'allowed':
      return 'full';
    case 'denied':
      return 'follow';
    default:
      return null;
  }
}

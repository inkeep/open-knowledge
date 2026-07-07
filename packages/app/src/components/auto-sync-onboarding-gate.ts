/**
 * Pure decision function for the AutoSync onboarding modal.
 *
 * The dialog opens once per machine per project when:
 *   1. The user has not yet dismissed it this session.
 *   2. A git remote exists for the project (`hasRemote === true`).
 *   3. The project-local CRDT binding has synced from disk
 *      (`projectLocalSynced === true`) — the flash-free guard. Without
 *      this, the dialog briefly mounts during the cold-start window
 *      before the Hocuspocus provider's first 'synced' event lands.
 *   4. The committed project binding has synced (`projectSynced === true`) —
 *      the same flash-free guard for the committed `autoSync.default` read in
 *      condition 7. Until the committed doc lands, `default` reads as the
 *      schema default (`null`), so a project that ships `default: false` would
 *      flash the modal open and then close once the real value arrives.
 *   5. The local config is hydrated (`projectLocalConfig !== null`).
 *   6. The user hasn't answered the autoSync prompt yet
 *      (`autoSync.enabled === null`). The schema's `nullable().default(null)`
 *      makes `null` the canonical "unanswered" sentinel — never `undefined`.
 *   7. The maintainer has NOT committed an `autoSync.default` seed
 *      (`projectConfig.autoSync.default` is `null`/absent). A committed `true`
 *      or `false` pre-answers the prompt for everyone who clones the project,
 *      so the modal is suppressed; only a null/absent default still asks.
 *   8. The push-permission probe HAS resolved AND did not return `'denied'`.
 *      The gate requires the probe to settle first — `undefined` (probe
 *      still pending) keeps the dialog hidden so we don't flash it open
 *      and then close it the moment the probe returns `denied` (the
 *      common case on share-linked clones of someone else's repo).
 *      `'unknown'` (probe failed) still passes — graceful degradation
 *      preserves the read+write user's onboarding ask when the probe
 *      can't reach a verdict.
 *
 * Extracted from EditorPane into a pure function so each input contributes
 * to an independently testable truth table. The cheapest checks come first
 * to short-circuit before the more expensive reads.
 */
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
  projectLocalConfig: { autoSync?: { enabled: boolean | null } | null } | null;
  /** Committed project config — carries the maintainer's autoSync.default seed. */
  projectConfig: { autoSync?: { default?: boolean | null } | null } | null;
  /** Push-permission probe outcome. */
  pushPermissionCheckStatus: 'allowed' | 'denied' | 'unknown' | undefined;
}

export function shouldShowAutoSyncOnboarding(inputs: AutoSyncOnboardingGateInputs): boolean {
  return (
    !inputs.autoSyncOnboardingDismissed &&
    inputs.hasRemote === true &&
    inputs.projectLocalSynced === true &&
    inputs.projectSynced === true &&
    inputs.projectLocalConfig !== null &&
    inputs.projectLocalConfig.autoSync?.enabled === null &&
    // A committed autoSync.default (true OR false) pre-answers the prompt for
    // everyone who clones the project — suppress the modal whenever the
    // maintainer set one; only a null/absent default falls through to the ask.
    // Gated on projectSynced above so this compares against the real committed
    // value, not the schema default during the cold-start sync window.
    (inputs.projectConfig?.autoSync?.default ?? null) === null &&
    // Probe must have resolved AND not be 'denied' — `undefined` (pending)
    // would flash the dialog and then close on the probe's `denied` return.
    // `'unknown'` passes for graceful degradation when the probe can't
    // reach a verdict (network failure, rate-limit, etc.).
    (inputs.pushPermissionCheckStatus === 'allowed' ||
      inputs.pushPermissionCheckStatus === 'unknown')
  );
}

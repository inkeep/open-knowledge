/**
 * Origin-aware classification for the paired-intake content-loss detector.
 *
 * Every paired-write origin (the `context.origin` of a `PairedWriteOrigin`) is
 * classified `detect` or `suppress`:
 *
 *  - `detect` — the paired write can silently discard content the fragment held
 *    but Y.Text never did (a never-propagated keystroke), so its intake derive
 *    runs the content-loss post-condition. The pre-operation Y.Text baseline
 *    already excludes content the operation legitimately removed, so a `detect`
 *    origin only trips on a genuine loss.
 *  - `suppress` — a legitimate full replacement (the user's explicit intent to
 *    discard the current state), a content-preserving move, or a no-mutation
 *    op. Running the detector here would be a false positive.
 *
 * Fail-closed: a paired origin with no entry fails the sweep meta-test, so a new
 * write surface cannot silently escape the loss-detection contract. Reserved
 * entries (no source constant yet) are listed separately so the conflict spec's
 * machine-merge origin has a declared classification before it lands.
 */

/** Whether a paired origin's intake derive runs the content-loss post-condition. */
export type PairedIntakeDetectionMode = 'detect' | 'suppress';

interface PairedIntakeDetectionEntry {
  mode: PairedIntakeDetectionMode;
  /** Why this classification holds — read by the sweep test's reporting. */
  why: string;
}

/**
 * The classification of every live paired-write `context.origin`. Keyed by the
 * origin string so the runtime consumer (the paired-intake wiring) and the
 * source sweep both look up the same value.
 */
export const PAIRED_INTAKE_DETECTION: Record<string, PairedIntakeDetectionEntry> = {
  'agent-write': {
    mode: 'detect',
    why: 'An agent write can race un-propagated WYSIWYG content; the pre-write baseline excludes the write itself, so only a never-propagated keystroke trips.',
  },
  'agent-undo': {
    mode: 'detect',
    why: 'The Observer-B agent-undo derive; the pre-undo baseline excludes the undo’s own removal, so only a never-propagated keystroke trips.',
  },
  'file-watcher': {
    mode: 'detect',
    why: 'An external disk write overwriting a dirty open doc drops un-propagated content; the pre-write baseline excludes the incoming change itself.',
  },
  'rollback-apply': {
    mode: 'suppress',
    why: 'An explicit restore of a historical version; discarding the current state is the user intent, and that state stays a timeline version.',
  },
  'managed-rename': {
    mode: 'suppress',
    why: 'A rename re-writes the same content at a new path; no content is dropped by construction.',
  },
  'park-snapshot': {
    mode: 'suppress',
    why: 'A read-only snapshot capture that makes no Y.Doc mutation, so no content can be lost.',
  },
};

/**
 * Reserved classifications for paired origins that have no source constant yet.
 * The conflict spec's machine-merge origin registers here so the sweep passes
 * before it lands; when its constant appears the sweep moves it to the live map.
 */
export const RESERVED_PAIRED_INTAKE_DETECTION: Record<string, PairedIntakeDetectionEntry> = {
  'machine-merge': {
    mode: 'detect',
    why: 'Reserved for the conflict spec: a machine merge landing into a dirty doc can drop un-propagated content; classified detect ahead of the constant.',
  },
};

/**
 * The classification for a paired origin, or `undefined` when it is unclassified
 * (which the sweep meta-test treats as a fail-closed violation).
 */
export function pairedIntakeDetectionMode(
  originContextOrigin: string,
): PairedIntakeDetectionMode | undefined {
  return PAIRED_INTAKE_DETECTION[originContextOrigin]?.mode;
}

/**
 * Whether the paired-intake content-loss detector should run for this origin.
 * An unclassified origin returns `false` (suppress) so an un-registered write
 * surface never emits spurious detections at runtime — the sweep meta-test is
 * what fails the build so the gap is closed before it can matter.
 */
export function shouldRunPairedIntakeDetection(originContextOrigin: string): boolean {
  return PAIRED_INTAKE_DETECTION[originContextOrigin]?.mode === 'detect';
}

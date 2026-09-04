export type PairedIntakeDetectionMode = 'detect' | 'suppress';

interface PairedIntakeDetectionEntry {
  mode: PairedIntakeDetectionMode;
  why: string;
}

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
  'generated-index': {
    mode: 'suppress',
    why: 'A rebuild of a file OK authors: its content is derived from the other documents, and replacing a hand edit is the stated contract of generating it, not a loss.',
  },
};

export const RESERVED_PAIRED_INTAKE_DETECTION: Record<string, PairedIntakeDetectionEntry> = {
  'machine-merge': {
    mode: 'detect',
    why: 'Reserved for the conflict spec: a machine merge landing into a dirty doc can drop un-propagated content; classified detect ahead of the constant.',
  },
};

export function pairedIntakeDetectionMode(
  originContextOrigin: string,
): PairedIntakeDetectionMode | undefined {
  return PAIRED_INTAKE_DETECTION[originContextOrigin]?.mode;
}

export function shouldRunPairedIntakeDetection(originContextOrigin: string): boolean {
  return PAIRED_INTAKE_DETECTION[originContextOrigin]?.mode === 'detect';
}

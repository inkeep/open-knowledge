/**
 * Pure helpers for the VSCode-parity Move-to-Trash confirm modal copy. Lifted
 * out of FileTree so the verbatim copy variants are testable in isolation —
 * single-file / single-folder / multi-files / multi-folders / multi-mixed are
 * each pinned by name in the test suite. Match VSCode's `fileActions.ts`:
 *
 *   single file:    "Are you sure you want to delete '<name>'?"
 *   single folder:  "Are you sure you want to delete '<name>' and its contents?"
 *   multi files:    "Are you sure you want to delete the following <N> files?"
 *   multi folders:  "Are you sure you want to delete the following <N> directories and their contents?"
 *   multi mixed:    "Are you sure you want to delete the following <N> files/directories and their contents?"
 *
 * Detail (macOS):  "You can restore this file from the Trash."
 * Buttons:         [Move to Trash] [Cancel]
 *
 * Web mode uses today's `DeleteConfirmationDialog` copy via the `web` variant
 * of `selectTrashConfirmCopy` — keeps the verbatim copy Electron-scoped.
 */

import type { FileTreeTarget } from '@/components/file-tree-operations';

interface TrashConfirmCopy {
  title: string;
  /** Render under the title; macOS Trash-restoration affordance. */
  detail: string;
  /** When set, render the list of targets under the detail. */
  listedTargets: ReadonlyArray<FileTreeTarget> | null;
  /** Primary destructive button label. */
  confirmLabel: string;
  /** Primary destructive button label while the action is in-flight. */
  confirmLabelBusy: string;
}

/**
 * VSCode-verbatim Trash detail. macOS uses "this file" wording even for
 * folders + multi-target — matches VSCode (`getMoveToTrashMessage` in
 * `fileActions.ts`).
 */
export const TRASH_DETAIL_MACOS = 'You can restore this file from the Trash.';

export function buildTrashConfirmCopyElectron(
  targets: ReadonlyArray<FileTreeTarget>,
): TrashConfirmCopy {
  const detail = TRASH_DETAIL_MACOS;
  const confirmLabel = 'Move to Trash';
  const confirmLabelBusy = 'Moving';
  if (targets.length === 0) {
    // Defensive — caller should never invoke with an empty target list, but
    // pinning a stable shape here keeps the dialog renderer simple.
    return {
      title: 'Are you sure you want to delete the selected items?',
      detail,
      listedTargets: null,
      confirmLabel,
      confirmLabelBusy,
    };
  }
  if (targets.length === 1) {
    const only = targets[0];
    if (!only) {
      // Unreachable given length === 1; keeps the noUncheckedIndexedAccess
      // type-safety boundary honest without leaning on `!`.
      return {
        title: 'Are you sure you want to delete the selected item?',
        detail,
        listedTargets: null,
        confirmLabel,
        confirmLabelBusy,
      };
    }
    if (only.kind === 'folder') {
      return {
        title: `Are you sure you want to delete '${only.name}' and its contents?`,
        detail,
        listedTargets: null,
        confirmLabel,
        confirmLabelBusy,
      };
    }
    return {
      title: `Are you sure you want to delete '${only.name}'?`,
      detail,
      listedTargets: null,
      confirmLabel,
      confirmLabelBusy,
    };
  }
  const hasFolder = targets.some((t) => t.kind === 'folder');
  const hasFile = targets.some((t) => t.kind !== 'folder');
  if (hasFolder && hasFile) {
    return {
      title: `Are you sure you want to delete the following ${targets.length} files/directories and their contents?`,
      detail,
      listedTargets: targets,
      confirmLabel,
      confirmLabelBusy,
    };
  }
  if (hasFolder) {
    return {
      title: `Are you sure you want to delete the following ${targets.length} directories and their contents?`,
      detail,
      listedTargets: targets,
      confirmLabel,
      confirmLabelBusy,
    };
  }
  return {
    title: `Are you sure you want to delete the following ${targets.length} files?`,
    detail,
    listedTargets: targets,
    confirmLabel,
    confirmLabelBusy,
  };
}

/**
 * Web mode preserves today's `DeleteConfirmationDialog` copy + hard delete via
 * `POST /api/delete-path`. No OS Trash exists in the browser; the VSCode-Trash
 * modal applies to Electron only. The web variant returns `null` so the
 * caller renders today's default copy.
 */
export function selectTrashConfirmCopy(
  variant: 'electron' | 'web',
  targets: ReadonlyArray<FileTreeTarget>,
): TrashConfirmCopy | null {
  if (variant === 'web') return null;
  return buildTrashConfirmCopyElectron(targets);
}

/** Display string for a target: folder shows trailing slash, markdown file shows extension. */
export function trashTargetDisplayName(target: FileTreeTarget): string {
  if (target.kind === 'folder') return `${target.name}/`;
  // Assets never carry docExt; keep their display independent from markdown file rules.
  if (target.kind === 'asset') return target.name;
  return target.docExt ? `${target.name}${target.docExt}` : target.name;
}

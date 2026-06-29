
import type { FileTreeTarget } from '@/components/file-tree-operations';

interface TrashConfirmCopy {
  title: string;
  detail: string;
  listedTargets: ReadonlyArray<FileTreeTarget> | null;
  confirmLabel: string;
  confirmLabelBusy: string;
}

export const TRASH_DETAIL_MACOS = 'You can restore this file from the Trash.';

export function buildTrashConfirmCopyElectron(
  targets: ReadonlyArray<FileTreeTarget>,
): TrashConfirmCopy {
  const detail = TRASH_DETAIL_MACOS;
  const confirmLabel = 'Move to Trash';
  const confirmLabelBusy = 'Moving';
  if (targets.length === 0) {
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

export function selectTrashConfirmCopy(
  variant: 'electron' | 'web',
  targets: ReadonlyArray<FileTreeTarget>,
): TrashConfirmCopy | null {
  if (variant === 'web') return null;
  return buildTrashConfirmCopyElectron(targets);
}

export function trashTargetDisplayName(target: FileTreeTarget): string {
  if (target.kind === 'folder') return `${target.name}/`;
  if (target.kind === 'asset') return target.name;
  return target.docExt ? `${target.name}${target.docExt}` : target.name;
}

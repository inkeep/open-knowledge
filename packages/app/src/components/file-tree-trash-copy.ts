import { plural, t } from '@lingui/core/macro';
import type { FileTreeTarget } from '@/components/file-tree-operations';

interface TrashConfirmCopy {
  title: string;
  detail: string;
  listedTargets: ReadonlyArray<FileTreeTarget> | null;
  confirmLabel: string;
  confirmLabelBusy: string;
}

export function trashDetailMacos(): string {
  return t`You can restore this file from the Trash.`;
}

export function trashDetailWindows(): string {
  return t`You can restore this file from the Recycle Bin.`;
}

export function buildTrashConfirmCopyElectron(
  targets: ReadonlyArray<FileTreeTarget>,
  platform?: string | null,
): TrashConfirmCopy {
  const isWindows = platform === 'win32';
  const detail = isWindows ? trashDetailWindows() : trashDetailMacos();
  const confirmLabel = isWindows ? t`Move to Recycle Bin` : t`Move to Trash`;
  const confirmLabelBusy = t`Moving`;
  if (targets.length === 0) {
    return {
      title: t`Are you sure you want to delete the selected items?`,
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
        title: t`Are you sure you want to delete the selected item?`,
        detail,
        listedTargets: null,
        confirmLabel,
        confirmLabelBusy,
      };
    }
    const name = only.name;
    if (only.kind === 'folder') {
      return {
        title: t`Are you sure you want to delete "${name}" and its contents?`,
        detail,
        listedTargets: null,
        confirmLabel,
        confirmLabelBusy,
      };
    }
    return {
      title: t`Are you sure you want to delete "${name}"?`,
      detail,
      listedTargets: null,
      confirmLabel,
      confirmLabelBusy,
    };
  }
  const hasFolder = targets.some((target) => target.kind === 'folder');
  const hasFile = targets.some((target) => target.kind !== 'folder');
  const count = targets.length;
  if (hasFolder && hasFile) {
    return {
      title: plural(count, {
        one: 'Are you sure you want to delete the following # file/directory and its contents?',
        other:
          'Are you sure you want to delete the following # files/directories and their contents?',
      }),
      detail,
      listedTargets: targets,
      confirmLabel,
      confirmLabelBusy,
    };
  }
  if (hasFolder) {
    return {
      title: plural(count, {
        one: 'Are you sure you want to delete the following # directory and its contents?',
        other: 'Are you sure you want to delete the following # directories and their contents?',
      }),
      detail,
      listedTargets: targets,
      confirmLabel,
      confirmLabelBusy,
    };
  }
  return {
    title: plural(count, {
      one: 'Are you sure you want to delete the following # file?',
      other: 'Are you sure you want to delete the following # files?',
    }),
    detail,
    listedTargets: targets,
    confirmLabel,
    confirmLabelBusy,
  };
}

export function selectTrashConfirmCopy(
  variant: 'electron' | 'web',
  targets: ReadonlyArray<FileTreeTarget>,
  platform?: string | null,
): TrashConfirmCopy | null {
  if (variant === 'web') return null;
  return buildTrashConfirmCopyElectron(targets, platform);
}

export function trashTargetDisplayName(target: FileTreeTarget): string {
  if (target.kind === 'folder') return `${target.name}/`;
  if (target.kind === 'asset') return target.name;
  return target.docExt ? `${target.name}${target.docExt}` : target.name;
}

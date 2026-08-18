/**
 * Pure helpers for the VSCode-parity Move-to-Trash confirm modal copy. Lifted
 * out of FileTree so the verbatim copy variants are testable in isolation —
 * single-file / single-folder / multi-files / multi-folders / multi-mixed are
 * each pinned by name in the test suite. Match VSCode's `fileActions.ts`
 * (name wrapped in `"…"` here rather than `'…'` — see quote-style note below):
 *
 *   single file:    "Are you sure you want to delete \"<name>\"?"
 *   single folder:  "Are you sure you want to delete \"<name>\" and its contents?"
 *   multi files:    "Are you sure you want to delete the following <N> files?"
 *   multi folders:  "Are you sure you want to delete the following <N> directories and their contents?"
 *   multi mixed:    "Are you sure you want to delete the following <N> files/directories and their contents?"
 *
 * Detail (macOS/Linux): "You can restore this file from the Trash."
 * Detail (Windows):     "You can restore this file from the Recycle Bin."
 * Buttons:              [Move to Trash] / [Move to Recycle Bin], [Cancel]
 *
 * Web mode uses today's `DeleteConfirmationDialog` copy via the `web` variant
 * of `selectTrashConfirmCopy` — keeps the verbatim copy Electron-scoped.
 *
 * VSCode parity is a claim about the **English** source. Every string here is
 * a `t` / `plural` macro so the other locales get their own phrasing rather
 * than an English confirm dialog in a translated app; the count-bearing titles
 * are plurals because "1 file" and "3 files" do not share a form in most of
 * the languages this app speaks.
 *
 * Quote style — WARN. Wrap interpolated names in `"…"` (double quotes), NOT
 * `'…'` (single quotes). Lingui compiles its message catalog as ICU
 * MessageFormat, and in ICU a `'…'`-wrapped section is an **escape**: the
 * enclosed placeholder is treated as literal text and stripped of its
 * interpolation slot. Extracting `t\`… '${name}' …\`` writes the msgid
 * `"… '{name}' …"` to the .po; the compiler then emits `"… {name} …"` as one
 * flat string with no slot, so the runtime shows a literal `{name}` to the
 * user. Double quotes have no ICU escape meaning and interpolate correctly.
 * This also matches the codebase-wide convention (see the `t\`… "${var}" …\``
 * sites in SeedDialog / TemplateDeleteDialog / CommandPalette / PropertyPanel).
 * VSCode's own copy uses `'`, but the i18n contract wins over glyph parity.
 */

import { plural, t } from '@lingui/core/macro';
import type { FileTreeTarget } from '@/components/file-tree-operations';

interface TrashConfirmCopy {
  title: string;
  /** Render under the title; the OS trash-restoration affordance. */
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
 * `fileActions.ts`). Windows swaps the destination noun for "Recycle Bin"
 * (also VSCode's copy there); Linux shares the macOS strings.
 *
 * Functions, not `const`s: the macro at module scope would resolve once at
 * import and then keep whatever language was active then.
 */
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
    // Defensive — caller should never invoke with an empty target list, but
    // pinning a stable shape here keeps the dialog renderer simple.
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
      // Unreachable given length === 1; keeps the noUncheckedIndexedAccess
      // type-safety boundary honest without leaning on `!`.
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

/**
 * Web mode preserves today's `DeleteConfirmationDialog` copy + hard delete via
 * `POST /api/delete-path`. No OS Trash exists in the browser; the VSCode-Trash
 * modal applies to Electron only. The web variant returns `null` so the
 * caller renders today's default copy.
 */
export function selectTrashConfirmCopy(
  variant: 'electron' | 'web',
  targets: ReadonlyArray<FileTreeTarget>,
  platform?: string | null,
): TrashConfirmCopy | null {
  if (variant === 'web') return null;
  return buildTrashConfirmCopyElectron(targets, platform);
}

/** Display string for a target: folder shows trailing slash, markdown file shows extension. */
export function trashTargetDisplayName(target: FileTreeTarget): string {
  if (target.kind === 'folder') return `${target.name}/`;
  // Assets never carry docExt; keep their display independent from markdown file rules.
  if (target.kind === 'asset') return target.name;
  return target.docExt ? `${target.name}${target.docExt}` : target.name;
}

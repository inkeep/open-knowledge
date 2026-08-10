/**
 * Platform-adaptive labels for actions that name an OS surface (the file
 * manager, the trash). Renderer-side mirror of the shared
 * `PLATFORM_MENU_LABELS` vocabulary in `@inkeep/open-knowledge-core` — the
 * Lingui macros need string literals at the call site, so the strings are
 * restated here and the label-parity test keeps the two sides in lockstep.
 *
 * Vocabulary mirrors VS Code. The Linux verb asymmetry (Open vs Reveal) is
 * intentional — there is no stable Linux file-manager brand to "Reveal in";
 * a normalizing fix to "Reveal in Files" would be incorrect on most distros.
 *
 * `platform` is the desktop bridge's `process.platform` value; callers in the
 * web build (no bridge) fall back to the macOS strings, matching the
 * historical default.
 */

import { t } from '@lingui/core/macro';

export function revealInFileManagerLabel(platform: string | null | undefined): string {
  if (platform === 'win32') return t`Reveal in File Explorer`;
  if (platform === 'linux') return t`Open containing folder`;
  return t`Reveal in Finder`;
}

export function moveToTrashLabel(platform: string | null | undefined): string {
  return platform === 'win32' ? t`Move to Recycle Bin` : t`Move to Trash`;
}

/** The OS trash destination as a noun, for sentences ("… is in your Trash"). */
export function trashNounLabel(platform: string | null | undefined): string {
  return platform === 'win32' ? t`Recycle Bin` : t`Trash`;
}

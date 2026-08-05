import { t } from '@lingui/core/macro';

/**
 * Platform-specific label for the file-manager reveal action. Mirrors VS Code's copy.
 * Linux verb asymmetry (Open vs Reveal) is intentional — no stable Linux file-manager
 * brand to "Reveal in"; a normalizing fix to "Reveal in Files" would be incorrect on
 * most distros.
 *
 * Shared by every reveal surface (file tree rows, editor tabs, skills menus) so a
 * Windows or Linux user never sees one menu say "Finder" and its sibling say the
 * right thing. `t` resolves at call time against the active locale, so this must be
 * called per render rather than hoisted to a module constant.
 */
export function revealInFileManagerLabel(platform: 'darwin' | 'win32' | 'linux'): string {
  if (platform === 'darwin') return t`Reveal in Finder`;
  if (platform === 'win32') return t`Reveal in File Explorer`;
  return t`Open containing folder`;
}

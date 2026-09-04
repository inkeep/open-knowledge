import { t } from '@lingui/core/macro';

export function revealInFileManagerLabel(platform: string | null | undefined): string {
  if (platform === 'win32') return t`Reveal in File Explorer`;
  if (platform === 'linux') return t`Open containing folder`;
  return t`Reveal in Finder`;
}

export function moveToTrashLabel(platform: string | null | undefined): string {
  return platform === 'win32' ? t`Move to Recycle Bin` : t`Move to Trash`;
}

export function trashNounLabel(platform: string | null | undefined): string {
  return platform === 'win32' ? t`Recycle Bin` : t`Trash`;
}

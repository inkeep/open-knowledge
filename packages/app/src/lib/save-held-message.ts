import {
  type ConfigValidationError,
  isKnownConfigError,
} from '@inkeep/open-knowledge-core/config/errors';
import type { DocNoticeWire } from '@inkeep/open-knowledge-core/schemas/api';
import type { MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/macro';

type SaveHeldCause = Extract<DocNoticeWire, { kind: 'save-held' }>['cause'];

export function saveHeldMessage(cause: SaveHeldCause, file: string): MessageDescriptor {
  switch (cause) {
    case 'no-history-or-backup':
      return msg`${file} was not saved. It changed outside OpenKnowledge, and that version could not be kept in history or in the backup folder, so the file was not written over. Your edits stay here, and saving is tried again.`;
    case 'keeps-changing':
      return msg`${file} was not saved because it kept changing outside OpenKnowledge. Your edits stay here, and saving is tried again.`;
    case 'not-utf8':
      return msg`${file} was not saved because it changed outside OpenKnowledge to content that is not UTF-8 text, so the file was not written over. Your edits stay here, and saving is tried again when the file changes.`;
    case 'unreadable':
      return msg`${file} was not saved because it could not be read to compare it with outside changes, so the file was not written over. Your edits stay here, and saving is tried again.`;
  }
}

export function saveHeldRejection(error: ConfigValidationError): MessageDescriptor | null {
  if (!isKnownConfigError(error) || error.code !== 'SAVE_HELD') return null;
  return saveHeldMessage(error.cause, error.file);
}

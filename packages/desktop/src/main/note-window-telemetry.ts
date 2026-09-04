import { withSpanSync } from '@inkeep/open-knowledge-server';
import type { NoteWindowEntryPoint } from './note-window-registry.ts';

export function recordNoteWindowOpened(info: { entryPoint: NoteWindowEntryPoint }): void {
  withSpanSync(
    'ok.desktop.noteWindowOpened',
    { attributes: { 'ok.desktop.note_entry_point': info.entryPoint } },
    () => undefined,
  );
}

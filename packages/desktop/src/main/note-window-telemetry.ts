/**
 * Pop-out note-window adoption telemetry.
 *
 * OK Desktop has no product-analytics surface; opt-in OpenTelemetry is the only
 * signal available, and it is off by default, so this reads only for opted-in
 * users and dogfood. `withSpanSync` is a no-op when the SDK is disabled, so
 * default builds pay nothing.
 *
 * The lone attribute is the entry-point enum. No document name, no path, no
 * project identifier ever rides along: the whole point of the pop-out is that a
 * document is on screen, and document names are unbounded user content.
 */

import { withSpanSync } from '@inkeep/open-knowledge-server';
import type { NoteWindowEntryPoint } from './note-window-registry.ts';

/**
 * Emit one `ok.desktop.noteWindowOpened` span. Fired from the factory, which is
 * the single creation path, so the span count is the open count. A dedup hit
 * (focus-existing) is deliberately NOT an open and emits nothing — otherwise the
 * adoption number would count focus events as new windows.
 */
export function recordNoteWindowOpened(info: { entryPoint: NoteWindowEntryPoint }): void {
  withSpanSync(
    'ok.desktop.noteWindowOpened',
    { attributes: { 'ok.desktop.note_entry_point': info.entryPoint } },
    () => undefined,
  );
}

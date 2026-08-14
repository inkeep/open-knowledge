/**
 * Renderer entry point for "Open in New Window" — the doc-tab context menu and
 * the command palette both call this.
 *
 * Desktop-only by construction: it invokes the `ok:window:open-note` bridge
 * channel, and the web host has no bridge. Both callers already gate on the
 * bridge existing, so a missing bridge here means a programming error rather
 * than a user-facing state, and it resolves without a toast.
 *
 * The spawn is keep-both (the origin tab stays open) and nothing on the origin
 * side mutates, so there is nothing to roll back on failure — a failed open is
 * one dead action, reported and dropped.
 */

import { t } from '@lingui/core/macro';
import { toast } from 'sonner';
// Loads the `Window.okDesktop?` global augmentation (side-effect import).
import '@/lib/desktop-bridge-types';

/**
 * The renderer-originated entry points only. The canonical union lives in the
 * main process (`note-window-registry.ts`) and also carries `'window-menu'`,
 * which is main-originated and never reaches this renderer surface. `packages/app`
 * cannot import the main-process type, so this strict subset is declared
 * separately on purpose — do not "sync" it by adding `'window-menu'`.
 */
export type RendererNoteWindowEntryPoint = 'tab-menu' | 'palette';

/**
 * Pop `docName` into its own window, or focus the window already showing it.
 * Reports failure as a toast in the invoking window; never throws at the
 * call site, so a menu handler can fire-and-forget it.
 */
export async function openDocInNoteWindow(
  docName: string,
  entryPoint: RendererNoteWindowEntryPoint,
): Promise<void> {
  const bridge = typeof window !== 'undefined' ? window.okDesktop : undefined;
  if (!bridge) return;

  try {
    const result = await bridge.noteWindow.open(docName, entryPoint);
    if (result.ok) return;
    // `no-project` means the invoking window has no project context, which a
    // user cannot act on directly — say what failed, not which internal lookup
    // missed.
    toast.error(t`Could not open this document in a new window.`);
  } catch {
    toast.error(t`Could not open this document in a new window.`);
  }
}

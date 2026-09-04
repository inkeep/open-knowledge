import { t } from '@lingui/core/macro';
import { toast } from 'sonner';
import '@/lib/desktop-bridge-types';

export type RendererNoteWindowEntryPoint = 'tab-menu' | 'palette';

export async function openDocInNoteWindow(
  docName: string,
  entryPoint: RendererNoteWindowEntryPoint,
): Promise<void> {
  const bridge = typeof window !== 'undefined' ? window.okDesktop : undefined;
  if (!bridge) return;

  try {
    const result = await bridge.noteWindow.open(docName, entryPoint);
    if (result.ok) return;
    toast.error(t`Could not open this document in a new window.`);
  } catch {
    toast.error(t`Could not open this document in a new window.`);
  }
}

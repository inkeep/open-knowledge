import type { ShortcutPlatform } from '@/lib/keyboard-shortcuts';

type DocumentUndoAction = 'undo' | 'redo';

interface UndoKeyEvent {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  defaultPrevented: boolean;
  target: EventTarget | null;
}

const EDITABLE_SELECTOR =
  'input, textarea, select, [contenteditable]:not([contenteditable="false"])';

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return target.closest(EDITABLE_SELECTOR) !== null;
}

export function documentUndoKeyAction(
  event: UndoKeyEvent,
  platform: ShortcutPlatform,
): DocumentUndoAction | null {
  if (event.defaultPrevented || event.altKey) return null;
  const mod =
    platform === 'mac' ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  if (!mod) return null;
  const key = event.key.toLowerCase();
  let action: DocumentUndoAction | null = null;
  if (key === 'z') action = event.shiftKey ? 'redo' : 'undo';
  else if (key === 'y' && !event.shiftKey && platform === 'windowsLinux') action = 'redo';
  if (action === null || isEditableTarget(event.target)) return null;
  return action;
}

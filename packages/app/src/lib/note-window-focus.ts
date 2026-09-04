import { isNoteWindow } from '@/lib/note-window-mode';

let claimed = false;

export function claimNoteWindowInitialFocus(): boolean {
  if (claimed || !isNoteWindow()) return false;
  claimed = true;
  return true;
}

export function __resetNoteWindowFocusClaimForTests(): void {
  claimed = false;
}

import '@/lib/desktop-bridge-types';

export function isNoteWindow(): boolean {
  if (typeof window === 'undefined') return false;
  return window.okDesktop?.config?.mode === 'note';
}

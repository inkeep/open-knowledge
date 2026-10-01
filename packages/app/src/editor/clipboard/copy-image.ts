import { copyImage } from '@/lib/copy-image';

let installed = false;
if (typeof window !== 'undefined' && !installed) {
  installed = true;
  document.addEventListener('copy', onDocCopy, true);
}

function onDocCopy(ev: ClipboardEvent): void {
  const target = ev.target;
  if (!(target instanceof HTMLImageElement)) return;
  if (!target.closest('.ProseMirror')) return;
  const src = target.currentSrc || target.src;
  if (!src) return;
  ev.preventDefault();
  ev.stopImmediatePropagation();
  void copyImage({ src }).then((outcome) => {
    if (outcome.desktopFailure) {
      console.warn(
        '[copy-image] desktop write declined, fell back to the browser clipboard',
        outcome.desktopFailure.reason,
        outcome.desktopFailure.detail,
      );
    }
    if (!outcome.ok) {
      console.warn('[copy-image] browser clipboard write failed', outcome.reason, outcome.detail);
    }
  });
}

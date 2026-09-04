let shiftHeldLatch = false;
let listenersAttached = false;
let attachedWindow: Window | null = null;

function onKeyDown(e: KeyboardEvent): void {
  shiftHeldLatch = e.shiftKey;
}

function onKeyUp(e: KeyboardEvent): void {
  if (e.key === 'Shift' || !e.shiftKey) {
    shiftHeldLatch = false;
  }
}

function onBlur(): void {
  shiftHeldLatch = false;
}

function ensureAttached(): void {
  if (listenersAttached) return;
  if (typeof window === 'undefined') return;
  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('keyup', onKeyUp, true);
  window.addEventListener('blur', onBlur, true);
  attachedWindow = window;
  listenersAttached = true;
}

export function __resetShiftTrackerForTests(): void {
  if (attachedWindow) {
    attachedWindow.removeEventListener('keydown', onKeyDown, true);
    attachedWindow.removeEventListener('keyup', onKeyUp, true);
    attachedWindow.removeEventListener('blur', onBlur, true);
    attachedWindow = null;
  }
  listenersAttached = false;
  shiftHeldLatch = false;
}

export function installShiftTracker(): void {
  ensureAttached();
}

export function isShiftHeld(): boolean {
  ensureAttached();
  return shiftHeldLatch;
}

export function pasteShiftHeld(event: ClipboardEvent): boolean {
  if (isShiftHeld()) return true;
  const injected = (event as unknown as { shiftKey?: boolean }).shiftKey;
  return injected === true;
}

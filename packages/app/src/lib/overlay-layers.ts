const OPEN_OVERLAY_LAYER_SELECTOR =
  '[data-state="open"][role="dialog"], ' +
  '[data-state="open"][role="alertdialog"], ' +
  '[data-state="open"][role="menu"], ' +
  '[data-state="open"][role="listbox"], ' +
  '[data-radix-popper-content-wrapper] [data-state="open"]';

function ownsKeyboard(layer: Element): boolean {
  return layer.closest('[data-ok-declines-keyboard]') === null;
}

export function isOverlayLayerOpen(): boolean {
  if (typeof document === 'undefined') return false;
  for (const layer of document.querySelectorAll(OPEN_OVERLAY_LAYER_SELECTOR)) {
    if (ownsKeyboard(layer)) return true;
  }
  return false;
}

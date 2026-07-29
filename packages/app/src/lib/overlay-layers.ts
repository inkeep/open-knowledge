/**
 * Candidate layers: dialogs, alert dialogs, menus, listboxes, and anything
 * Radix renders through a popper wrapper (popovers, dropdown and context
 * menus, selects).
 *
 * Tooltips deliberately do not match — Radix marks tooltip content
 * `data-state="delayed-open" | "instant-open"`, never `"open"`. Inline
 * disclosures (collapsibles, accordions) carry `data-state="open"` but neither
 * a matching role nor a popper wrapper, so they do not match either.
 */
const OPEN_OVERLAY_LAYER_SELECTOR =
  '[data-state="open"][role="dialog"], ' +
  '[data-state="open"][role="alertdialog"], ' +
  '[data-state="open"][role="menu"], ' +
  '[data-state="open"][role="listbox"], ' +
  '[data-radix-popper-content-wrapper] [data-state="open"]';

/**
 * Being open is not the same as owning the keyboard. A hover-triggered panel or
 * a passive suggestion list leaves the caret where it was, so the user is still
 * typing in the document underneath it and their shortcuts have to keep working
 * — treating those as owning the keys would make the keyboard a function of
 * where the mouse happens to rest.
 *
 * Any layer that leaves focus outside itself opts out with
 * `data-ok-declines-keyboard`. That is deliberately a property of the LAYER
 * rather than a reading of `document.activeElement`: live focus can sit on
 * `<body>` while a modal is wide open (a programmatic blur, or a focused node
 * being removed before Radix's focus scope heals it), and a probe that went by
 * focus alone would hand the shortcut straight back to the app in exactly the
 * case this module exists to prevent.
 */
function ownsKeyboard(layer: Element): boolean {
  return layer.closest('[data-ok-declines-keyboard]') === null;
}

/**
 * Does a layer that owns the keyboard currently sit above the app?
 *
 * App-global shortcuts (⌘T, ⌘N, ⌘L, ⌥⌘S, …) are registered on `window` and
 * fire regardless of focus, so an overlay has no way to stop them from
 * underneath — the listeners have to decline for themselves. Every app-global
 * keydown listener gates on this; focus-scoped listeners do not need it,
 * because an overlay's focus trap already makes them inert.
 *
 * Read this from a CAPTURE-phase listener on `window` whenever the key being
 * handled can itself dismiss a layer (Escape), so the open-layer DOM state is
 * observed before Radix's DismissableLayer (capture phase on `document`) flips
 * `data-state`. A bubble-phase listener can instead bail on
 * `event.defaultPrevented`, which a dismissable layer sets when it claims the
 * Escape.
 */
export function isOverlayLayerOpen(): boolean {
  if (typeof document === 'undefined') return false;
  for (const layer of document.querySelectorAll(OPEN_OVERLAY_LAYER_SELECTOR)) {
    if (ownsKeyboard(layer)) return true;
  }
  return false;
}

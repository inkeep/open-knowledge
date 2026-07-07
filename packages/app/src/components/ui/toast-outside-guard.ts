import type { Dialog as DialogPrimitive } from 'radix-ui';
import type * as React from 'react';

type InteractOutsideHandler = NonNullable<
  React.ComponentProps<typeof DialogPrimitive.Content>['onInteractOutside']
>;

/**
 * Wrap a Radix `onInteractOutside` handler so interactions landing inside the
 * sonner toaster don't dismiss the surrounding modal layer.
 *
 * Sonner renders its toaster in a portal on <body>, outside any dialog/sheet.
 * globals.css keeps toasts interactive under a modal layer
 * (`[data-sonner-toast] { pointer-events: auto }`) so their close / action
 * buttons work even while `body { pointer-events: none }` is set — but that
 * also makes a click or focus on a toast an "outside" interaction that Radix
 * would otherwise treat as a request to dismiss. Neutralize toast-targeted
 * interactions so closing a toast never closes the surface beneath it;
 * everything else falls through to the caller's handler unchanged.
 *
 * Shared by Dialog and Sheet (both Radix Dialog under the hood) — keep them
 * pointing here rather than re-inlining, so the guard can't drift.
 */
export function ignoreToastInteractOutside(
  onInteractOutside?: InteractOutsideHandler,
): InteractOutsideHandler {
  return (event) => {
    const target = event.target as HTMLElement | null;
    if (target?.closest('[data-sonner-toaster]')) {
      event.preventDefault();
      return;
    }
    onInteractOutside?.(event);
  };
}

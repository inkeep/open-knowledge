import type { Dialog as DialogPrimitive } from 'radix-ui';
import type * as React from 'react';

type InteractOutsideHandler = NonNullable<
  React.ComponentProps<typeof DialogPrimitive.Content>['onInteractOutside']
>;

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

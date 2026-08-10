import { AlertDialog as AlertDialogPrimitive } from 'radix-ui';
import type * as React from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * Confirmation dialog for decisions that must not be dismissed by accident.
 *
 * Radix's `AlertDialog` differs from `Dialog` in three ways that matter here:
 * it renders `role="alertdialog"`, it preventDefaults outside pointer/interact
 * events so a stray click on the overlay cannot dismiss the decision, and it
 * moves initial focus onto `AlertDialogCancel` rather than the first focusable
 * child. Escape still closes, which is the documented alertdialog keyboard
 * contract and reads as Cancel — the accidental-dismissal risk is the pointer,
 * not a deliberate keystroke.
 *
 * Because focus-on-open targets the cancel element, **every `AlertDialogContent`
 * must render an `AlertDialogCancel`.** Without one, Radix suppresses its default
 * auto-focus and focuses nothing, leaving focus stranded on `<body>` — strictly
 * worse than the plain Dialog it replaces.
 *
 * Hand-authored rather than installed via `shadcn add`, and the class strings
 * mirror `dialog.tsx` rather than the registry's:
 *   - The registry component omits `[-webkit-app-region:no-drag]`. Without it,
 *     pointer events over the OS titlebar drag region are swallowed by the
 *     window-drag handler, so a dialog anchored near the top of the Electron
 *     window becomes unclickable. Same reasoning as `dialog.tsx`.
 *   - The registry component omits the `motion-reduce:*` opt-outs, so it
 *     animates through `prefers-reduced-motion`.
 *   - The registry title uses a `cn-font-heading` token that does not exist in
 *     this project's theme, so it would silently fall back to the body font
 *     while every sibling dialog uses `font-heading`.
 *   - The registry has no body slot, and both consumers render a scrollable
 *     list between the header and the footer.
 * Sharing one class string across `dialog.tsx` and this file was considered and
 * rejected: shadcn primitives are vendored copies meant to be edited
 * independently, and `sheet.tsx` already carries its own near-identical copy.
 *
 * `dialog.tsx`'s `ignoreToastInteractOutside` guard has no analogue here on
 * purpose — no outside interaction dismisses an alert dialog, so a toast
 * dismissal above it is already inert.
 */
function AlertDialog({ ...props }: React.ComponentProps<typeof AlertDialogPrimitive.Root>) {
  return <AlertDialogPrimitive.Root data-slot="alert-dialog" {...props} />;
}

function AlertDialogTrigger({
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Trigger>) {
  return <AlertDialogPrimitive.Trigger data-slot="alert-dialog-trigger" {...props} />;
}

function AlertDialogPortal({ ...props }: React.ComponentProps<typeof AlertDialogPrimitive.Portal>) {
  return <AlertDialogPrimitive.Portal data-slot="alert-dialog-portal" {...props} />;
}

function AlertDialogOverlay({
  className,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Overlay>) {
  return (
    <AlertDialogPrimitive.Overlay
      data-slot="alert-dialog-overlay"
      className={cn(
        'fixed inset-0 isolate z-50 bg-black/10 duration-100 supports-backdrop-filter:backdrop-blur-xs [-webkit-app-region:no-drag] data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0 motion-reduce:data-open:animate-none motion-reduce:data-closed:animate-none motion-reduce:duration-0',
        className,
      )}
      {...props}
    />
  );
}

function AlertDialogContent({
  className,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Content>) {
  return (
    <AlertDialogPortal>
      <AlertDialogOverlay />
      <AlertDialogPrimitive.Content
        data-slot="alert-dialog-content"
        // No close affordance in the corner, by design: an alert dialog offers
        // exactly the choices in its footer. Layout otherwise matches
        // DialogContent so a migrated dialog keeps its current proportions —
        // scrolling lives in AlertDialogBody, the footer stays pinned.
        className={cn(
          'fixed top-1/2 left-1/2 z-50 flex w-full max-w-[calc(100%-2rem)] max-h-[calc(100dvh-2rem)] -translate-x-1/2 -translate-y-1/2 flex-col gap-6 overflow-hidden rounded-xl bg-popover p-6 text-sm text-popover-foreground ring-1 ring-foreground/10 duration-100 outline-none sm:max-w-sm [-webkit-app-region:no-drag] data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95 motion-reduce:data-open:animate-none motion-reduce:data-closed:animate-none motion-reduce:duration-0',
          className,
        )}
        {...props}
      />
    </AlertDialogPortal>
  );
}

function AlertDialogHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="alert-dialog-header"
      className={cn('flex shrink-0 flex-col gap-4', className)}
      {...props}
    />
  );
}

function AlertDialogBody({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="alert-dialog-body"
      className={cn(
        '-mx-6 min-h-0 flex-1 overflow-y-auto px-6 subtle-scrollbar scroll-fade-mask',
        className,
      )}
      {...props}
    />
  );
}

function AlertDialogFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="alert-dialog-footer"
      className={cn(
        '-mx-6 -mb-6 flex shrink-0 flex-col-reverse gap-2 rounded-b-xl border-t bg-muted/50 px-6 py-4 sm:flex-row sm:justify-end',
        className,
      )}
      {...props}
    />
  );
}

function AlertDialogTitle({
  className,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Title>) {
  return (
    <AlertDialogPrimitive.Title
      data-slot="alert-dialog-title"
      className={cn('font-heading text-base leading-none font-medium', className)}
      {...props}
    />
  );
}

function AlertDialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Description>) {
  return (
    <AlertDialogPrimitive.Description
      data-slot="alert-dialog-description"
      className={cn(
        'text-sm text-muted-foreground *:[a]:underline *:[a]:underline-offset-3 *:[a]:hover:text-foreground',
        className,
      )}
      {...props}
    />
  );
}

/**
 * The dismissing choice, and the element Radix focuses when the dialog opens.
 * `font-mono uppercase` matches the treatment `DialogClose` bakes in, so a
 * migrated cancel button keeps its current appearance.
 */
function AlertDialogCancel({
  className,
  variant = 'outline',
  size = 'default',
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Cancel> &
  Pick<React.ComponentProps<typeof Button>, 'variant' | 'size'>) {
  return (
    <Button variant={variant} size={size} asChild>
      <AlertDialogPrimitive.Cancel
        data-slot="alert-dialog-cancel"
        className={cn('font-mono uppercase', className)}
        {...props}
      />
    </Button>
  );
}

/**
 * The confirming choice, for actions that resolve synchronously.
 *
 * Radix builds both Action and Cancel on `Dialog.Close`, so activating either
 * one closes the dialog immediately. An action that awaits a request and shows
 * an in-flight state in its own label therefore cannot use this — the dialog
 * would unmount out from under the pending work. Those call sites keep a plain
 * `Button` with an `onClick` and let the owner close the dialog once the work
 * settles.
 */
function AlertDialogAction({
  className,
  variant = 'default',
  size = 'default',
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Action> &
  Pick<React.ComponentProps<typeof Button>, 'variant' | 'size'>) {
  return (
    <Button variant={variant} size={size} asChild>
      <AlertDialogPrimitive.Action
        data-slot="alert-dialog-action"
        className={cn(className)}
        {...props}
      />
    </Button>
  );
}

export {
  AlertDialog,
  AlertDialogAction,
  AlertDialogBody,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogOverlay,
  AlertDialogPortal,
  AlertDialogTitle,
  AlertDialogTrigger,
};

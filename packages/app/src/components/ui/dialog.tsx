import { Trans } from '@lingui/react/macro';
import { XIcon } from 'lucide-react';
import { Dialog as DialogPrimitive } from 'radix-ui';
import type * as React from 'react';
import { Button } from '@/components/ui/button';
import { ignoreToastInteractOutside } from '@/components/ui/toast-outside-guard';
import { cn } from '@/lib/utils';

function Dialog({ ...props }: React.ComponentProps<typeof DialogPrimitive.Root>) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />;
}

function DialogTrigger({ ...props }: React.ComponentProps<typeof DialogPrimitive.Trigger>) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />;
}

function DialogPortal({ ...props }: React.ComponentProps<typeof DialogPrimitive.Portal>) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />;
}

function DialogClose({ ...props }: React.ComponentProps<typeof DialogPrimitive.Close>) {
  return (
    <DialogPrimitive.Close data-slot="dialog-close" className="font-mono uppercase" {...props} />
  );
}

function DialogOverlay({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      data-slot="dialog-overlay"
      // `[-webkit-app-region:no-drag]` exempts the overlay from the OS-level
      // titlebar drag region declared on EditorHeader / FileSidebar /
      // EditorTabs. Without it, pointer events on the overlay area that
      // visually overlaps those drag strips fall through to the OS window-
      // drag handler — outside-click dismissal silently breaks for dialogs
      // anchored near the top of the window in the Electron frame. Property
      // is a no-op outside Chromium-in-Electron.
      className={cn(
        'fixed inset-0 isolate z-50 bg-black/10 duration-100 supports-backdrop-filter:backdrop-blur-xs [-webkit-app-region:no-drag] data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0 motion-reduce:data-open:animate-none motion-reduce:data-closed:animate-none motion-reduce:duration-0',
        className,
      )}
      {...props}
    />
  );
}

function DialogContent({
  className,
  children,
  showCloseButton = true,
  onInteractOutside,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & {
  showCloseButton?: boolean;
}) {
  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Content
        data-slot="dialog-content"
        // Dismissing a sonner toast must not close the dialog beneath it —
        // see ignoreToastInteractOutside. Composes with any consumer handler.
        onInteractOutside={ignoreToastInteractOutside(onInteractOutside)}
        // Default layout: `flex flex-col` for the common header + DialogBody
        // + footer composition; consumers may override via `className`
        // (cn() last-wins — SettingsDialogShell switches to a grid, CommandDialog
        // drops the padding entirely). max-h caps height to viewport (mirrors
        // the horizontal max-w-[calc(100%-2rem)] with a symmetric 2rem buffer).
        // overflow-hidden on the dialog itself; scrolling lives inside
        // DialogBody (flex-1 + min-h-0 + overflow-y-auto), so the footer
        // stays pinned and the scrollbar never crosses the footer's border-t
        // / bg-muted strip.
        //
        // `[-webkit-app-region:no-drag]` exempts the dialog from the OS-level
        // titlebar drag region declared on EditorHeader / FileSidebar /
        // EditorTabs. Without it, clicks + text selection inside dialogs
        // visually anchored near the top of the Electron window are
        // swallowed by the OS window-drag handler (the close X, header text,
        // and any header-row controls become unclickable while keyboard
        // focus + Enter still work). Property is a no-op outside
        // Chromium-in-Electron.
        className={cn(
          'fixed top-1/2 left-1/2 z-50 flex w-full max-w-[calc(100%-2rem)] max-h-[calc(100dvh-2rem)] -translate-x-1/2 -translate-y-1/2 flex-col gap-6 overflow-hidden rounded-xl bg-popover p-6 text-sm text-popover-foreground ring-1 ring-foreground/10 duration-100 outline-none sm:max-w-sm [-webkit-app-region:no-drag] data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95 motion-reduce:data-open:animate-none motion-reduce:data-closed:animate-none motion-reduce:duration-0',
          className,
        )}
        {...props}
      >
        {children}
        {showCloseButton && (
          <DialogPrimitive.Close data-slot="dialog-close" asChild>
            <Button
              variant="ghost"
              className="absolute top-2 right-2"
              size="icon-sm"
              // Don't steal focus from the active field on press. A focused
              // input blurring on mousedown can fire blur-driven validation
              // that grows the dialog; since the dialog is vertically centered,
              // growth slides this absolutely-positioned button out from under
              // the pointer before mouseup, eating the click. Activation via
              // click/Enter/Escape is unaffected.
              onMouseDown={(e) => e.preventDefault()}
            >
              <XIcon />
              <span className="sr-only">
                <Trans>Close</Trans>
              </span>
            </Button>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPortal>
  );
}

function DialogHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="dialog-header"
      className={cn('flex shrink-0 flex-col gap-4', className)}
      {...props}
    />
  );
}

function DialogBody({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="dialog-body"
      // -mx-6 + px-6 lets the scrollbar sit at the dialog edge (cleaner than
      // inset by the dialog padding). flex-1 + min-h-0 lets the body shrink
      // to fit available space inside the flex column so overflow-y-auto
      // actually triggers — without min-h-0 the row sizes to content and
      // there's nothing to scroll.
      className={cn(
        '-mx-6 min-h-0 flex-1 overflow-y-auto px-6 subtle-scrollbar scroll-fade-mask',
        className,
      )}
      {...props}
    />
  );
}

function DialogFooter({
  className,
  showCloseButton = false,
  children,
  ...props
}: React.ComponentProps<'div'> & {
  showCloseButton?: boolean;
}) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn(
        '-mx-6 -mb-6 flex shrink-0 flex-col-reverse gap-2 rounded-b-xl border-t bg-muted/50 px-6 py-4 sm:flex-row sm:justify-end',
        className,
      )}
      {...props}
    >
      {children}
      {showCloseButton && (
        <DialogPrimitive.Close asChild>
          <Button variant="outline" className="font-mono uppercase">
            <Trans>Close</Trans>
          </Button>
        </DialogPrimitive.Close>
      )}
    </div>
  );
}

function DialogTitle({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn('font-heading text-base leading-none font-medium', className)}
      {...props}
    />
  );
}

function DialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn(
        'text-sm text-muted-foreground *:[a]:underline *:[a]:underline-offset-3 *:[a]:hover:text-foreground',
        className,
      )}
      {...props}
    />
  );
}

export {
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
};

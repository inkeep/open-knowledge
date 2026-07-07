/**
 * shadcn/ui Command primitive — thin styled wrapper around `cmdk` plus a
 * `<CommandDialog>` helper that composes Command with our shadcn Dialog.
 *
 * Based on the canonical shadcn/ui template:
 *   https://ui.shadcn.com/docs/components/command
 *
 * Vendored locally so we stay on our own design tokens + don't depend on the
 * shadcn CLI's overwrite behavior. Tracks cmdk@^1.1.x.
 */

import { Command as CommandPrimitive } from 'cmdk';
import { SearchIcon } from 'lucide-react';
import type { ComponentProps } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';

function Command({ className, ...props }: ComponentProps<typeof CommandPrimitive>) {
  return (
    <CommandPrimitive
      data-slot="command"
      className={cn(
        'flex h-full w-full flex-col overflow-hidden rounded-md bg-popover text-popover-foreground',
        className,
      )}
      {...props}
    />
  );
}

interface CommandDialogProps extends ComponentProps<typeof Dialog> {
  title?: string;
  description?: string;
  className?: string;
  showCloseButton?: boolean;
  commandProps?: ComponentProps<typeof CommandPrimitive>;
  // Forwarded to the underlying Radix DialogContent so a consumer can intercept
  // Escape — e.g. exit an in-palette sub-mode first, then close on a second press.
  onEscapeKeyDown?: ComponentProps<typeof DialogContent>['onEscapeKeyDown'];
}

function CommandDialog({
  title = 'Command Palette',
  description = 'Search for a command to run',
  children,
  className,
  showCloseButton = true,
  commandProps,
  onEscapeKeyDown,
  ...props
}: CommandDialogProps) {
  // Destructure className off commandProps before spreading — otherwise
  // {...commandProps} re-emits className and the spread (last-wins) drops
  // the merged base classes, collapsing dialog-level layout.
  const { className: commandClassName, ...restCommandProps } = commandProps ?? {};
  return (
    <Dialog {...props}>
      <DialogContent
        // top-[12vh] translate-y-0 overrides DialogContent's centered base
        // anchor via cn() last-wins, so the palette sits near the upper-left
        // search trigger. Upstream CommandDialog uses top-1/3; OK is tighter.
        className={cn('top-[12vh] translate-y-0 overflow-hidden p-0', className)}
        showCloseButton={showCloseButton}
        onEscapeKeyDown={onEscapeKeyDown}
      >
        {/* Inside DialogContent so Radix wires aria within its portal (cf. SettingsDialogShell) */}
        <DialogTitle className="sr-only">{title}</DialogTitle>
        <DialogDescription className="sr-only">{description}</DialogDescription>
        <Command
          className={cn(
            '[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-group]]:px-2 [&_[cmdk-group]:not([hidden])_~[cmdk-group]]:pt-0 [&_[cmdk-input-wrapper]_svg]:h-5 [&_[cmdk-input-wrapper]_svg]:w-5 [&_[cmdk-input]]:h-12 [&_[cmdk-item]]:px-2 [&_[cmdk-item]]:py-3 [&_[cmdk-item]_svg]:h-5 [&_[cmdk-item]_svg]:w-5',
            commandClassName,
          )}
          {...restCommandProps}
        >
          {children}
        </Command>
      </DialogContent>
    </Dialog>
  );
}

function CommandInput({ className, ...props }: ComponentProps<typeof CommandPrimitive.Input>) {
  return (
    <div data-slot="command-input-wrapper" className="flex items-center gap-2 border-b px-3">
      <SearchIcon className="size-4 shrink-0 opacity-50" />
      <CommandPrimitive.Input
        data-slot="command-input"
        className={cn(
          'flex w-full rounded-md bg-transparent py-3 text-sm outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50',
          className,
        )}
        {...props}
      />
    </div>
  );
}

function CommandList({ className, ...props }: ComponentProps<typeof CommandPrimitive.List>) {
  return (
    <CommandPrimitive.List
      data-slot="command-list"
      className={cn('max-h-[300px] scroll-py-1 overflow-y-auto overflow-x-hidden', className)}
      {...props}
    />
  );
}

function CommandEmpty(props: ComponentProps<typeof CommandPrimitive.Empty>) {
  return (
    <CommandPrimitive.Empty
      data-slot="command-empty"
      className="py-6 text-center text-sm"
      {...props}
    />
  );
}

function CommandGroup({ className, ...props }: ComponentProps<typeof CommandPrimitive.Group>) {
  return (
    <CommandPrimitive.Group
      data-slot="command-group"
      className={cn(
        'overflow-hidden p-1 text-foreground [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-mono [&_[cmdk-group-heading]]:uppercase **:[[cmdk-group-heading]]:tracking-wider',
        className,
      )}
      {...props}
    />
  );
}

function CommandSeparator({
  className,
  ...props
}: ComponentProps<typeof CommandPrimitive.Separator>) {
  return (
    <CommandPrimitive.Separator
      data-slot="command-separator"
      className={cn('-mx-1 h-px bg-border', className)}
      {...props}
    />
  );
}

function CommandItem({ className, ...props }: ComponentProps<typeof CommandPrimitive.Item>) {
  return (
    <CommandPrimitive.Item
      data-slot="command-item"
      className={cn(
        "relative flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none data-disabled:pointer-events-none data-disabled:opacity-50 data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 [&_svg:not([class*='text-'])]:text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}

function CommandShortcut({ className, ...props }: ComponentProps<'span'>) {
  return (
    <span
      data-slot="command-shortcut"
      className={cn('ml-auto text-muted-foreground text-xs tracking-widest', className)}
      {...props}
    />
  );
}

export {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
};

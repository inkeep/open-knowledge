import type * as React from 'react';
import { cn } from '@/lib/utils';

function Panel({ className, ...props }: React.ComponentProps<'section'>) {
  return (
    <section
      data-slot="panel"
      className={cn('flex h-full min-h-0 flex-col', className)}
      {...props}
    />
  );
}

function PanelHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="panel-header"
      className={cn('shrink-0 flex min-h-12 items-center justify-between px-4 py-3', className)}
      {...props}
    />
  );
}

function PanelTitle({ className, ...props }: React.ComponentProps<'h2'>) {
  return (
    <h2
      data-slot="panel-title"
      className={cn(
        'text-sm font-medium uppercase font-mono tracking-wider text-muted-foreground',
        className,
      )}
      {...props}
    />
  );
}

function PanelCount({ className, ...props }: React.ComponentProps<'p'>) {
  return (
    <p
      data-slot="panel-count"
      className={cn(
        'text-xs text-muted-foreground font-mono bg-muted-foreground/5 rounded-md px-2 py-1',
        className,
      )}
      {...props}
    />
  );
}

function PanelBody({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="panel-body"
      className={cn(
        'subtle-scrollbar scroll-fade-mask min-h-0 flex-1 overflow-y-auto px-4 py-3',
        className,
      )}
      {...props}
    />
  );
}

function PanelFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="panel-footer"
      className={cn(
        'shrink-0 flex flex-wrap items-center justify-end gap-2 px-4 pt-2 pb-3',
        className,
      )}
      {...props}
    />
  );
}

function PanelEmpty({ className, ...props }: React.ComponentProps<'p'>) {
  return (
    <p
      data-slot="panel-empty"
      className={cn('text-sm text-muted-foreground/60', className)}
      {...props}
    />
  );
}

function PanelError({ className, ...props }: React.ComponentProps<'p'>) {
  return (
    <p data-slot="panel-error" className={cn('text-sm text-destructive', className)} {...props} />
  );
}

export {
  Panel,
  PanelBody,
  PanelCount,
  PanelEmpty,
  PanelError,
  PanelFooter,
  PanelHeader,
  PanelTitle,
};

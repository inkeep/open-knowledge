import { Trans, useLingui } from '@lingui/react/macro';
import { ChevronRightIcon, MoreHorizontalIcon } from 'lucide-react';
import { Slot } from 'radix-ui';
import type * as React from 'react';
import { cn } from '@/lib/utils';

function Breadcrumb({ className, ...props }: React.ComponentProps<'nav'>) {
  const { t } = useLingui();
  return (
    <nav aria-label={t`breadcrumb`} data-slot="breadcrumb" className={cn(className)} {...props} />
  );
}

function BreadcrumbList({ className, ...props }: React.ComponentProps<'ol'>) {
  return (
    <ol
      data-slot="breadcrumb-list"
      className={cn(
        'flex flex-wrap items-center gap-1.5 text-sm wrap-break-word text-muted-foreground',
        className,
      )}
      {...props}
    />
  );
}

function BreadcrumbItem({ className, ...props }: React.ComponentProps<'li'>) {
  return (
    <li
      data-slot="breadcrumb-item"
      className={cn('inline-flex items-center gap-1', className)}
      {...props}
    />
  );
}

function BreadcrumbLink({
  asChild,
  className,
  ...props
}: React.ComponentProps<'a'> & {
  asChild?: boolean;
}) {
  const Comp = asChild ? Slot.Root : 'a';

  return (
    <Comp
      data-slot="breadcrumb-link"
      className={cn('transition-colors hover:text-foreground', className)}
      {...props}
    />
  );
}

function BreadcrumbPage({
  current = true,
  className,
  ...props
}: React.ComponentProps<'span'> & { current?: boolean }) {
  // Plain <span> follows the W3C APG breadcrumb pattern — no role="link"
  // because there's no href and the element is not focusable / activatable.
  // Departs from shadcn's upstream default (which carries role="link" +
  // aria-disabled) to satisfy the biome a11y rule that flags a link
  // without focusability.
  //
  // `current` defaults to true so default usage matches the W3C APG
  // pattern (one current-page element per breadcrumb). Callers that
  // render non-current segments — e.g. folder-path hierarchies where the
  // current page isn't displayed — should pass `current={false}` so
  // assistive tech doesn't announce every hierarchy step as "current page".
  return (
    <span
      data-slot="breadcrumb-page"
      aria-current={current ? 'page' : undefined}
      className={cn('font-normal text-foreground', className)}
      {...props}
    />
  );
}

function BreadcrumbSeparator({ children, className, ...props }: React.ComponentProps<'li'>) {
  return (
    <li
      data-slot="breadcrumb-separator"
      role="presentation"
      aria-hidden="true"
      className={cn('[&>svg]:size-3.5', className)}
      {...props}
    >
      {children ?? <ChevronRightIcon />}
    </li>
  );
}

function BreadcrumbEllipsis({ className, ...props }: React.ComponentProps<'span'>) {
  return (
    <span
      data-slot="breadcrumb-ellipsis"
      role="presentation"
      aria-hidden="true"
      className={cn('flex size-5 items-center justify-center [&>svg]:size-4', className)}
      {...props}
    >
      <MoreHorizontalIcon />
      <span className="sr-only">
        <Trans>More</Trans>
      </span>
    </span>
  );
}

export {
  Breadcrumb,
  BreadcrumbEllipsis,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
};

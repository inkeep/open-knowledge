import { plural } from '@lingui/core/macro';
import { useLingui } from '@lingui/react/macro';
import { ChevronRight } from 'lucide-react';
import { type ReactNode, type Ref, useState } from 'react';
import { Badge, NOTIFICATION_BADGE_MAX } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

export function PropertyDisclosure({
  title,
  count,
  problemCount,
  problemMessages,
  className,
  contentClassName,
  testId,
  open: openProp,
  onOpenChange,
  children,
  ref,
}: {
  title: ReactNode;
  count?: number;
  problemCount?: number;
  problemMessages?: readonly string[];
  className?: string;
  contentClassName?: string;
  testId?: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  children: ReactNode;
  ref?: Ref<HTMLDivElement>;
}) {
  const { t } = useLingui();
  const [internalCollapsed, setInternalCollapsed] = useState(false);
  const open = openProp ?? !internalCollapsed;
  const setOpen = (next: boolean) => {
    if (onOpenChange) onOpenChange(next);
    else setInternalCollapsed(!next);
  };
  return (
    <div
      ref={ref}
      className={cn('property-panel editor-content-aligned text-sm', className)}
      data-testid={testId}
    >
      <Collapsible open={open} onOpenChange={setOpen}>
        {}
        <div className={cn('flex w-fit items-center gap-1.5', open && 'mb-1.5')}>
          <CollapsibleTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              className="flex h-auto w-fit items-center gap-1 bg-transparent! tracking-wider px-1 py-0.5 text-sm uppercase font-mono font-medium text-muted-foreground hover:bg-transparent hover:text-foreground space-x-1.5"
            >
              <ChevronRight
                data-expanded={open}
                className="size-3.5 shrink-0 text-muted-foreground transition-transform duration-150 ease-out data-[expanded=true]:rotate-90"
              />
              <span>{title}</span>
              {typeof count === 'number' && count > 0 ? (
                <Badge variant="gray" className="tabular-nums normal-case">
                  {count}
                </Badge>
              ) : null}
            </Button>
          </CollapsibleTrigger>
          {typeof problemCount === 'number' && problemCount > 0 ? (
            <Tooltip>
              {}
              <TooltipTrigger
                data-testid="property-problem-badge-trigger"
                aria-label={t`${plural(problemCount, {
                  one: '# property does not match the schema',
                  other: '# properties do not match the schema',
                })}`}
                className="rounded-4xl focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
              >
                <Badge
                  variant="notification"
                  data-testid="property-problem-badge"
                  aria-hidden="true"
                  className="tabular-nums normal-case"
                >
                  {problemCount > NOTIFICATION_BADGE_MAX
                    ? `${NOTIFICATION_BADGE_MAX}+`
                    : problemCount}
                </Badge>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                <span className="flex flex-col gap-0.5">
                  {}
                  {problemMessages?.map((message, index) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: static within a render
                    <span key={index}>{message}</span>
                  ))}
                </span>
              </TooltipContent>
            </Tooltip>
          ) : null}
        </div>
        <CollapsibleContent
          className={cn(
            'overflow-hidden data-[state=open]:animate-[collapsible-down_150ms_ease-out] data-[state=closed]:animate-[collapsible-up_150ms_ease-in]',
            contentClassName,
          )}
        >
          {children}
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}

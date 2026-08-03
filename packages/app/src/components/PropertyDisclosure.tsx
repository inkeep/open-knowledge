import { plural } from '@lingui/core/macro';
import { useLingui } from '@lingui/react/macro';
import { ChevronRight } from 'lucide-react';
import { type ReactNode, type Ref, useState } from 'react';
import { Badge, NOTIFICATION_BADGE_MAX } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

/**
 * The collapsible "Properties"-style section shared by the document property
 * panel (`PropertyPanel`) and the skill editor (`SkillProperties`): one
 * disclosure header (chevron + title) inside a content-column-aligned
 * `property-panel` container. Presentational only — owns just the open/closed
 * state. Extracted so the two surfaces share one header instead of copies that
 * drift apart on a restyle.
 */
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
  /** Optional item count shown as a badge next to the title. Rendered only when
   *  a positive number — 0 and undefined show nothing. */
  count?: number;
  /**
   * Properties that are present but violate the document's schema, shown as a
   * second badge beside the count. Deliberately separate from `count` rather
   * than recoloring it: the two answer different questions ("how many
   * properties" vs "how many are wrong"), and a single recolored number would
   * state the first while implying the second.
   */
  problemCount?: number;
  /** The violation messages, listed in the badge's tooltip. */
  problemMessages?: readonly string[];
  /** Extra container classes (e.g. vertical padding) merged after the base. */
  className?: string;
  /** Extra classes on the collapsible content box. The editable document panel
   *  pulls it left (negative margin) so its drag-handle gutter overhangs into
   *  the page margin and the type-icon column lands flush at the content edge.
   *  Must sit on this box, not an inner wrapper — the box's own `overflow-hidden`
   *  (collapse animation) would otherwise clip the overhanging handle. */
  contentClassName?: string;
  /** Forwarded to the container as `data-testid`. */
  testId?: string;
  /** Controlled open state. Omit for self-managed (uncontrolled) disclosure. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  children: ReactNode;
  /** Forwarded to the container element — e.g. so a selection-publishing hook
   *  can observe text selection within the panel. React 19 ref-as-prop. */
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
        {/* The problem badge is a SIBLING of the trigger, not a child of it.
            Nested inside the button its tooltip would be mouse-only — HTML
            forbids interactive content inside `button`, so the badge can never
            take focus and Radix's focus-open never fires. The open-state margin
            moves here with it so both stay on one baseline. */}
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
              {/* No `asChild`: the trigger renders its own focusable button, so
                  the messages are reachable by keyboard as well as pointer. */}
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
                  {/* Index key, not the message: two distinct schema files can
                      both constrain the same property and emit identical strings. */}
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

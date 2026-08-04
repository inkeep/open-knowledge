import { plural } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import { ListPlus } from 'lucide-react';
import { Badge, NOTIFICATION_BADGE_MAX } from '@/components/ui/badge';
import { Button } from '@/components/ui/button.tsx';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

/**
 * Toolbar "Add properties" affordance. PropertyPanel only mounts in WYSIWYG mode
 * (gated in EditorActivityPool), so callers hide this in source mode — clicking
 * it there would fire a CustomEvent with no listener (an unresponsive-UI no-op).
 * Source-mode users edit frontmatter directly in the CodeMirror YAML.
 *
 * Doubles as the report surface for the frontmatter properties a schema
 * requires and the document does NOT have. Those have nothing to mark: no body
 * anchor (a doc missing its frontmatter entirely has only body text, which is
 * not itself wrong) and no property row either, since the property is precisely
 * what is absent — and when the doc has no properties at all `PropertyPanel`
 * renders nothing. Adding a property is the fix, so this is where they belong.
 *
 * Properties that are PRESENT but wrong report on the property panel's own
 * count instead; they have a row, and adding is not their fix. The badge is a
 * pointer, not the explanation: the count and messages land in the tooltip, and
 * the Problems panel carries the full detail.
 */
export function AddPropertiesButton({
  onAddProperty,
  className,
  problemCount = 0,
  problemMessages,
}: {
  onAddProperty: () => void;
  className?: string;
  /** Schema-required properties the active doc is missing. 0 renders no badge. */
  problemCount?: number;
  /** The missing-property messages, listed in the tooltip under the summary. */
  problemMessages?: readonly string[];
}) {
  const { t } = useLingui();
  const hasProblems = problemCount > 0;
  // The accessible name carries the count too — the badge is a visual channel
  // only, and a screen-reader user gets no signal from it otherwise.
  const label = hasProblems
    ? t`Add properties (${plural(problemCount, {
        one: '# required property missing',
        other: '# required properties missing',
      })})`
    : t`Add properties`;
  return (
    <Tooltip>
      <Button
        variant="ghost"
        size="icon"
        aria-label={label}
        onClick={onAddProperty}
        data-testid="add-properties-button"
        className={cn('relative', className)}
        asChild
      >
        <TooltipTrigger>
          <ListPlus />
          {hasProblems ? (
            <Badge
              variant="notification"
              // Presentational: the count is already in the button's aria-label,
              // so announcing it again would double up on every focus.
              aria-hidden="true"
              data-testid="add-properties-problem-badge"
              className="pointer-events-none absolute -top-0.5 -right-0.5 size-3.5 rounded-full p-0 font-sans text-[9px] leading-none tabular-nums"
            >
              {problemCount > NOTIFICATION_BADGE_MAX ? `${NOTIFICATION_BADGE_MAX}+` : problemCount}
            </Badge>
          ) : null}
        </TooltipTrigger>
      </Button>
      <TooltipContent side="bottom">
        {hasProblems ? (
          <span className="flex flex-col gap-0.5">
            <span className="font-medium">
              <Trans>This document is missing required properties</Trans>
            </span>
            {/* Index key, not the message: two distinct schema files can both
                require the same property and emit byte-identical strings. */}
            {problemMessages?.map((message, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: static within a render
              <span key={index} className="opacity-90">
                {message}
              </span>
            ))}
            {/* The badge says something is wrong; without this the button reads
                as a report rather than the thing that acts on it. "Fill them
                in" is load-bearing — clicking stages the rows, it does not
                write the properties. */}
            <span className="pt-0.5 opacity-70">
              <Trans>Click to add and fill them in</Trans>
            </span>
          </span>
        ) : (
          <Trans>Add properties</Trans>
        )}
      </TooltipContent>
    </Tooltip>
  );
}

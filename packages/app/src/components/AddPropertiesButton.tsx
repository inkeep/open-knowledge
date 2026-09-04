// biome-ignore-all lint/plugin/no-physical-direction-utility: pre-rule backlog — physical margin/padding/inset utilities predate the rule; drain by swapping ml/mr → ms/me, pl/pr → ps/pe, left/right → start/end, then deleting this line. See https://github.com/inkeep/open-knowledge/blob/main/biome-plugins/README.md#no-physical-direction-utilitygrit

import { plural } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import { ListPlus } from 'lucide-react';
import { Badge, NOTIFICATION_BADGE_MAX } from '@/components/ui/badge';
import { Button } from '@/components/ui/button.tsx';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

export function AddPropertiesButton({
  onAddProperty,
  className,
  problemCount = 0,
  problemMessages,
}: {
  onAddProperty: () => void;
  className?: string;
  problemCount?: number;
  problemMessages?: readonly string[];
}) {
  const { t } = useLingui();
  const hasProblems = problemCount > 0;
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
            {}
            {problemMessages?.map((message, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: static within a render
              <span key={index} className="opacity-90">
                {message}
              </span>
            ))}
            {}
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

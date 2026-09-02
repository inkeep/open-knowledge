import { useLingui } from '@lingui/react/macro';
import { ChevronLeftIcon, ChevronUpIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import type { SessionPanelEdge } from './TerminalTabStrip';

interface TerminalRevealTabProps {
  readonly edge: SessionPanelEdge;
  readonly onReveal: () => void;
  readonly className?: string;
}

export function TerminalRevealTab({ edge, onReveal, className }: TerminalRevealTabProps) {
  const { t } = useLingui();
  const rightEdge = edge === 'right';
  const label = rightEdge ? t`Open agents panel` : t`Open terminal`;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="icon-sm"
          aria-label={label}
          data-terminal-reveal={edge}
          onClick={onReveal}
          className={cn(
            'absolute z-20 shrink-0 bg-background text-muted-foreground shadow-sm hover:text-foreground',
            rightEdge ? 'rounded-r-none border-r-0' : 'rounded-b-none border-b-0',
            className,
          )}
        >
          {rightEdge ? (
            <ChevronLeftIcon aria-hidden="true" />
          ) : (
            <ChevronUpIcon aria-hidden="true" />
          )}
        </Button>
      </TooltipTrigger>
      <TooltipContent side={rightEdge ? 'left' : 'top'} sideOffset={8}>
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

import { plural } from '@lingui/core/macro';
import { useLingui } from '@lingui/react/macro';
import { ChevronLeftIcon, ChevronUpIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useOpenAgentThreadTabs } from '@/lib/acp/thread-client';
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
  const openThreadTabs = useOpenAgentThreadTabs();
  const liveThreadCount = openThreadTabs.filter((info) => info.archived !== true).length;
  const label = rightEdge
    ? liveThreadCount > 0
      ? t`Open agents panel — ${plural(liveThreadCount, {
          one: '# live agent thread',
          other: '# live agent threads',
        })}`
      : t`Open agents panel`
    : t`Open terminal`;
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
          {rightEdge && liveThreadCount > 0 ? (
            <span
              aria-hidden="true"
              data-testid="agents-reveal-live-dot"
              className="absolute top-1 end-1 size-1.5 rounded-full bg-emerald-600 ring-1 ring-background"
            />
          ) : null}
        </Button>
      </TooltipTrigger>
      <TooltipContent side={rightEdge ? 'left' : 'top'} sideOffset={8}>
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

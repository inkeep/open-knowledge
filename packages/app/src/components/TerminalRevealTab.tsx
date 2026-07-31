import { useLingui } from '@lingui/react/macro';
import { ChevronLeftIcon, ChevronUpIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import type { SessionPanelEdge } from './TerminalTabStrip';

interface TerminalRevealTabProps {
  /** Which edge the hidden panel lives on — decides the chevron direction, the
   *  edge the tab is flush against, and the tooltip side so it sits right where
   *  the collapse control was. */
  readonly edge: SessionPanelEdge;
  /** Reveal the panel (and launch the preferred session if none is open). */
  readonly onReveal: () => void;
  /** Absolute-placement offsets from the call site (which edge/corner it pins to).
   *  The caller owns placement because the two panels attach to different
   *  containers — the right column edge vs. the bottom of the editor column. */
  readonly className?: string;
}

/**
 * Persistent "reopen this panel" affordance shown only while a session panel is
 * hidden. The header chat toggle is one icon among many and reads ambiguously;
 * this tab hugs the same edge the panel lives on so a user who collapsed or
 * closed it has an obvious, in-place way to bring it back — right where the
 * collapse control was.
 *
 * The chevron is the inverse of the tab strip's collapse control (which points
 * the way the panel slides shut): the right-edge agents panel reveals with a
 * left-pointing chevron, a bottom-edge panel with an up-pointing one. The caller
 * passes the offset `className` because placement follows the panel's own
 * container, not this component's.
 *
 * The AGENTS PANEL is the only consumer: the terminal is a ⌘J surface with no
 * edge tab. `edge` stays parameterized (and both directions stay tested) because
 * the geometry is the component's whole job — hardcoding `right` would bury a
 * layout decision that belongs to the caller.
 */
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
            // Flush to the edge: drop the border + rounding on the side that meets
            // the window so the tab reads as attached to that edge.
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

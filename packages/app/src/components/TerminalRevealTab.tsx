import { useLingui } from '@lingui/react/macro';
import { ChevronLeftIcon, ChevronUpIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { TerminalDockPosition } from '@/lib/terminal-dock-store';
import { cn } from '@/lib/utils';

interface TerminalRevealTabProps {
  /** Where the terminal was docked — decides the chevron direction, the edge the
   *  tab is flush against, and the tooltip side so it sits right where the
   *  collapse control was. */
  readonly dockPosition: TerminalDockPosition;
  /** Reveal the terminal (and spawn a default-CLI session if none is open). */
  readonly onReveal: () => void;
  /** Absolute-placement offsets from the call site (which edge/corner it pins to).
   *  The caller owns placement because the two dock positions attach to different
   *  containers — the right column edge vs. the bottom of the editor column. */
  readonly className?: string;
}

/**
 * Persistent "Show terminal" affordance shown only while the terminal is hidden.
 * The header chat toggle is one icon among many and reads ambiguously; this tab
 * hugs the same edge the terminal lives on so a user who collapsed or closed the
 * terminal has an obvious, in-place way to bring it back — right where the
 * collapse control was.
 *
 * The chevron is the inverse of the tab strip's collapse control (which points
 * the way the panel slides shut): a right-docked terminal reveals with a
 * left-pointing chevron on the right edge, a bottom-docked one with an up-pointing
 * chevron on the bottom edge. Placement differs by dock — the right-dock tab pins
 * to the far-right column edge (EditorArea), the bottom-dock tab to the bottom of
 * the editor column (TerminalDock), since that is where each terminal actually
 * lives — so the caller passes the offset `className`.
 */
export function TerminalRevealTab({ dockPosition, onReveal, className }: TerminalRevealTabProps) {
  const { t } = useLingui();
  const rightDocked = dockPosition === 'right';
  const label = t`Show terminal`;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="icon-sm"
          aria-label={label}
          data-terminal-reveal={dockPosition}
          onClick={onReveal}
          className={cn(
            'absolute z-20 shrink-0 bg-background text-muted-foreground shadow-sm hover:text-foreground',
            // Flush to the edge: drop the border + rounding on the side that meets
            // the window so the tab reads as attached to that edge.
            rightDocked ? 'rounded-r-none border-r-0' : 'rounded-b-none border-b-0',
            className,
          )}
        >
          {rightDocked ? (
            <ChevronLeftIcon aria-hidden="true" />
          ) : (
            <ChevronUpIcon aria-hidden="true" />
          )}
        </Button>
      </TooltipTrigger>
      <TooltipContent side={rightDocked ? 'left' : 'top'} sideOffset={8}>
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

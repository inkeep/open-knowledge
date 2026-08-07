/**
 * "Comment" button for the WYSIWYG selection toolbar (bubble menu).
 *
 * Named for what the composer files, not for who reads it. The comment lands in
 * the project-wide queue; handing the batch to an agent is a separate, deliberate
 * step taken from the Comments tab, so the toolbar entry does not promise it.
 *
 * The sparkle stays: an agent IS the eventual reader, and it is what tells this
 * entry apart from the formatting marks it sits beside.
 *
 * Clicking emits the start-comment intent; `CommentSelectionAffordance` opens
 * the composer on the current selection.
 */

import { Trans, useLingui } from '@lingui/react/macro';
import { Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Kbd } from '@/components/ui/kbd';
import { Separator } from '@/components/ui/separator';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { formatShortcut, formatShortcutLabel } from '@/lib/keyboard-shortcuts';
import { emitStartComment } from './store';

export function CommentBubbleButton() {
  const { t } = useLingui();
  return (
    <>
      <Separator orientation="vertical" className="mx-0.5 h-5 data-vertical:self-center" />
      {/* The chord rides a tooltip, the same `Tooltip` + `Kbd` pairing every
          other entry in this bar uses (see ViewInSourceBubbleButton) — a second
          treatment inline beside the label would make one toolbar speak two
          ways, and `Kbd` inverts to a legible pill on the dark tooltip that a
          10px inline glyph never was. */}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            data-testid="comment-bubble-button"
            className="gap-1 px-2 text-sm font-medium text-accent-foreground/80"
            onClick={() => emitStartComment()}
          >
            <Sparkles className="size-3.5" aria-hidden="true" />
            <span>
              <Trans>Comment</Trans>
            </span>
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={8}>
          <span>{t`Comment on this selection`}</span>
          <Kbd aria-label={formatShortcutLabel('add-comment')}>{formatShortcut('add-comment')}</Kbd>
        </TooltipContent>
      </Tooltip>
    </>
  );
}

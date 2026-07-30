/**
 * "Ask AI" button for the WYSIWYG selection toolbar (bubble menu).
 *
 * Named for what the composer it opens can do, not for the storage that backs
 * it. That composer offers both filing the note for a later batch and handing it
 * to an agent now — labelling the entry "Comment" advertised only the first, so
 * reaching for an agent on a passage looked unsupported from the one toolbar
 * where you would look for it.
 *
 * Clicking emits the start-comment intent; `CommentSelectionAffordance` opens
 * the composer on the current selection.
 */

import { Trans } from '@lingui/react/macro';
import { Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { emitStartComment } from './store';

export function CommentBubbleButton() {
  return (
    <>
      <Separator orientation="vertical" className="mx-0.5 h-5 data-vertical:self-center" />
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
          <Trans>Ask AI</Trans>
        </span>
      </Button>
    </>
  );
}

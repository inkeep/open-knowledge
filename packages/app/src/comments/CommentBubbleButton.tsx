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
      {}
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

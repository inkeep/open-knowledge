import { Trans, useLingui } from '@lingui/react/macro';
import { MessageSquarePlus } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Textarea } from '@/components/ui/textarea';
import { useCommentedDocName } from './CommentedDocContext';
import { propertyAddress } from './comment-chips';
import { capturePropertyValueSelection } from './property-value-selection';
import { createPropertyThread } from './store';

export function PropertyCommentButton({
  propertyKey,
  propertyPath = [],
}: {
  propertyKey: string;
  propertyPath?: readonly (string | number)[];
}) {
  const { t } = useLingui();
  const docName = useCommentedDocName();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [quote, setQuote] = useState<string | null>(null);

  const address = propertyAddress(propertyKey, propertyPath);

  function post() {
    const body = draft.trim();
    if (body.length === 0 || docName === null) return;
    createPropertyThread({
      docName,
      propertyKey,
      propertyPath: [...propertyPath],
      quote: quote ?? undefined,
      body,
    });
    setDraft('');
    setOpen(false);
  }

  if (docName === null) return null;

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setDraft('');
          setQuote(null);
        }
      }}
    >
      <PopoverTrigger asChild>
        <Button
          type="button"
          data-testid="property-comment-button"
          data-key={address}
          aria-label={t`Comment on ${address}`}
          onPointerDown={(event) => setQuote(capturePropertyValueSelection(event.currentTarget))}
          variant="ghost"
          size="icon-sm"
          className="flex shrink-0 items-center justify-center rounded text-muted-foreground/0 hover:bg-muted hover:text-foreground focus-visible:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-hover:text-muted-foreground"
        >
          <MessageSquarePlus className="size-3.5" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="flex w-80 flex-col gap-2 p-3">
        {}
        {quote === null ? (
          <p className="truncate text-[11px] text-muted-foreground">
            <Trans>
              On <span className="font-mono">{address}</span>
            </Trans>
          </p>
        ) : (
          <div className="flex flex-col gap-1">
            <p className="truncate text-[11px] text-muted-foreground">
              <Trans>
                On selected text in <span className="font-mono">{address}</span>
              </Trans>
            </p>
            <p
              className="line-clamp-2 rounded border-l-2 border-muted-foreground/40 bg-muted/40 px-2 py-1 font-mono text-[11px] text-muted-foreground"
              data-testid="property-comment-quote"
            >
              {quote}
            </p>
          </div>
        )}
        <Textarea
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              setOpen(false);
              return;
            }
            if (e.key !== 'Enter' || e.shiftKey) return;
            if (e.nativeEvent.isComposing) return;
            e.preventDefault();
            post();
          }}
          placeholder={t`Add a comment`}
          className="min-h-16 resize-none text-sm"
        />
        <div className="flex items-center justify-end gap-1.5">
          <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
            <Trans>Cancel</Trans>
          </Button>
          <Button size="sm" onClick={post} disabled={draft.trim().length === 0}>
            <Trans>Add Comment</Trans>
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/**
 * Comment on a frontmatter property.
 *
 * The passage flow captures a selection and floats a composer beside it. A
 * property has no selection to capture — the row IS the target — so this is the
 * same composer hung off the row's own control instead, in a popover that
 * anchors itself.
 *
 * It lives in `comments/` rather than beside the row it renders in:
 * `FrontmatterRow` is shared by documents, templates, skills, and folder cards,
 * and only a document has comment threads. Passing this in as a slot keeps the
 * row from importing a subsystem three of its four callers cannot use.
 */

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
  /** The TOP-LEVEL frontmatter key. Steps below it go in `propertyPath`. */
  propertyKey: string;
  /** Steps into the value — `['name']` for a nested field, `[2]` for a list item. */
  propertyPath?: readonly (string | number)[];
}) {
  const { t } = useLingui();
  // From context rather than a prop: the nested object and array rows that host
  // this button are recursive widgets several layers below the panel, and none
  // of them otherwise know or care which document they belong to.
  const docName = useCommentedDocName();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  // What was highlighted in the value when the button was pressed. Held in state
  // rather than re-read at post time: by then the popover's own textarea owns
  // the selection, and the value's is long gone.
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

  // Templates, skills, and folder cards render the same rows with no document
  // behind them. No thread can exist there, so offer no way to start one.
  if (docName === null) return null;

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        // Closing discards the draft. A comment half-written against a row you
        // have navigated away from is worse than gone: it would reappear on
        // whatever row the button next rendered for.
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
          // Pointer-down, not click: the click blurs the value field, and after
          // that nothing distinguishes "the user highlighted this" from "focus
          // moved on".
          onPointerDown={(event) => setQuote(capturePropertyValueSelection(event.currentTarget))}
          variant="ghost"
          size="icon-sm"
          // Same reveal-on-hover treatment as the row's remove control, so the
          // two read as one set rather than one permanent and one appearing.
          className="flex shrink-0 items-center justify-center rounded text-muted-foreground/0 hover:bg-muted hover:text-foreground focus-visible:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-hover:text-muted-foreground"
        >
          <MessageSquarePlus className="size-3.5" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="flex w-80 flex-col gap-2 p-3">
        {/* Say WHICH of the two this is before the reviewer types. The same
            button does both, so the header is the only thing that distinguishes
            a note about the whole field from one about the sentence they
            highlighted. */}
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
            // Mid-composition Enter is the IME confirming a candidate, not the
            // reviewer submitting — the same guard the passage composer uses.
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

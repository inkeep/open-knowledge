// biome-ignore-all lint/plugin/no-physical-direction-utility: pre-rule backlog — physical margin/padding/inset utilities predate the rule; drain by swapping ml/mr → ms/me, pl/pr → ps/pe, left/right → start/end, then deleting this line. See https://github.com/inkeep/open-knowledge/blob/main/biome-plugins/README.md#no-physical-direction-utilitygrit

import { Trans, useLingui } from '@lingui/react/macro';
import { CheckCheck, MapPin, Pencil, RotateCcw, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { getVisibleEditorForDoc } from '@/editor/active-editor';
import {
  ComposerMentionInput,
  type ComposerMentionInputHandle,
} from '@/editor/ComposerMentionInput';
import { cn } from '@/lib/utils';
import { captureSelectionContext, findQuoteRange } from './anchor-search';
import { propertyAddress, revealThread } from './comment-chips';
import { revealPropertyValueRange } from './property-row-rect';
import { scrollAnchorIntoView } from './scroll-to-anchor';
import {
  clearActiveThread,
  deleteThread,
  editComment,
  emitOpenThread,
  reopenThread,
  replaceOrphan,
  setActiveThread,
  toggleSending,
} from './store';
import type { CommentThread } from './types';

function editedAt(at: number, now: number): string {
  const date = new Date(at);
  const today = new Date(now);
  const sameDay =
    date.getFullYear() === today.getFullYear() &&
    date.getMonth() === today.getMonth() &&
    date.getDate() === today.getDate();
  const time = { hour: 'numeric', minute: '2-digit' } as const;
  if (sameDay) return date.toLocaleTimeString(undefined, time);
  if (date.getFullYear() === today.getFullYear()) {
    return date.toLocaleString(undefined, { month: 'short', day: 'numeric', ...time });
  }
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    ...time,
  });
}

export function ThreadCard({
  thread,
  cardRef,
  focused,
  active,
  sending,
}: {
  thread: CommentThread;
  cardRef: (el: HTMLElement | null) => void;
  focused: boolean;
  active: boolean;
  sending: boolean;
}) {
  const { t } = useLingui();
  const [renderedAt] = useState(() => Date.now());
  const [editing, setEditing] = useState(false);
  const [draftEmpty, setDraftEmpty] = useState(false);
  const editFieldRef = useRef<ComposerMentionInputHandle>(null);
  const isOrphaned = thread.status === 'orphaned';
  const isResolved = thread.status === 'resolved';

  const bodyRef = useRef(thread.body);
  useEffect(() => {
    bodyRef.current = thread.body;
  });

  const liveDraftRef = useRef<string | null>(null);
  const settledRef = useRef(false);

  useEffect(() => {
    if (!editing) return;
    settledRef.current = false;
    liveDraftRef.current = null;
    editFieldRef.current?.setText(bodyRef.current);
    editFieldRef.current?.focusEnd();
  }, [editing]);

  function settleEdit(raw: string | null) {
    if (settledRef.current) return;
    settledRef.current = true;
    setEditing(false);
    const next = (raw ?? '').trim();
    if (next.length === 0 || next === bodyRef.current) return;
    editComment(thread.id, next);
  }

  function commitEdit() {
    settleEdit(editFieldRef.current?.getContent().instruction ?? null);
  }

  function cancelEdit() {
    settleEdit(null);
  }

  function deleteComment() {
    cancelEdit();
    deleteThread(thread.id);
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: settleEdit is deliberately read at cleanup time; keying the effect on it would re-arm the commit on every render.
  useEffect(() => {
    if (!editing) return;
    return () => {
      settleEdit(liveDraftRef.current);
    };
  }, [editing]);

  function jumpToQuote(quote: string) {
    if (thread.anchor === null) return;
    if (getVisibleEditorForDoc(thread.docName) === null) {
      revealThread(thread);
      return;
    }
    if (thread.target.kind === 'property') {
      revealPropertyValueRange({
        key: thread.target.key,
        path: thread.target.path,
        quote,
        start: thread.anchor.start,
        end: thread.anchor.end,
      });
      emitOpenThread(thread.id);
      return;
    }
    const editor = getVisibleEditorForDoc(thread.docName);
    if (!editor) return;
    const range = findQuoteRange(editor.state.doc, quote, thread.anchor);
    if (!range) return;
    scrollAnchorIntoView(editor, range, thread.docName);
    emitOpenThread(thread.id);
  }

  function rePlaceOnSelection() {
    const editor = getVisibleEditorForDoc(thread.docName);
    if (!editor) return;
    const { from, to, empty } = editor.state.selection;
    if (empty) return;
    const quote = editor.state.doc.textBetween(from, to, ' ').trim();
    if (quote.length > 0) {
      replaceOrphan(thread.id, quote, captureSelectionContext(editor.state.doc, from, to));
    }
  }

  const cardSelects = !editing && !isResolved;

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: pointer-only affordance — clicking the card's whitespace solos its tick; keyboard/AT users compose the same state from the real controls (the card's checkbox + the footer's master tick). See focus-composer-on-card-pointer.ts for the sibling pattern.
    <article
      ref={cardRef}
      onPointerEnter={() => setActiveThread(thread.id)}
      onPointerLeave={() => clearActiveThread(thread.id)}
      onFocusCapture={() => setActiveThread(thread.id)}
      onBlurCapture={() => clearActiveThread(thread.id)}
      onClick={(event) => {
        if (!cardSelects) return;
        const target = event.target as HTMLElement | null;
        if (target?.closest('button, [role="checkbox"], [role="textbox"], a, input, textarea')) {
          return;
        }
        const selection = window.getSelection();
        if (
          selection !== null &&
          !selection.isCollapsed &&
          selection.anchorNode !== null &&
          event.currentTarget.contains(selection.anchorNode)
        ) {
          return;
        }
        toggleSending(thread.id);
      }}
      className={cn(
        'flex flex-col gap-1.5 rounded-lg border p-2.5 transition-[box-shadow,border-color,background-color]',
        cardSelects && 'cursor-pointer',
        isResolved && 'opacity-70',
        active && 'bg-blue-600/10',
        focused && 'ring-2 ring-primary',
      )}
    >
      {}
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          {}
          {!isResolved && (
            <Checkbox
              checked={sending}
              onCheckedChange={() => toggleSending(thread.id)}
              aria-label={sending ? t`Don't send this comment` : t`Send this comment`}
            />
          )}
          {}
          <span
            className="shrink-0 text-[10px] text-muted-foreground"
            title={new Date(thread.updatedAt).toLocaleString()}
          >
            {editedAt(thread.updatedAt, renderedAt)}
          </span>
        </div>
        <div className="flex min-w-0 items-center gap-1.5">
          {isResolved && (
            <Badge
              variant="outline"
              className="gap-1 border-green-600/40 text-green-700 dark:text-green-500"
            >
              {}
              <CheckCheck className="size-2.5" />
              <Trans>Resolved</Trans>
            </Badge>
          )}
          {}
          {}
          {!isResolved && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={t`Edit this comment`}
                  aria-expanded={editing}
                  className={cn(
                    'size-6 p-0',
                    editing ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
                  )}
                  onClick={() => setEditing((open) => !open)}
                >
                  <Pencil className="size-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                <Trans>Edit this comment</Trans>
              </TooltipContent>
            </Tooltip>
          )}
          {}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="sm"
                variant="ghost"
                className="size-6 p-0 text-muted-foreground hover:text-destructive"
                aria-label={t`Delete this comment`}
                onClick={deleteComment}
              >
                <Trash2 className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              <Trans>Delete this comment</Trans>
            </TooltipContent>
          </Tooltip>
        </div>
      </div>

      {}
      {isOrphaned ? (
        <div className="flex flex-col gap-0.5 rounded border-l-2 border-muted-foreground/40 bg-muted/40 px-2 py-1">
          {thread.anchor !== null && (
            <p
              className="truncate text-xs text-muted-foreground line-through"
              title={thread.anchor.quote}
            >
              {}“{thread.anchor.quote}”
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            <Trans>
              The original text was deleted. You can re-place this comment on selected text.
            </Trans>
          </p>
        </div>
      ) : (
        <Tooltip>
          {}
          <TooltipTrigger asChild>
            <span className="w-full">
              <Button
                type="button"
                variant="ghost"
                disabled={thread.anchor === null}
                onClick={() => jumpToQuote(thread.anchor?.quote ?? '')}
                className="h-auto w-full justify-start truncate rounded border-l-2 border-muted-foreground/40 bg-muted/40 px-2 py-1 text-left text-xs font-normal text-muted-foreground hover:bg-muted/70 disabled:opacity-100"
              >
                <span className="truncate">
                  {thread.target.kind === 'property' ? (
                    <span className="font-mono">
                      {propertyAddress(thread.target.key, thread.target.path)}:
                      {thread.anchor === null ? '' : ` “${thread.anchor.quote}”`}
                    </span>
                  ) : (
                    <>“{thread.anchor?.quote ?? ''}”</>
                  )}
                </span>
              </Button>
            </span>
          </TooltipTrigger>
          <TooltipContent>
            {thread.anchor === null ? (
              <Trans>This comment is on the whole property</Trans>
            ) : thread.target.kind === 'property' ? (
              <Trans>Jump to selected text in property</Trans>
            ) : (
              <Trans>Jump to the anchored text</Trans>
            )}
          </TooltipContent>
        </Tooltip>
      )}

      {}
      {editing ? (
        <div className="flex flex-col gap-1.5">
          <ComposerMentionInput
            ref={editFieldRef}
            ariaLabel={t`Edit this comment`}
            placeholder={t`Edit this comment`}
            onEmptyChange={setDraftEmpty}
            onContentChange={() => {
              liveDraftRef.current = editFieldRef.current?.getContent().instruction ?? null;
            }}
            onSubmit={commitEdit}
            onEscape={cancelEdit}
            className="max-h-40 overflow-y-auto rounded-md border px-2 py-1 text-sm"
          />
          {}
          <div className="flex items-center justify-end gap-1.5">
            <Button size="sm" variant="ghost" onClick={cancelEdit}>
              <Trans>Cancel</Trans>
            </Button>
            <Button
              size="sm"
              onClick={commitEdit}
              disabled={draftEmpty}
              aria-label={t`Save this comment (Enter)`}
            >
              <Trans>Save</Trans>
            </Button>
          </div>
        </div>
      ) : (
        <p data-testid="thread-comment-body" className="text-sm text-foreground/90">
          {thread.body}
        </p>
      )}

      {}
      {isOrphaned ? (
        <Button size="sm" variant="outline" className="min-w-0" onClick={rePlaceOnSelection}>
          <MapPin className="size-3.5 shrink-0" />
          <span className="truncate">
            <Trans>Re-place on selected text</Trans>
          </span>
        </Button>
      ) : (
        <>
          {}
          {isResolved && (
            <div className="flex min-w-0 flex-nowrap items-center justify-end gap-1.5">
              <Button
                size="sm"
                variant="outline"
                className="min-w-0"
                onClick={() => reopenThread(thread.id)}
              >
                <RotateCcw className="size-3.5 shrink-0" />
                <span className="truncate">
                  <Trans>Reopen</Trans>
                </span>
              </Button>
            </div>
          )}
        </>
      )}
    </article>
  );
}

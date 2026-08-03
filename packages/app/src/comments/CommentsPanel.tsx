/**
 * The comments panel: one card per thread on the open document.
 *
 * Thread lifecycle rendered from the store: anchored cards carrying one
 * comment, editable in place, plus send / resolve and the explicit
 * orphaned-"re-place" state.
 *
 * A thread holds ONE comment rather than a discussion. Comments go to an agent,
 * not to teammates, so there is nobody to reply to yet — revising what you asked
 * for is the move that actually comes up. An edit therefore REPLACES the comment
 * server-side; the superseded text is not kept.
 */

import { Trans, useLingui } from '@lingui/react/macro';
import {
  Check,
  CircleDot,
  MapPin,
  Pencil,
  RotateCcw,
  Sparkles,
  Trash2,
  Unlink,
  X,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Panel,
  PanelBody,
  PanelCount,
  PanelEmpty,
  PanelHeader,
  PanelTitle,
} from '@/components/ui/panel';
import { Textarea } from '@/components/ui/textarea';
import { getEditorForDoc } from '@/editor/active-editor';
import { ProfilerBoundary } from '@/lib/perf';
import { cn } from '@/lib/utils';
import { captureSelectionContext, findQuoteRange } from './anchor-search';
import { propertyAddress } from './comment-chips';
import { revealPropertyValueRange } from './property-row-rect';
import { scrollAnchorIntoView } from './scroll-to-anchor';
import {
  clearActiveThread,
  deleteThread,
  editComment,
  refresh,
  reopenThread,
  replaceOrphan,
  resolveThread,
  setActiveThread,
  subscribeFocusThread,
  toggleQueue,
  useCommentThreads,
} from './store';
import type { CommentThread } from './types';

function relativeTime(at: number, now: number): string {
  const secs = Math.max(1, Math.round((now - at) / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  return `${hours}h`;
}

export function ThreadCard({
  thread,
  now,
  cardRef,
  focused,
  onClose,
}: {
  thread: CommentThread;
  now: number;
  cardRef: (el: HTMLElement | null) => void;
  focused: boolean;
  /** When set, renders a close button in the header (used by the popover). */
  onClose?: () => void;
}) {
  const { t } = useLingui();
  // The edit field opens on demand from the icon in the action row, seeded with
  // the current text — this revises the comment rather than adding to it.
  const [draft, setDraft] = useState(thread.body);
  const [editing, setEditing] = useState(false);
  const editFieldRef = useRef<HTMLTextAreaElement>(null);
  const isOrphaned = thread.status === 'orphaned';
  const isResolved = thread.status === 'resolved';

  // Focus the edit field with the caret AFTER the existing text. `autoFocus`
  // alone lands it at offset 0, so you open an edit standing in front of your
  // own sentence and have to travel to the end before typing.
  useEffect(() => {
    if (!editing) return;
    const field = editFieldRef.current;
    if (field === null) return;
    field.focus();
    const end = field.value.length;
    field.setSelectionRange(end, end);
  }, [editing]);

  function jumpToQuote(quote: string) {
    if (thread.anchor === null) return;
    // A value comment lives in a `<textarea>`, which no editor command can
    // reach — selecting the words in the field is the only highlight it has.
    if (thread.target.kind === 'property') {
      revealPropertyValueRange({
        key: thread.target.key,
        path: thread.target.path,
        quote,
        start: thread.anchor.start,
        end: thread.anchor.end,
      });
      return;
    }
    const editor = getEditorForDoc(thread.docName);
    if (!editor) return;
    const range = findQuoteRange(editor.state.doc, quote, thread.anchor);
    if (!range) return;
    // Select without ProseMirror's own scroll, then place it ourselves — its
    // minimal scroll lands the passage under the floating toolbar.
    editor.chain().focus().setTextSelection(range).run();
    scrollAnchorIntoView(editor, range);
  }

  function rePlaceOnSelection() {
    const editor = getEditorForDoc(thread.docName);
    if (!editor) return;
    const { from, to, empty } = editor.state.selection;
    if (empty) return;
    const quote = editor.state.doc.textBetween(from, to, ' ').trim();
    // Same context the create path sends: re-placing onto one of two identical
    // passages has to land on the one selected, not the first in the file.
    if (quote.length > 0) {
      replaceOrphan(thread.id, quote, captureSelectionContext(editor.state.doc, from, to));
    }
  }

  return (
    <article
      ref={cardRef}
      // Reading a card deepens its passage in the document. With two comments
      // on the same words that is the only thing saying which is which, so it
      // follows the pointer and keyboard focus rather than waiting for a click.
      onPointerEnter={() => setActiveThread(thread.id)}
      onPointerLeave={() => clearActiveThread(thread.id)}
      onFocusCapture={() => setActiveThread(thread.id)}
      onBlurCapture={() => clearActiveThread(thread.id)}
      className={cn(
        'flex flex-col gap-1.5 rounded-lg border p-2.5 transition-shadow',
        isResolved && 'opacity-70',
        isOrphaned && 'border-amber-500/40 bg-amber-500/5',
        focused && 'ring-2 ring-primary',
      )}
    >
      {/* Timestamp leads, the way the author chip used to — with the row pinned
          right, dropping the author left a hole on the left of every card. */}
      <div className="flex items-center justify-between gap-2">
        <span className="shrink-0 text-[10px] text-muted-foreground">
          {relativeTime(thread.createdAt, now)}
        </span>
        <div className="flex min-w-0 items-center gap-1.5">
          {isResolved && (
            <Badge
              variant="outline"
              className="gap-1 border-green-600/40 text-green-700 dark:text-green-500"
            >
              <Check className="size-2.5" />
              <Trans>Resolved</Trans>
            </Badge>
          )}
          {isOrphaned && (
            <Badge
              variant="outline"
              className="gap-1 border-amber-500/50 text-amber-600 dark:text-amber-500"
            >
              <Unlink className="size-2.5" />
              <Trans>Orphaned</Trans>
            </Badge>
          )}
          {/* No confirm step: a comment is one line of your own text, it has
              gone nowhere but the queue, and re-adding it costs a selection and
              a sentence. An interstitial would cost more than the mistake. */}
          <Button
            size="sm"
            variant="ghost"
            className="size-6 p-0 text-muted-foreground hover:text-destructive"
            aria-label={t`Delete this comment`}
            title={t`Delete this comment`}
            onClick={() => deleteThread(thread.id)}
          >
            <Trash2 className="size-3.5" />
          </Button>
          {onClose && (
            <Button
              size="sm"
              variant="ghost"
              className="-mr-1 size-6 p-0 text-muted-foreground hover:text-foreground"
              aria-label={t`Close`}
              onClick={onClose}
            >
              <X className="size-3.5" />
            </Button>
          )}
        </div>
      </div>

      {/* Anchor quote */}
      {isOrphaned ? (
        <p className="rounded border-l-2 border-amber-500/60 bg-amber-500/10 px-2 py-1 text-xs text-amber-700 dark:text-amber-400">
          <Trans>The anchored text is gone. You can re-place it on selected text.</Trans>
        </p>
      ) : (
        <Button
          type="button"
          variant="ghost"
          // Inert only when there are no words to reveal — a comment on a whole
          // field. The row still renders, so the thread keeps saying what it is
          // on rather than showing nothing.
          disabled={thread.anchor === null}
          onClick={() => jumpToQuote(thread.anchor?.quote ?? '')}
          title={
            thread.anchor === null
              ? t`This comment is on the whole property`
              : thread.target.kind === 'property'
                ? t`Select this text in the property`
                : t`Jump to the anchored text`
          }
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
      )}

      <p className="text-sm text-foreground/90">{thread.body}</p>

      {/* Actions */}
      {isOrphaned ? (
        <Button size="sm" variant="outline" className="min-w-0" onClick={rePlaceOnSelection}>
          <MapPin className="size-3.5 shrink-0" />
          <span className="truncate">
            <Trans>Re-place on selected text</Trans>
          </span>
        </Button>
      ) : (
        <>
          {/* The field appears only once you ask for it — most cards are being
              read, not revised, so an always-present box costs every card height
              for an action taken on few of them. Enter saves, Shift+Enter is a
              newline, Escape discards the revision. */}
          {editing && (
            <Textarea
              ref={editFieldRef}
              rows={1}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  setDraft(thread.body);
                  setEditing(false);
                  return;
                }
                if (e.key !== 'Enter' || e.shiftKey) return;
                // Mid-composition Enter belongs to the IME, not to saving.
                if (e.nativeEvent.isComposing) return;
                e.preventDefault();
                const next = draft.trim();
                if (next.length === 0 || next === thread.body) {
                  setEditing(false);
                  return;
                }
                editComment(thread.id, next);
                setEditing(false);
              }}
              placeholder={t`Edit this comment`}
              className="min-h-0 resize-none px-2 py-1 text-sm leading-5"
            />
          )}
          {/* One row, never wrapped: wrapping made the queued and un-queued
              states different heights (the longer label bumped Resolve onto a
              second line). Labels are short and `truncate`-capable instead, so
              the row holds its shape in both states. */}
          <div className="flex min-w-0 flex-nowrap items-center justify-end gap-1.5">
            {!isResolved && (
              <Button
                size="sm"
                variant="ghost"
                aria-label={t`Edit this comment`}
                title={t`Edit this comment`}
                aria-expanded={editing}
                className={cn(
                  'size-7 shrink-0 p-0',
                  editing ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
                )}
                onClick={() => {
                  setDraft(thread.body);
                  setEditing((open) => !open);
                }}
              >
                <Pencil className="size-3.5" />
              </Button>
            )}
            {/* Send toggle — the round trip out of and back into the batch.
                Dropping a comment from the batch never destroys it, so this is
                how it gets back in. One model: everything ships via the
                composer's batch, not a second per-thread dispatch path. */}
            {!isResolved &&
              (thread.queued ? (
                /* "Ready to send" reads as a settled state (✓ Ready to send) and
                   turns into its own undo on hover — the ✕ says what the click will do
                   without spending a second control on it. Keyboard parity via
                   `group-focus-visible`, NOT `focus-within`: a mouse click
                   leaves the button focused, so focus-within pinned the ✕ open
                   on the one card you last touched while its neighbours sat at
                   ✓. The label does NOT change with the icon: swapping to
                   "Don't send" moves the text under the cursor mid-hover. */
                <Button
                  size="sm"
                  variant="outline"
                  aria-label={t`Don't send this comment`}
                  className="group/queued min-w-0 border-primary/40 text-primary hover:bg-primary/10 hover:text-primary"
                  onClick={() => toggleQueue(thread.id)}
                >
                  <span className="relative inline-flex size-3.5 shrink-0">
                    <Check
                      className="absolute inset-0 size-3.5 opacity-100 transition-opacity duration-150 ease-out group-hover/queued:opacity-0 group-focus-visible/queued:opacity-0 motion-reduce:transition-none"
                      aria-hidden
                    />
                    <X
                      className="absolute inset-0 size-3.5 opacity-0 transition-opacity duration-150 ease-out group-hover/queued:opacity-100 group-focus-visible/queued:opacity-100 motion-reduce:transition-none"
                      aria-hidden
                    />
                  </span>
                  <span className="truncate">
                    <Trans>Ready to send</Trans>
                  </span>
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="ghost"
                  className="min-w-0 text-muted-foreground hover:text-foreground"
                  onClick={() => toggleQueue(thread.id)}
                >
                  <Sparkles className="size-3.5 shrink-0" />
                  <span className="truncate">
                    <Trans>Send later</Trans>
                  </span>
                </Button>
              ))}
            {isResolved ? (
              // Reopening has to be one click: dispatching auto-resolves a
              // thread on send, so this is the correction when the agent didn't
              // actually settle it. A static "Done" label left no way back.
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
            ) : (
              <Button
                size="sm"
                variant="outline"
                className="min-w-0"
                onClick={() => resolveThread(thread.id)}
              >
                <Check className="size-3.5 shrink-0" />
                <span className="truncate">
                  <Trans>Resolve</Trans>
                </span>
              </Button>
            )}
          </div>
        </>
      )}
    </article>
  );
}

function CommentsPanelInner({ docName }: { docName: string }) {
  const { t } = useLingui();
  const threads = useCommentThreads(docName);
  const [showResolved, setShowResolved] = useState(false);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const cardRefs = useRef(new Map<string, HTMLElement>());
  // Captured once on mount — relative timestamps don't need to tick live, and
  // calling Date.now() during render violates the React Compiler purity rule.
  const [now] = useState(() => Date.now());

  // Load this doc's threads when the panel opens — it can open before (or
  // without) the editor's anchor layer having mounted.
  useEffect(() => {
    void refresh(docName).catch(() => undefined);
  }, [docName]);

  // Clicking an in-doc highlight scrolls the panel to its thread + rings it.
  //
  // The ring's timer is held so it can be cancelled. Left dangling it fired
  // after unmount, and every focus event queued another — clicking through ten
  // highlights left ten timers racing to clear a ring only one of them owns.
  const ringTimer = useRef<number | null>(null);
  useEffect(() => {
    const stop = subscribeFocusThread((threadId) => {
      setFocusedId(threadId);
      cardRefs.current.get(threadId)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      if (ringTimer.current !== null) window.clearTimeout(ringTimer.current);
      ringTimer.current = window.setTimeout(() => {
        ringTimer.current = null;
        setFocusedId((cur) => (cur === threadId ? null : cur));
      }, 1_600);
    });
    return () => {
      stop();
      if (ringTimer.current !== null) window.clearTimeout(ringTimer.current);
    };
  }, []);

  const active = threads.filter((thread) => thread.status !== 'resolved');
  const resolved = threads.filter((thread) => thread.status === 'resolved');
  const visible = showResolved ? threads : active;

  return (
    <Panel>
      <PanelHeader>
        <PanelTitle>
          <Trans>Comments</Trans>
        </PanelTitle>
        <div className="flex items-center gap-2">
          {resolved.length > 0 && (
            <Button
              size="sm"
              variant="ghost"
              className="h-6 gap-1 px-1.5 text-xs"
              onClick={() => setShowResolved((v) => !v)}
            >
              {showResolved ? <CircleDot className="size-3" /> : <Check className="size-3" />}
              {showResolved ? t`Hide resolved` : t`Show resolved (${resolved.length})`}
            </Button>
          )}
          <PanelCount>{active.length}</PanelCount>
        </div>
      </PanelHeader>
      <PanelBody className="flex flex-col gap-3">
        {visible.length === 0 ? (
          <PanelEmpty>
            <Trans>No comments yet. Select text in the document to add one.</Trans>
          </PanelEmpty>
        ) : (
          visible.map((thread) => (
            <ThreadCard
              key={thread.id}
              thread={thread}
              now={now}
              focused={focusedId === thread.id}
              cardRef={(el) => {
                if (el) cardRefs.current.set(thread.id, el);
                else cardRefs.current.delete(thread.id);
              }}
            />
          ))
        )}
      </PanelBody>
    </Panel>
  );
}

export function CommentsPanel({ docName }: { docName: string }) {
  return (
    <ProfilerBoundary name="comments-panel">
      <CommentsPanelInner docName={docName} />
    </ProfilerBoundary>
  );
}

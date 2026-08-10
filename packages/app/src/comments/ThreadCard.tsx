/**
 * One comment, as a card.
 *
 * Thread lifecycle rendered from the store: the anchored quote, the comment
 * itself (editable in place), the tick that decides whether it goes out with
 * the next send, resolve, and the explicit orphaned-"re-place" state. Shared by
 * both comment scopes and by the in-document popover, so a comment looks and
 * behaves the same wherever it is met.
 *
 * A thread holds ONE comment rather than a discussion. Comments go to an agent,
 * not to teammates, so there is nobody to reply to yet — revising what you asked
 * for is the move that actually comes up. An edit therefore REPLACES the comment
 * server-side; the superseded text is not kept.
 */

// biome-ignore-all lint/plugin/no-physical-direction-utility: pre-rule backlog — physical margin/padding/inset utilities predate the rule; drain by swapping ml/mr → ms/me, pl/pr → ps/pe, left/right → start/end, then deleting this line. See https://github.com/inkeep/open-knowledge/blob/main/biome-plugins/README.md#no-physical-direction-utilitygrit

// Two macro imports, deliberately: `relativeTime` is a plain module function
// with no React context to read, so its units come from the core macro, while
// the component's own copy uses the hook. The component-local `t` shadows this
// one inside it, which is why the stamp lives outside.
import { t } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import { Check, MapPin, Pencil, RotateCcw, Trash2, Unlink, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Textarea } from '@/components/ui/textarea';
import { getEditorForDoc } from '@/editor/active-editor';
import { cn } from '@/lib/utils';
import { captureSelectionContext, findQuoteRange } from './anchor-search';
import { propertyAddress, revealThread } from './comment-chips';
import { revealPropertyValueRange } from './property-row-rect';
import { scrollAnchorIntoView } from './scroll-to-anchor';
import {
  clearActiveThread,
  deleteThread,
  editComment,
  reopenThread,
  replaceOrphan,
  setActiveThread,
  toggleSending,
} from './store';
import type { CommentThread } from './types';

/**
 * The card's age stamp, in the largest unit that still reads as an age.
 *
 * Rolls over rather than running the smallest unit up forever: hours alone gave
 * a week-old comment "174h", a number nobody converts in their head. Past a week
 * even days stop meaning anything, so it hands over to a date — the same
 * rollover point the Timeline panel uses, so two views of the same week-old
 * thing agree.
 *
 * `floor`, not `round`: rounding UP promoted 23.6 hours to "24h" and 6.7 days to
 * "7d", both of which are ages the branch below was supposed to have taken.
 */
function relativeTime(at: number, now: number): string {
  const secs = Math.max(1, Math.floor((now - at) / 1000));
  if (secs < 60) return t`${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return t`${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return t`${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return t`${days}d`;
  return new Date(at).toLocaleDateString();
}

export function ThreadCard({
  thread,
  now,
  cardRef,
  focused,
  sending,
  onClose,
}: {
  thread: CommentThread;
  now: number;
  cardRef: (el: HTMLElement | null) => void;
  focused: boolean;
  /**
   * Ticked for the next send. Passed in rather than read here so one
   * subscription serves a whole panel of cards.
   *
   * Required, not optional: as an optional prop it defaulted to `undefined`,
   * which renders a permanently unchecked box that still writes to the store on
   * click. A host that forgets it must fail to compile, not ship a control that
   * silently disagrees with the state behind it.
   */
  sending: boolean;
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
    // A comment on a file that is not open: the project scope lists every
    // document, so the editor this jump needs may not exist yet. `revealThread`
    // navigates first and waits for that editor to mount; the local paths below
    // would find nothing and silently do nothing.
    if (getEditorForDoc(thread.docName) === null) {
      revealThread(thread);
      return;
    }
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

  function cancelEdit() {
    setDraft(thread.body);
    setEditing(false);
  }

  function saveEdit() {
    const next = draft.trim();
    if (next.length === 0 || next === thread.body) {
      setEditing(false);
      return;
    }
    editComment(thread.id, next);
    setEditing(false);
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
        <div className="flex min-w-0 items-center gap-2">
          {/* The tick that decides whether this comment goes out. A checkbox
              rather than the button it replaces: both panels list every comment
              now, ticked or not, so the state has to read at a glance down a
              column instead of being spelled out per card. Resolved threads
              carry no tick — they have already been dealt with, and the queue
              excludes them by construction. */}
          {!isResolved && (
            <Checkbox
              checked={sending}
              onCheckedChange={() => toggleSending(thread.id)}
              aria-label={sending ? t`Don't send this comment` : t`Send this comment`}
            />
          )}
          <span className="shrink-0 text-[10px] text-muted-foreground">
            {relativeTime(thread.createdAt, now)}
          </span>
        </div>
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
          {/* Edit rides beside Delete rather than in a row of its own: the two
              are peers, both acting on this comment as an object rather than on
              where it goes. A row for one icon also costs a line of card height
              on every card, for the least-taken action. */}
          {!isResolved && (
            <Button
              size="sm"
              variant="ghost"
              aria-label={t`Edit this comment`}
              title={t`Edit this comment`}
              aria-expanded={editing}
              className={cn(
                'size-6 p-0',
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
            <div className="flex flex-col gap-1.5">
              <Textarea
                ref={editFieldRef}
                rows={1}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    cancelEdit();
                    return;
                  }
                  if (e.key !== 'Enter' || e.shiftKey) return;
                  // Mid-composition Enter belongs to the IME, not to saving.
                  if (e.nativeEvent.isComposing) return;
                  e.preventDefault();
                  saveEdit();
                }}
                placeholder={t`Edit this comment`}
                className="min-h-0 resize-none px-2 py-1 text-sm leading-5"
              />
              <div className="flex items-center justify-end gap-1.5">
                <Button size="sm" variant="ghost" onClick={cancelEdit}>
                  <Trans>Cancel</Trans>
                </Button>
                <Button
                  size="sm"
                  onClick={saveEdit}
                  disabled={draft.trim().length === 0}
                  aria-label={t`Save this comment (Enter)`}
                >
                  <Trans>Save</Trans>
                </Button>
              </div>
            </div>
          )}
          {/* Only a resolved thread still needs a row down here. Resolving is
              something a SEND does, not something you declare, so there is no
              manual Resolve — but Reopen has to stay, and stay one click: it is
              the correction for a send where the agent didn't actually settle
              the thing, and without it that send would be irreversible. An open
              thread's own actions ride the header beside the timestamp, which is
              what lets its card end at the comment text. */}
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

/**
 * One comment, as a card.
 *
 * Thread lifecycle rendered from the store: the anchored quote, the comment
 * itself (editable in place), the tick that decides whether it goes out with
 * the next send, resolve, and the explicit orphaned-"re-place" state. Shared by
 * both comment scopes, so a comment looks and behaves the same wherever it is
 * met.
 *
 * A thread holds ONE comment rather than a discussion. Comments go to an agent,
 * not to teammates, so there is nobody to reply to yet — revising what you asked
 * for is the move that actually comes up. An edit therefore REPLACES the comment
 * server-side; the superseded text is not kept.
 */

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

/**
 * When the comment was last written, as a clock time rather than an age.
 *
 * An age ("20m") answers how long ago and nothing else: two comments written in
 * the same sitting both read "20m", and coming back to a document the next day
 * every stamp has silently changed. A time is the same string every time you
 * look at it, which is what makes it something you can refer to.
 *
 * Only as much date as the reader doesn't already have. Today's comments show
 * the time alone — "today" is what the reader is in, and stamping it on every
 * card in a session's worth of comments says nothing while pushing the ones that
 * DO carry a date out of alignment. The year appears only outside this one.
 *
 * Rendered in the machine's own locale and timezone (`Intl` defaults), like
 * every other stamp in the app.
 */
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
  /**
   * The reader has this thread OPEN. The card answers with the same blue WASH
   * the passage carries — background only, no border (a border reads as a
   * statement about selection, which the tick owns). Open specifically, not
   * hover: hosts used to pass the pointer-following active thread, and every
   * card lit itself as the mouse crossed it.
   */
  active: boolean;
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
}) {
  const { t } = useLingui();
  // Captured once on mount: only the today-or-not branch reads it, that answer
  // does not change while a card is on screen, and calling Date.now() during
  // render violates the React Compiler purity rule.
  const [renderedAt] = useState(() => Date.now());
  // The edit field opens on demand from the icon in the header, seeded with the
  // current text — this revises the comment rather than adding to it.
  const [editing, setEditing] = useState(false);
  // Pushed up by the field on every keystroke; the Save button reads it so a
  // revision emptied down to nothing can't be filed.
  const [draftEmpty, setDraftEmpty] = useState(false);
  const editFieldRef = useRef<ComposerMentionInputHandle>(null);
  const isOrphaned = thread.status === 'orphaned';
  const isResolved = thread.status === 'resolved';

  // Read by the seed effect below, which must not re-run when the body changes:
  // a comment revised elsewhere while you have this field open would otherwise
  // overwrite what you are typing.
  const bodyRef = useRef(thread.body);
  useEffect(() => {
    bodyRef.current = thread.body;
  });

  // The field's current text, mirrored on every keystroke. The unmount commit
  // below cannot read the field directly — by the time the cleanup runs, the
  // field's own editor may already be destroyed — so the words ride a ref the
  // whole time the edit is open.
  const liveDraftRef = useRef<string | null>(null);
  /** An explicit save or discard already settled this edit — later signals stand down. */
  const settledRef = useRef(false);

  // Seed the field and put the caret AFTER the existing text. Focus alone lands
  // it at offset 0, so you would open an edit standing in front of your own
  // sentence and have to travel to the end before typing.
  useEffect(() => {
    if (!editing) return;
    settledRef.current = false;
    liveDraftRef.current = null;
    editFieldRef.current?.setText(bodyRef.current);
    editFieldRef.current?.focusEnd();
  }, [editing]);

  /**
   * Settle the edit with `raw` as the revision. Idempotent — Enter, Escape, and
   * the unmount commit can all fire around one edit, and only the first counts.
   */
  function settleEdit(raw: string | null) {
    if (settledRef.current) return;
    settledRef.current = true;
    setEditing(false);
    const next = (raw ?? '').trim();
    if (next.length === 0 || next === bodyRef.current) return;
    editComment(thread.id, next);
  }

  /** Save the revision, or close on a no-op. Enter and the `@`-popup's own keys
   *  are the field's concern; this only decides what a submit means. */
  function commitEdit() {
    settleEdit(editFieldRef.current?.getContent().instruction ?? null);
  }

  /** The one explicit DISCARD — Escape and the Cancel button. Settling with no
   *  text saves nothing and, crucially, stands the unmount commit down. */
  function cancelEdit() {
    settleEdit(null);
  }

  /**
   * Delete the thread, discarding any revision in flight.
   *
   * Deleting is not clicking away. The card unmounts either way, but only one of
   * them means "file what I typed" — left to the unmount commit, deleting a
   * comment mid-edit filed the revision against a thread that no longer exists,
   * and the reader got a "couldn't save that edit" on top of a delete that
   * worked perfectly.
   */
  function deleteComment() {
    cancelEdit();
    deleteThread(thread.id);
  }

  // Click-away SAVES, like Notion — not silently discards. A card can unmount
  // mid-edit under the reader (the panel switches scope, the thread resolves,
  // the document changes); before this, that threw the revision away with
  // nothing saying so, which read as "my edit didn't reflect". Escape remains
  // the explicit discard, and it settles the edit first so this cleanup stands
  // down.
  //
  // The commit must fire exactly when the edit session ends, not when the
  // thread re-renders mid-edit.
  // biome-ignore lint/correctness/useExhaustiveDependencies: settleEdit is deliberately read at cleanup time; keying the effect on it would re-arm the commit on every render.
  useEffect(() => {
    if (!editing) return;
    return () => {
      settleEdit(liveDraftRef.current);
    };
  }, [editing]);

  function jumpToQuote(quote: string) {
    if (thread.anchor === null) return;
    // A comment on a document that is not IN FRONT OF THE READER: the project
    // scope lists every file, and the pool keeps the last few visited ones
    // mounted but hidden — so "an editor exists" is not "you can see it". Either
    // way `revealThread` navigates first and waits; the local paths below would
    // measure a pane with no layout and silently do nothing.
    if (getVisibleEditorForDoc(thread.docName) === null) {
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
      emitOpenThread(thread.id);
      return;
    }
    const editor = getVisibleEditorForDoc(thread.docName);
    if (!editor) return;
    const range = findQuoteRange(editor.state.doc, quote, thread.anchor);
    if (!range) return;
    // Scrolled to and pointed at, never selected. Focusing the editor and
    // setting a text selection put a live selection on the passage — blue, with
    // the formatting bubble menu over it — so following a comment from the panel
    // read as picking the words up to edit them. Opening the thread is what the
    // margin marker does, and it deepens the highlight the same way, which is
    // the "here it is" this needed all along.
    //
    // Our own scroll, not ProseMirror's: its minimal scroll lands the passage
    // under the floating toolbar.
    scrollAnchorIntoView(editor, range, thread.docName);
    emitOpenThread(thread.id);
  }

  function rePlaceOnSelection() {
    // Visible, like the jump: re-placing reads the reader's CURRENT selection,
    // and a hidden pane's selection is whatever was left there last time.
    const editor = getVisibleEditorForDoc(thread.docName);
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

  // Clicking the card SELECTS ONLY this comment, or clears it when it is
  // already the only one; the checkbox stays additive, and the quote row keeps
  // the jump. Never while editing, and a resolved card has no tick to narrow.
  const cardSelects = !editing && !isResolved;

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: pointer-only affordance — clicking the card's whitespace solos its tick; keyboard/AT users compose the same state from the real controls (the card's checkbox + the footer's master tick). See focus-composer-on-card-pointer.ts for the sibling pattern.
    <article
      ref={cardRef}
      // Reading a card deepens its passage in the document. With two comments
      // on the same words that is the only thing saying which is which, so it
      // follows the pointer and keyboard focus rather than waiting for a click.
      onPointerEnter={() => setActiveThread(thread.id)}
      onPointerLeave={() => clearActiveThread(thread.id)}
      onFocusCapture={() => setActiveThread(thread.id)}
      onBlurCapture={() => clearActiveThread(thread.id)}
      // The card body is a bigger target for the tick it contains, and nothing
      // more. It used to mean "send only this one" — narrowing the batch and
      // clearing every other comment — which is a reasonable shortcut and the
      // wrong one to hang on a bare click: a column of rows with checkboxes, a
      // select-all above them and a count reads as a checklist, and in a
      // checklist clicking a row toggles that row. Readers reached for the
      // additive meaning and got the destructive one.
      // The jump stays on the quote row, and a click that started on any
      // interactive descendant is that control's alone.
      onClick={(event) => {
        if (!cardSelects) return;
        const target = event.target as HTMLElement | null;
        if (target?.closest('button, [role="checkbox"], [role="textbox"], a, input, textarea')) {
          return;
        }
        // A drag that SELECTED this card's words still ends in a click on the
        // card, so copying a sentence out of a comment silently toggled whether
        // it was going to be sent. Anchored inside this card specifically:
        // selecting a passage in the document and then clicking a card here is
        // an ordinary click, and reading the selection alone would swallow it.
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
        // No card treatment for a lost passage. This hue in this component means
        // the passage highlight — the wash a card takes while it is being read,
        // matching the mark on its text in the document. A card tinted for its
        // STATE spent that hue on something the document never echoes, and left
        // every orphan looking permanently hovered.
        // The same hue as the passage's highlight — and like it, a wash with no
        // outline, so being-read never masquerades as being-selected. Tracks
        // COMMENT_HUE in `anchor-layers.ts`; recolouring one means recolouring
        // both, and nothing checks that for you.
        active && 'bg-blue-600/10',
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
          {/* `title` carries the full date and time, including the year and the
              seconds the stamp drops. */}
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
              {/* The doubled check, matching the panel's show-resolved toggle.
                  A single one is this panel's "ticked to send" mark, and the two
                  meanings cannot share a glyph on the same card. */}
              <CheckCheck className="size-2.5" />
              <Trans>Resolved</Trans>
            </Badge>
          )}
          {/* No badge for the lost-passage state. The block below already says
              it in a full sentence, right under the words it is about, and the
              card carries the blue treatment either way — a badge saying the
              same thing two lines up was the state announced twice. Resolved
              keeps its badge because nothing else on that card says so. */}
          {/* Edit rides beside Delete rather than in a row of its own: the two
              are peers, both acting on this comment as an object rather than on
              where it goes. A row for one icon also costs a line of card height
              on every card, for the least-taken action. */}
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
          {/* No confirm step: a comment is one line of your own text, it has
              gone nowhere but the queue, and re-adding it costs a selection and
              a sentence. An interstitial would cost more than the mistake. */}
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

      {/* Anchor quote — the card sits away from the text, so it has to say what
          the comment is on. The orphaned block stands in for it: a thread that
          lost its passage says so instead, and still SHOWS the quote, because
          orphaning mutates state alone, so the stored words survive as the last
          thing the comment was on, and they are what tells a reader which of
          several comments this is.

          Same chrome as the live quote row it stands in for — a lost passage is
          still the passage this comment is on, so it reads as that row struck
          through rather than as a different kind of object. */}
      {isOrphaned ? (
        <div className="flex flex-col gap-0.5 rounded border-l-2 border-muted-foreground/40 bg-muted/40 px-2 py-1">
          {thread.anchor !== null && (
            <p
              className="truncate text-xs text-muted-foreground line-through"
              title={thread.anchor.quote}
            >
              {/* Struck through, but never ONLY struck through — the sentence
                  below carries the same fact in words, which is what a screen
                  reader and a monochrome display get. */}
              “{thread.anchor.quote}”
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
          {/* `asChild` onto a DISABLED button would lose the hint — a disabled
              element fires no pointer events, so Radix never sees the hover.
              The span is what carries it for the inert case. */}
          <TooltipTrigger asChild>
            <span className="w-full">
              <Button
                type="button"
                variant="ghost"
                // Inert only when there are no words to reveal — a comment on a whole
                // field. The row still renders, so the thread keeps saying what it is
                // on rather than showing nothing.
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

      {/* The comment, or the field that revises it — one slot, never both. The
          field used to open BENEATH the text it was seeded from, so a card in
          edit mode printed the same sentence twice, inches apart, and the card
          grew by a row for it. Editing something means editing it where it is.

          The SAME field the comment was written in, not a plain textarea: `@` a
          file while writing a comment and you could not `@` one while revising
          it, which made the revision a lesser thing than the original for no
          reason a reader could see. Enter saves, Shift+Enter is a newline, and
          Escape closes — all three belong to the field, which is also the only
          side that knows whether the `@`-popup just consumed the key. */}
      {editing ? (
        <div className="flex flex-col gap-1.5">
          <ComposerMentionInput
            ref={editFieldRef}
            ariaLabel={t`Edit this comment`}
            placeholder={t`Edit this comment`}
            // Drives the Save button's disabled state — an empty field has no
            // revision to file, and the keyboard path declines the same case.
            onEmptyChange={setDraftEmpty}
            // Mirrored per keystroke for the unmount commit, which runs after
            // the field's editor is already gone.
            onContentChange={() => {
              liveDraftRef.current = editFieldRef.current?.getContent().instruction ?? null;
            }}
            onSubmit={commitEdit}
            // The one explicit DISCARD. Settling with the original text saves
            // nothing and, crucially, stands the unmount commit down.
            onEscape={cancelEdit}
            className="max-h-40 overflow-y-auto rounded-md border px-2 py-1 text-sm"
          />
          {/* The keys alone are not the affordance. Enter/Escape stay the fast
              path, but a field with no visible way out leaves a reader who
              never learned them stuck in it — and click-away saving is a
              guess unless something on screen says which way the exit goes. */}
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

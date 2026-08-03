/**
 * Queued comments as a context chip in the persistent "Ask AI" composer.
 *
 * The queue lives where you already are rather than behind a panel tab: posting
 * a comment adds it to the composer as a chip, typing gives the whole batch a
 * shared instruction, and the composer's existing send button + agent picker
 * dispatch it. Commenting and asking become one gesture, which is the point of
 * the feature — a separate "dispatch" surface split them again.
 *
 * One send = ONE agent turn carrying every queued comment, so an agent handling
 * several related notes sees them together. (The alternative — a turn per
 * comment — isolates failures but fragments the conversation.)
 */

import { Plural, Trans, useLingui } from '@lingui/react/macro';
import { ChevronDown, FileText, MessageSquare, Plus, Unlink, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { cn } from '@/lib/utils';
import type { DispatchPayload } from './comments-client';
import { revealPropertyValueRange } from './property-row-rect';
import { revealComment } from './reveal-comment';
import {
  getThreadById,
  removeFromQueue,
  toggleQueueSelection,
  useQueue,
  useQueueSelection,
} from './store';
import type { CommentThread } from './types';

/** The queued comments backing the composer chip, in queue order. */
export function useQueuedComments(): CommentThread[] {
  const ids = useQueue();
  const threads: CommentThread[] = [];
  for (const id of ids) {
    const thread = getThreadById(id);
    if (thread !== null) threads.push(thread);
  }
  return threads;
}

/**
 * How many queued comments are actually checked — what a send would carry.
 *
 * The chip counts this rather than the whole queue: unchecking an item has to
 * change the number, or the control gives no feedback and the count promises
 * more than the send delivers.
 */
export function useSelectedCommentCount(): number {
  return useQueueSelection().length;
}

/**
 * One chip standing for the whole batch (`3 comments`), matching how the
 * selection pill reads — a count plus a remove control, never raw content.
 *
 * The chip is also the ATTACH control, which is why it renders whenever
 * anything is queued rather than only once the batch is riding the message.
 * Attaching is opt-in, so something has to say a queue exists — and the count
 * is that something. Behind a `+` menu it was one click deep and invisible until
 * you went looking, which made a queue you had just built read as lost.
 *
 * Unattached it is a single toggle: click to put the batch on this message.
 * Attached it grows the two controls the other context chips carry — a peek
 * (what am I about to send) and a ✕ (stop carrying it).
 */
export function QueuedCommentsChip({
  count,
  attached,
  expanded,
  onAttach,
  onToggleExpanded,
  onDismiss,
}: {
  count: number;
  /** The batch is riding this message. Unattached, the chip is an add button. */
  attached: boolean;
  expanded: boolean;
  /** Put the queue ON this message. The queue itself is untouched either way. */
  onAttach: () => void;
  onToggleExpanded: () => void;
  /**
   * Take the queue OUT of this message — it does not touch the queue itself.
   *
   * The sibling controls in this row (a file chip's ✕, the selection pill's ✕)
   * all mean "stop carrying this", so an ✕ here that emptied the batch would be
   * the one destructive button wearing a dismiss affordance. Destroying the
   * batch is the All-comments panel's labelled Clear.
   */
  onDismiss: () => void;
}) {
  const { t } = useLingui();
  if (count === 0) return null;
  if (!attached) {
    return (
      // The leading `+` carries the state, not the border. The two chips sit in
      // the same row at different times rather than side by side, so a fill or
      // outline difference has nothing to be read against — `+` vs. the comment
      // mark is legible with no second chip to compare to, and says which way the
      // click goes. Dashed border reinforces it for anyone who reads the shape
      // before the icon.
      //
      // Detached it names the SOURCE ("Comments"), attached the CONTENT ("2
      // comments"): one is what you are about to pick up, the other what this
      // message carries, and the sibling chips already name content that way.
      // No count while detached — the chip's presence is the signal that a batch
      // is waiting, and the number only becomes a fact about this message once
      // the batch is on it.
      <Button
        type="button"
        size="sm"
        variant="ghost"
        aria-pressed={false}
        aria-label={t`Add your comments to this message`}
        onClick={onAttach}
        data-testid="composer-context-chip-comments"
        className={cn(
          'h-auto min-h-0 gap-1 rounded-md border border-dashed bg-transparent px-1.5 py-0.5',
          'text-xs font-normal text-muted-foreground hover:bg-muted/60 hover:text-foreground',
        )}
      >
        <Plus className="size-3" />
        <Trans>Comments</Trans>
      </Button>
    );
  }
  return (
    <span
      data-testid="composer-context-chip-comments"
      className={cn(
        'inline-flex items-center gap-1 rounded-md border bg-muted/60 py-0.5 pr-0.5 pl-1.5',
        'text-xs text-muted-foreground',
      )}
    >
      <Button
        type="button"
        size="sm"
        variant="ghost"
        aria-expanded={expanded}
        aria-label={expanded ? t`Hide these comments` : t`Show these comments`}
        onClick={onToggleExpanded}
        data-testid="composer-comments-peek"
        className="h-auto min-h-0 gap-1 px-0.5 py-0 text-xs font-normal text-muted-foreground hover:text-foreground"
      >
        <MessageSquare className="size-3" />
        <Plural value={count} one="# comment" other="# comments" />
        <ChevronDown className={cn('size-3 transition-transform', expanded && 'rotate-180')} />
      </Button>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        aria-label={t`Leave these comments out of this message`}
        onClick={onDismiss}
        className="size-4 p-0 text-muted-foreground hover:text-foreground"
      >
        <X className="size-3" />
      </Button>
    </span>
  );
}

/** Last path segment — the compact file label, matching the file chips. */
export function docBasename(docName: string): string {
  const slash = docName.lastIndexOf('/');
  return slash >= 0 ? docName.slice(slash + 1) : docName;
}

/**
 * `tags`, `tags[2]`, `author.name` — a property address as a human reads it.
 *
 * Mirrors the server's `describeTarget`, which builds the same string for the
 * agent prompt. Two copies rather than one over the wire because the thread
 * listing has the target already and a round trip to render a label would be
 * absurd; they are pinned together by tests on both sides.
 */
export function propertyAddress(key: string, path: readonly (string | number)[]): string {
  let out = key;
  for (const step of path) out += typeof step === 'number' ? `[${step}]` : `.${step}`;
  return out;
}

/**
 * The one line that says what a thread is ON — shared by every list that shows
 * threads (the composer peek, the queue panel, the comments panel) so the three
 * can't drift into describing the same thread differently.
 *
 * A whole property renders as `tags:` in the same monospace the quote uses. That
 * reads as the YAML it is, which distinguishes it from a passage without needing
 * a label saying "property" — and the trailing colon is the whole difference,
 * because a bare key and a short quote otherwise look identical.
 *
 * A passage inside a value shows BOTH — `description: “ships in Q3”` — because
 * neither half identifies it alone: several comments can sit on one field, and
 * the same words can appear in more than one.
 */
export function ThreadTargetLine({
  thread,
  className,
}: {
  thread: CommentThread;
  className?: string;
}) {
  const base = 'w-full truncate font-mono text-[11px] text-muted-foreground';
  const quote = thread.anchor?.quote ?? '';
  if (thread.target.kind === 'property') {
    const address = propertyAddress(thread.target.key, thread.target.path);
    return (
      <span className={cn(base, className)}>
        {address}:{quote === '' ? '' : ` “${quote}”`}
      </span>
    );
  }
  return <span className={cn(base, className)}>“{quote}”</span>;
}

/**
 * Reveal a thread wherever it lives. A passage scrolls the body to its words; a
 * property has no body range, so it opens the document and lets the properties
 * panel be where the reader looks — jumping the body to an arbitrary offset
 * would be worse than not moving at all.
 */
export function revealThread(thread: CommentThread): void {
  revealComment({
    docName: thread.docName,
    quote: thread.target.kind === 'property' ? '' : (thread.anchor?.quote ?? ''),
    threadId: thread.id,
    context: thread.anchor ?? undefined,
  });
  const { target, anchor } = thread;
  if (target.kind !== 'property' || anchor === null) return;
  // The queue spans documents, so the call above may have just navigated — the
  // property panel of the doc we are going to does not exist yet. Retry for a
  // short window rather than once, and give up quietly: a comment whose words
  // are gone from the value has nothing to select, and that is already said by
  // the card's orphaned state.
  let attempts = 0;
  const attempt = (): void => {
    const done = revealPropertyValueRange({
      key: target.key,
      path: target.path,
      quote: anchor.quote,
      start: anchor.start,
      end: anchor.end,
    });
    if (done) return;
    attempts += 1;
    if (attempts >= REVEAL_FRAME_BUDGET) return;
    requestAnimationFrame(attempt);
  };
  requestAnimationFrame(attempt);
}

/** ~half a second of frames — long enough for a doc switch, short enough to stop. */
const REVEAL_FRAME_BUDGET = 30;

/**
 * The expanded queue: one row per comment — check to include it in the next
 * send, ✕ to drop it entirely. Shows the file, the quoted passage, and what the
 * reviewer wrote, so the batch can be reviewed without leaving the composer.
 *
 * Carries `basis-full` so it drops onto its own line beneath the chip row (the
 * same mechanism the expanded selection preview uses).
 */
export function QueuedCommentsList({ threads }: { threads: readonly CommentThread[] }) {
  const { t } = useLingui();
  // USE the subscription's value — do not just call it for the side effect.
  //
  // React Compiler memoizes this component's rows on the dependencies it can
  // see. An imperative store read is not one, and a hook whose result is
  // discarded contributes no dependency — so toggling a checkbox updated the
  // store, re-ran this function, and handed back the previous rows. The checkbox
  // looked dead. Reading through `selectedIds` is what puts the selection inside
  // React's data flow, and is what the queue panel already did.
  const selectedIds = useQueueSelection();
  if (threads.length === 0) return null;
  return (
    <ul
      data-testid="composer-comments-list"
      className="mt-1 flex max-h-64 basis-full list-none flex-col gap-1 overflow-y-auto subtle-scrollbar"
    >
      {threads.map((thread) => {
        const orphaned = thread.status === 'orphaned';
        const selected = selectedIds.includes(thread.id);
        return (
          <li
            key={thread.id}
            className={cn(
              'flex items-start gap-2 rounded-md border bg-background/60 px-2 py-1.5',
              // Unchecked = not going in this send. Dim it so the row's state is
              // legible at a glance, not only from the checkbox.
              !selected && 'opacity-50',
            )}
          >
            <Checkbox
              checked={selected}
              onCheckedChange={() => toggleQueueSelection(thread.id)}
              aria-label={t`Include this comment in the next send`}
              className="mt-0.5"
            />
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <div className="flex min-w-0 items-center gap-1.5">
                {/* `min-w-0` on both the row and the chip — a flex child won't
                    compress below its content without it, so `truncate` alone
                    would still overflow. */}
                <span
                  className="inline-flex min-w-0 items-center gap-1 rounded border px-1 py-px text-[10px] text-muted-foreground"
                  title={thread.docName}
                >
                  <FileText className="size-2.5 shrink-0" />
                  <span className="truncate">{docBasename(thread.docName)}</span>
                </span>
                {orphaned && (
                  <span
                    className="inline-flex shrink-0 items-center gap-1 text-[10px] text-amber-600 dark:text-amber-500"
                    title={t`The quoted text is no longer in the document — the agent will be told.`}
                  >
                    <Unlink className="size-2.5" />
                    <Trans>gone</Trans>
                  </span>
                )}
              </div>
              {/* Click the quote/body to open that document and scroll to the
                  passage — the queue spans files, so this is how you check what
                  you're about to send. */}
              <Button
                type="button"
                variant="ghost"
                aria-label={t`Go to this comment in ${docBasename(thread.docName)}`}
                onClick={() => revealThread(thread)}
                className="h-auto min-h-0 w-full min-w-0 flex-col items-start gap-1 px-0 py-0 text-left font-normal hover:bg-transparent"
              >
                <ThreadTargetLine thread={thread} />
                <span className="line-clamp-2 w-full text-xs whitespace-normal text-foreground/90">
                  {thread.body}
                </span>
              </Button>
            </div>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              aria-label={t`Don't send this comment`}
              onClick={() => removeFromQueue(thread.id)}
              className="size-5 shrink-0 p-0 text-muted-foreground hover:text-foreground"
            >
              <X className="size-3" />
            </Button>
          </li>
        );
      })}
    </ul>
  );
}

/** One queued comment, as the composer hands it to an agent. */
export interface CommentBatchItem {
  docName: string;
  /** What the reviewer wrote on the passage. */
  body: string;
  /**
   * The addressed property — `tags`, `tags[2]`, `author.name` — or null for a
   * body passage.
   *
   * Named rather than quoted: the address IS the identity, so an agent can act
   * on it with a frontmatter patch instead of hunting for text. When `quote` is
   * also set, the comment is on a passage INSIDE that value, and both are sent:
   * the address says which field, the words say where in it.
   */
  propertyKey: string | null;
  /** The anchored passage — the durable record, not an offset. Empty for a whole value. */
  quote: string;
  /** The passage or key is no longer in the doc; say so rather than let the agent retarget. */
  anchorLost: boolean;
  /** Text immediately before the passage — only rendered when the quote repeats. */
  prefix: string;
  /** Text immediately after the passage — only rendered when the quote repeats. */
  suffix: string;
  /** The quote occurs more than once in its document. */
  repeats: boolean;
}

/**
 * Server dispatch payload → the shape the batch instruction is composed from.
 *
 * One copy, shared by every send path (the composer, the queue panel's send, the
 * append-to-open-session path, the single-thread delivery hook). They all hand
 * the same payload to the same composer, and four hand-written copies of this
 * mapping is four places for a new field to be forgotten in three of them.
 */
export function toCommentBatchItem(payload: DispatchPayload): CommentBatchItem {
  return {
    docName: payload.docName,
    body: payload.instruction,
    propertyKey: payload.property,
    // A property carries no passage; empty strings keep the shape total so the
    // composer never branches on undefined, and nothing reads them once
    // `propertyKey` is set.
    quote: payload.passage?.exact ?? '',
    anchorLost: payload.anchorLost,
    prefix: payload.passage?.prefix ?? '',
    suffix: payload.passage?.suffix ?? '',
    repeats: payload.passageRepeats,
  };
}

/** Enough context to pick the right occurrence without padding the prompt. */
const CONTEXT_CHARS = 48;

function trimTail(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trimStart();
  return flat.length > CONTEXT_CHARS ? `…${flat.slice(-CONTEXT_CHARS)}` : flat;
}

function trimHead(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trimEnd();
  return flat.length > CONTEXT_CHARS ? `${flat.slice(0, CONTEXT_CHARS)}…` : flat;
}

/**
 * Tell the agent WHICH occurrence when the quoted words appear more than once.
 *
 * The alternative — sending the stored offsets — looks precise and is worse: a
 * character offset into the markdown body is a coordinate system the agent does
 * not work in, and every offset after the first edit of a batch is wrong. The
 * surrounding text re-locates itself no matter what the agent has already
 * changed, which is the same reason the anchor is content-addressed at all.
 */
function locatingNote(item: CommentBatchItem): string | null {
  if (!item.repeats) return null;
  const before = trimTail(item.prefix);
  const after = trimHead(item.suffix);
  if (before === '' && after === '') return null;
  const where =
    before === ''
      ? `at the start of the file, followed by "${after}"`
      : after === ''
        ? `at the end of the file, preceded by "${before}"`
        : `between "${before}" and "${after}"`;
  return `(This text appears more than once in the file. The one meant is ${where} — match that context rather than the first occurrence.)`;
}

/**
 * Compose the batch into one instruction: the shared ask the reviewer typed,
 * then each comment with its document and quoted passage.
 *
 * The passages are inlined here rather than ridden as a composer `selection`
 * because a batch spans documents and the selection scope carries exactly one.
 * Each entry names its own doc so nothing is attributed to the wrong file.
 */
/**
 * A passage pinned in the composer alongside the batch, if any.
 *
 * It rides the prompt TEXT rather than the handoff's structured `selection`
 * field because a comment batch dispatches at project scope — it spans
 * documents, so no single doc leads — and `buildComposerHandoffInput` only
 * carries `selection` on a doc-scoped turn. Every comment's own quote is
 * already embedded as prose here, so one more labelled block is the same shape,
 * not a workaround.
 */
export interface ExtraPassage {
  docName: string;
  markdown: string;
}

export function composeCommentBatchInstruction(
  items: readonly CommentBatchItem[],
  sharedInstruction: string,
  passage?: ExtraPassage,
): string {
  const shared = sharedInstruction.trim();
  const lines: string[] = [];
  lines.push(
    shared.length > 0
      ? shared
      : 'Address the following review comments by editing the documents directly.',
  );
  lines.push('');
  lines.push(items.length === 1 ? 'The comment:' : `The ${items.length} comments:`);
  items.forEach((item, i) => {
    lines.push('');
    // Truthy rather than `!== null`: this field crosses the HTTP boundary, so a
    // payload from a build that predates property targets omits it entirely, and
    // `undefined` must read as "not a property" exactly as `null` does.
    if (item.propertyKey) {
      const quoted = item.quote.trim();
      // No locating note either way: an address is unique in its frontmatter,
      // and a quote inside one value has only that value to be confused with —
      // the note exists for a document-wide ambiguity that cannot arise here.
      if (quoted === '') {
        lines.push(
          `${i + 1}. In \`${item.docName}\`, on the \`${item.propertyKey}\` property (frontmatter):`,
        );
        lines.push('');
        lines.push(`   ${item.body.trim()}`);
      } else {
        // Both halves: the address says which field to patch, the blockquote says
        // which part of its text the note is about. An agent given only the words
        // would have to guess the field; given only the field, it would rewrite
        // more than was asked.
        lines.push(
          `${i + 1}. In \`${item.docName}\`, on this text within the \`${item.propertyKey}\` property (frontmatter):`,
        );
        lines.push('');
        for (const line of quoted.split('\n')) lines.push(`   > ${line}`);
        lines.push('');
        lines.push(`   ${item.body.trim()}`);
      }
      if (item.anchorLost) {
        lines.push('');
        lines.push(
          quoted === ''
            ? `   (Note: \`${item.propertyKey}\` is no longer in this document's frontmatter — it was renamed or removed since the comment was written. Do not apply this to a different property; if you cannot tell what it now refers to, say so instead of guessing.)`
            : `   (Note: that text is no longer in \`${item.propertyKey}\` — the value was edited, reshaped, or removed since the comment was written. Do not apply this to a different property or a different part of the value; if you cannot tell what it now refers to, say so instead of guessing.)`,
        );
      }
      return;
    }
    lines.push(`${i + 1}. In \`${item.docName}\`, on this passage:`);
    lines.push('');
    for (const line of item.quote.split('\n')) lines.push(`   > ${line}`);
    lines.push('');
    lines.push(`   ${item.body.trim()}`);
    const locator = locatingNote(item);
    if (locator !== null) {
      lines.push('');
      lines.push(`   ${locator}`);
    }
    if (item.anchorLost) {
      lines.push('');
      lines.push(
        '   (Note: this passage is no longer in the document — it was edited or removed since the comment was written. Do not apply this to a different passage; if you cannot tell what it now refers to, say so instead of guessing.)',
      );
    }
  });
  // Named as separate from the comments so an agent doesn't read it as a fifth
  // review item with a missing request.
  if (passage && passage.markdown.trim().length > 0) {
    lines.push('');
    lines.push(`Also in scope, selected in \`${passage.docName}\` (not a comment):`);
    lines.push('');
    for (const line of passage.markdown.trim().split('\n')) lines.push(`> ${line}`);
  }
  return lines.join('\n');
}

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

// biome-ignore-all lint/plugin/no-physical-direction-utility: pre-rule backlog — physical margin/padding/inset utilities predate the rule; drain by swapping ml/mr → ms/me, pl/pr → ps/pe, left/right → start/end, then deleting this line. See https://github.com/inkeep/open-knowledge/blob/main/biome-plugins/README.md#no-physical-direction-utilitygrit

import { Plural, Trans, useLingui } from '@lingui/react/macro';
import { MessageSquare, Plus, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import type { DispatchPayload } from './comments-client';
import { revealPropertyValueRange } from './property-row-rect';
import { revealComment } from './reveal-comment';
import { revealQueue } from './reveal-queue';
import { getThreadById, useQueueSelection } from './store';
import type { CommentThread } from './types';

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

/** A file the batch draws from, and how many of its comments are in it. */
export interface CommentDocTally {
  docName: string;
  count: number;
}

/**
 * The batch broken down by the files it spans, in queue order.
 *
 * A bare "5 comments" is honest but unreadable the moment the batch crosses
 * documents: the reader is looking at ONE file and the number counts comments
 * they cannot see, with nothing saying so. The tally is what lets the chip say
 * how far the send reaches.
 */
export function useSelectedCommentDocs(): readonly CommentDocTally[] {
  const selected = useQueueSelection();
  const byDoc = new Map<string, number>();
  for (const id of selected) {
    const docName = getThreadById(id)?.docName;
    if (docName === undefined) continue;
    byDoc.set(docName, (byDoc.get(docName) ?? 0) + 1);
  }
  return [...byDoc].map(([docName, count]) => ({ docName, count }));
}

/**
 * One chip standing for the whole batch, matching how the selection pill reads —
 * a count plus a remove control, never raw content.
 *
 * It says how many FILES the batch spans as soon as there is more than one. A
 * bare "5 comments" is honest and unreadable in that case: the reader is looking
 * at one file, the number counts comments they cannot see, and the send goes on
 * to edit documents they were not looking at. The names go in the tooltip —
 * this row is shared with the file chips and cannot grow by a path per document.
 *
 * ATTACHED IS THE DEFAULT. What is ticked in the Comments panel rides the next
 * message, and the chip states that rather than gating it: as an opt-in toggle
 * the panel's ticks meant nothing until a second, differently-shaped act in a
 * different corner of the screen, and a batch you had just built read as lost.
 * The panel is the picker; this is its read-out.
 *
 * Attached, it carries two controls, both pointing back at that picker. The
 * count opens the panel — with the peek gone, a chip naming a batch you could
 * not get to was a dead end. The ✕ takes the batch off THIS message and leaves
 * the chip as the way back; it does not touch the ticks, because "not on this
 * message" and "not a comment I want to send" are different statements and only
 * one of them is being made.
 */
export function QueuedCommentsChip({
  count,
  docs = [],
  attached,
  onAttach,
  onDismiss,
}: {
  count: number;
  /**
   * The files the batch spans. Empty is treated as "not told", which reads the
   * same as a single file — the chip degrades to the bare count rather than
   * claiming a span it has not been given.
   */
  docs?: readonly CommentDocTally[];
  /** The batch is riding this message. Detached, the chip is the way back. */
  attached: boolean;
  /** Put the batch back on this message. The ticks were never disturbed. */
  onAttach: () => void;
  /**
   * Take the batch OUT of this message — it unticks nothing and deletes nothing.
   *
   * The sibling controls in this row (a file chip's ✕, the selection pill's ✕)
   * all mean "stop carrying this", so an ✕ here that emptied the queue would be
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
      // the same slot at different times rather than side by side, so a fill or
      // outline difference has nothing to be read against — `+` vs. the comment
      // mark is legible with no second chip to compare to, and says which way
      // the click goes. Dashed border reinforces it for anyone who reads the
      // shape before the icon.
      //
      // No count here: detached, the number is not a fact about this message,
      // and the chip's presence is already the signal that a batch is waiting.
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
      {/* `revealQueue`, not a plain tab request: the batch spans documents, so
          the panel has to open on the whole queue rather than on whichever file
          happens to be in front. */}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            aria-label={t`Show these comments in the Comments panel`}
            onClick={() => revealQueue()}
            data-testid="composer-comments-open-panel"
            className="h-auto min-h-0 gap-1 px-0.5 py-0 text-xs font-normal text-muted-foreground hover:text-foreground"
          >
            <MessageSquare className="size-3" />
            {/* The file count comes with the comment count whenever the batch
                crosses documents. Reading one file, "5 comments" counts things
                the reader cannot see and nothing says so — the send then edits
                documents they were not looking at. One file needs no such
                warning, so the bare count stays for the common case. */}
            {docs.length > 1 ? (
              <Trans>
                <Plural value={count} one="# comment" other="# comments" /> across{' '}
                <Plural value={docs.length} one="# file" other="# files" />
              </Trans>
            ) : (
              <Plural value={count} one="# comment" other="# comments" />
            )}
          </Button>
        </TooltipTrigger>
        {/* The per-file breakdown, in the one place with room for it. One line
            per file, so it stays readable at ten files where a comma-joined
            sentence would not. */}
        <TooltipContent className="max-w-64">
          {docs.length > 1 ? (
            <ul className="flex flex-col gap-0.5">
              {docs.map((doc) => (
                <li key={doc.docName} className="flex items-baseline gap-1.5">
                  <span className="tabular-nums">{doc.count}</span>
                  <span className="truncate">{docBasename(doc.docName)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <Trans>Show these comments in the Comments panel</Trans>
          )}
        </TooltipContent>
      </Tooltip>
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
 * One copy, shared by every send path. They all hand the same payload to the
 * same composer, so a hand-written copy per path would be one more place for a
 * new field to be forgotten in all but one of them. Deliberately uncounted: the
 * set of send paths has changed twice already, and a number here rots silently
 * while the reason does not.
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

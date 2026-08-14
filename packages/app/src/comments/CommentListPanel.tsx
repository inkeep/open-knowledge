/**
 * The list both comment scopes render.
 *
 * "This doc" and "This project" are the same panel over different sets — same
 * cards, same checkbox, same send. One component rather than two so they cannot
 * drift into two different ideas of what a comment is; the scope only decides
 * which threads arrive and whether they are bucketed under a filename.
 *
 * The checkbox on each card IS the send list: what is ticked here is exactly
 * what the footer's button hands over. Selecting is not a per-scope idea either
 * — ticking a comment in This doc ticks the same comment in This project.
 */

import { Trans, useLingui } from '@lingui/react/macro';
import {
  CheckCheck,
  ChevronRight,
  CircleDot,
  FileText,
  FoldVertical,
  UnfoldVertical,
} from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import {
  Panel,
  PanelBody,
  PanelCount,
  PanelEmpty,
  PanelHeader,
  PanelTitle,
} from '@/components/ui/panel';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { CommentSendFooter } from './CommentSendFooter';
import { docBasename } from './comment-chips';
import { groupByDoc } from './queue-grouping';
import {
  getOpenThread,
  setSendingAll,
  subscribeFocusThread,
  subscribeOpenThread,
  useOpenThread,
  useQueueSelection,
} from './store';
import { ThreadCard } from './ThreadCard';
import type { CommentThread } from './types';

/** ~a third of a second of frames — long enough for a cold panel, short enough to stop. */
const SCROLL_FRAME_BUDGET = 20;

/** How long the ring stays on the card it was put on. */
const RING_MS = 1_600;

interface FocusHandles {
  cards: ReadonlyMap<string, HTMLElement>;
  /** The pending scroll chase, so a second open calls off the first one's. */
  frame: { current: number | null };
  /** The ring's own timer, held so it can be cancelled rather than left to fire after unmount. */
  ring: { current: number | null };
  setFocusedId: (update: (current: string | null) => string | null) => void;
}

/**
 * Bring a thread's card into view and ring it.
 *
 * The scroll is retried across a few frames rather than attempted once: opening
 * a thread is what MOUNTS this panel in the common case (clicking a highlight
 * switches the doc panel to the Comments tab), and on a cold open the threads
 * are still arriving, so the card can be a frame or two behind the request to
 * scroll to it. The ring is set immediately either way — it is state, not
 * geometry, so it lands on the card whenever the card does.
 */
function focusCard(threadId: string, handles: FocusHandles): void {
  const { cards, frame, ring, setFocusedId } = handles;
  setFocusedId(() => threadId);
  if (frame.current !== null) cancelAnimationFrame(frame.current);
  let attempts = 0;
  const attempt = (): void => {
    frame.current = null;
    const card = cards.get(threadId);
    if (card) {
      // Honours the reader's motion setting, like every other jump in this
      // subsystem (`scrollAnchorIntoView` asks the same question before it
      // scrolls the document to the passage this card is about — the two move
      // together on one click, so only one of them respecting it would be worse
      // than neither).
      const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      card.scrollIntoView({ block: 'center', behavior: reduceMotion ? 'auto' : 'smooth' });
      return;
    }
    attempts += 1;
    if (attempts >= SCROLL_FRAME_BUDGET) return;
    frame.current = requestAnimationFrame(attempt);
  };
  attempt();
  if (ring.current !== null) window.clearTimeout(ring.current);
  ring.current = window.setTimeout(() => {
    ring.current = null;
    setFocusedId((current) => (current === threadId ? null : current));
  }, RING_MS);
}

export function CommentListPanel({
  threads,
  groupByDocument = false,
  empty,
  testIdPrefix,
  scopeSwitch,
}: {
  threads: readonly CommentThread[];
  /** Project scope buckets under a filename; a single doc has nothing to bucket by. */
  groupByDocument?: boolean;
  empty: ReactNode;
  testIdPrefix: string;
  /**
   * The This-doc / This-project switch, rendered under this panel's own title.
   *
   * A slot rather than state: the scope lives in the tab, which is also what a
   * reveal retargets, while the title belongs to the panel. Passing the element
   * down is what lets the pair read title-then-switch — the order Problems uses
   * — without this component learning what a scope is.
   */
  scopeSwitch?: ReactNode;
}) {
  const { t } = useLingui();
  const [showResolved, setShowResolved] = useState(false);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const cardRefs = useRef(new Map<string, HTMLElement>());
  // Tracks what is CLOSED, not what is open, so groups mount expanded and stay
  // that way: comments are hand-written and few, and a file that appears while
  // you are reading — one posted from another window — arrives expanded like the
  // rest instead of silently landing folded because it was not in an opened-set.
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const sending = useQueueSelection();
  // The thread the reader has OPEN — washed on its card, deepened on its
  // passage in the document, so the two sides of the screen point at each
  // other. Open only, not hover: washing a card because the pointer touched it
  // (or its highlight) made every pass of the mouse a light show. One
  // subscription for the whole panel, like `sending`.
  const activeId = useOpenThread();

  function toggleFile(docName: string, open: boolean) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (open) next.delete(docName);
      else next.add(docName);
      return next;
    });
  }

  // The ring's timer and the scroll's frame are held so they can be cancelled.
  // Left dangling the timer fired after unmount, and every focus queued another
  // — clicking through ten highlights left ten timers racing to clear a ring
  // only one of them owns.
  const ringTimer = useRef<number | null>(null);
  const scrollFrame = useRef<number | null>(null);
  // Every member is stable for the life of the component — two refs, the card
  // map they are held beside, and a state setter — so this is rebuilt per call
  // rather than memoized or carried in a ref of its own.
  const focusHandles = (): FocusHandles => ({
    cards: cardRefs.current,
    frame: scrollFrame,
    ring: ringTimer,
    setFocusedId,
  });

  // Opening a thread — an in-doc highlight, a margin marker, a commented
  // property value, a queue card — brings its card here. This is the whole of
  // "show me that comment" now: the panel is where the comment is READ, so the
  // signal has to land the card in front of the reader rather than merely wash
  // it.
  //
  // BOTH halves are load-bearing, and each covers what the other cannot:
  //
  //   - the EVENT, because opening the thread that is already open is a real
  //     gesture. Scroll the panel away, click the same highlight to get back to
  //     the card: the id has not changed, so state-driven focus sees an
  //     identical snapshot, React bails out of the render, and the click does
  //     nothing at all.
  //   - the mount READ, because the open that switches the doc panel to this
  //     tab is the same open that MOUNTS this panel, and no subscription can
  //     hear the event that brought it into being.
  //
  // Reveals that do not open a thread come in on their own signal: a comment
  // whose passage is gone still has to light up when its document arrives.
  // biome-ignore lint/correctness/useExhaustiveDependencies: focusHandles closes over refs and a state setter only, all stable for the component's life; keying the effect on it would re-subscribe on every render
  useEffect(() => {
    const focus = (threadId: string) => focusCard(threadId, focusHandles());
    const pending = getOpenThread();
    if (pending !== null) focus(pending);
    const stopOpens = subscribeOpenThread((threadId) => {
      // Standing a thread down is not a request to look at anything.
      if (threadId !== null) focus(threadId);
    });
    const stopReveals = subscribeFocusThread(focus);
    return () => {
      stopOpens();
      stopReveals();
      if (ringTimer.current !== null) window.clearTimeout(ringTimer.current);
      if (scrollFrame.current !== null) cancelAnimationFrame(scrollFrame.current);
    };
  }, []);

  const active = threads.filter((thread) => thread.status !== 'resolved');
  const resolved = threads.filter((thread) => thread.status === 'resolved');
  const visible = showResolved ? threads : active;
  const groups = groupByDocument ? groupByDoc(visible) : [];
  // Every group is open when the collapsed set is empty, which is also the mount
  // state — so the one control reads "collapse all" until you have folded every
  // file yourself, and flips to "expand all" only then.
  const allCollapsed = groups.length > 0 && groups.every((g) => collapsed.has(g.docName));
  // Scoped to what this panel lists: the This-doc footer must never ship a
  // comment on a file the reader is not looking at.
  const scopedSending = active.filter((thread) => sending.includes(thread.id)).map((t) => t.id);
  // What "all" means for THIS panel — This doc must not reach across the project.
  const selectableIds = active.map((thread) => thread.id);
  const allTicked = selectableIds.length > 0 && scopedSending.length === selectableIds.length;

  /**
   * The comments under a file heading its tick can act on.
   *
   * The same set the panel-level tick uses, for the same reason: a resolved
   * comment is out of the batch entirely — the queue drops it — so counting one
   * here would put a file permanently at "some", unreachable by any number of
   * clicks, from the moment resolved comments are shown. Ticking the heading
   * would also fire queue requests for threads that cannot be queued.
   */
  function sendableIn(group: { threads: readonly CommentThread[] }): string[] {
    return group.threads
      .filter((thread) => thread.status !== 'resolved')
      .map((thread) => thread.id);
  }

  /**
   * A file heading's tick: on when every comment under it is going, mixed when
   * only some are. Mixed rather than off for a partial file — off would offer to
   * "select all" a group that is already half in, and the click would look like
   * it had done nothing to the comments already ticked.
   */
  function fileTickState(sendable: readonly string[]): boolean | 'indeterminate' {
    const ticked = sendable.filter((id) => sending.includes(id)).length;
    if (ticked === 0) return false;
    return ticked === sendable.length ? true : 'indeterminate';
  }

  function card(thread: CommentThread) {
    return (
      <ThreadCard
        key={thread.id}
        thread={thread}
        sending={sending.includes(thread.id)}
        active={activeId === thread.id}
        focused={focusedId === thread.id}
        cardRef={(el) => {
          if (el) cardRefs.current.set(thread.id, el);
          else cardRefs.current.delete(thread.id);
        }}
      />
    );
  }

  return (
    <Panel>
      <PanelHeader>
        <PanelTitle>
          <Trans>Comments</Trans>
        </PanelTitle>
        {/* The resolved tally sits ON its toggle, not in the tooltip.
            It lived in the tooltip while the toggle wore a single check: two
            bare figures in one row, alike in shape and meaning different things
            (how many are done, how many are open), and the reader had no way to
            tell which was which without hovering. The doubled check settles
            that — the number is attached to the done glyph, the count badge at
            the end of the row is the open one, and neither has to be guessed. */}
        <div className="flex items-center gap-1">
          {resolved.length > 0 && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 shrink-0 gap-1 px-1.5 text-muted-foreground"
                  // The count is INSIDE the accessible name, not just beside the
                  // glyph: an aria-label replaces a button's contents outright,
                  // so a number rendered as a child would be read by nobody.
                  aria-label={
                    showResolved
                      ? t`Hide resolved comments (${resolved.length})`
                      : t`Show resolved comments (${resolved.length})`
                  }
                  aria-pressed={showResolved}
                  data-testid={`${testIdPrefix}-resolved-toggle`}
                  onClick={() => setShowResolved((v) => !v)}
                >
                  {/* A DOUBLE check for resolved. A single one is the mark this
                      panel already uses for "ticked to send" — on every card and
                      on the select-all — so wearing it here made the one control
                      that has nothing to do with the batch look like the control
                      that governs it. The doubled form is the settled/done glyph
                      wherever read receipts and issue trackers use it, and it
                      cannot be mistaken for a tick. `CircleDot` stays: an open
                      thread is not a tick of any kind. */}
                  {showResolved ? (
                    <CircleDot aria-hidden="true" className="size-3.5" />
                  ) : (
                    <CheckCheck aria-hidden="true" className="size-3.5" />
                  )}
                  <span aria-hidden="true" className="text-[11px] tabular-nums">
                    {resolved.length}
                  </span>
                </Button>
              </TooltipTrigger>
              {/* Words only. The number is on the button now, so repeating it
                  here would print it twice a few pixels apart. */}
              <TooltipContent>
                {showResolved ? <Trans>Hide resolved</Trans> : <Trans>Show resolved</Trans>}
              </TooltipContent>
            </Tooltip>
          )}
          {/* Groups mount EXPANDED — comments are hand-written and few, so
              folding them by default would hide the panel behind a click. This
              is for the day a project has twenty files' worth; it appears only
              once there is more than one group to fold, since folding a lone
              file just empties the panel.

              Beside the count, NOT beside the title: a small glyph touching
              "Comments" reads as a control ON the panel (at this size a chevron
              pair is close enough to an ✕ to look like a close button). Over
              here it groups with the other thing that acts on the list. */}
          {groups.length > 1 && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-6 shrink-0 text-muted-foreground"
                  aria-label={allCollapsed ? t`Expand all files` : t`Collapse all files`}
                  data-testid={`${testIdPrefix}-collapse-toggle`}
                  onClick={() =>
                    setCollapsed(allCollapsed ? new Set() : new Set(groups.map((g) => g.docName)))
                  }
                >
                  {allCollapsed ? (
                    <UnfoldVertical aria-hidden="true" className="size-3.5" />
                  ) : (
                    <FoldVertical aria-hidden="true" className="size-3.5" />
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                {allCollapsed ? <Trans>Expand all files</Trans> : <Trans>Collapse all files</Trans>}
              </TooltipContent>
            </Tooltip>
          )}
          <PanelCount>{active.length}</PanelCount>
        </div>
      </PanelHeader>
      {scopeSwitch}
      {/* The bulk tick, at the head of the list rather than down in the footer
          beside the send.
          Flush to the panel's own `px-4`, which lines it up with the title above
          and the file headings below — the rows it actually sits among. Inset to
          match the per-card ticks instead, it cleared the text on both sides and
          read as indented under nothing.
          The count rides beside it, not across the row: how many are going and
          the control that changes it are one thought, and pinned to opposite
          ends they read as unrelated.
          No visible label, and no explanatory line above it either. The tick,
          the count and the Send button are one sentence read left to right; the
          aria-label carries the name for anyone not reading the layout. */}
      {active.length > 0 && (
        // No bottom padding of its own: PanelBody's `py-3` is the gap to the
        // first card, and adding one here stacked two.
        <div className="flex shrink-0 items-center gap-2 px-4">
          <Checkbox
            checked={allTicked}
            onCheckedChange={() => setSendingAll(selectableIds, !allTicked)}
            aria-label={allTicked ? t`Unmark every comment` : t`Mark every comment to send`}
            data-testid={`${testIdPrefix}-select-all`}
          />
          <span className="text-[11px] text-muted-foreground tabular-nums">
            {scopedSending.length}/{selectableIds.length}
          </span>
        </div>
      )}
      <PanelBody className="flex flex-col gap-3">
        {visible.length === 0 ? (
          <PanelEmpty>{empty}</PanelEmpty>
        ) : groupByDocument ? (
          groups.map((group) => {
            const sendable = sendableIn(group);
            const tick = fileTickState(sendable);
            return (
              <section key={group.docName} aria-label={group.docName}>
                <Collapsible
                  open={!collapsed.has(group.docName)}
                  onOpenChange={(open) => toggleFile(group.docName, open)}
                  className="flex flex-col gap-2"
                >
                  {/* The file names the group once instead of riding every card.
                      Basename, not the full path: the rail is narrow and a
                      nested path pushes the row past the panel edge; the full
                      path stays reachable as the tooltip. Not sticky —
                      PanelBody's scroll-fade mask fades whatever sits at its top
                      edge, so a pinned header would sit there half-faded.
                      The file-level tick is REVEALED, not resident. Drawn at
                      rest it sat higher and further left than the card ticks it
                      summarizes, which read as the primary control; a column of
                      them also put a checkbox on every heading of a panel whose
                      headings are otherwise just labels. On hover (and on
                      keyboard focus, which is why this is `opacity-0` rather
                      than unmounted or `hidden` — both take it out of the tab
                      order) it is there for the reader who wants a whole file at
                      once, and gone for the one who does not.
                      OUTSIDE the trigger, not inside it: a tick nested in the
                      fold control would fold the group on its way to changing
                      the batch. */}
                  <div className="group/file flex items-center gap-1.5">
                    <Checkbox
                      checked={tick}
                      // Rendered but inert for a file whose comments are all
                      // resolved — reachable only with resolved ones shown. Kept
                      // in the row rather than dropped so its heading still lines
                      // up with every other heading in the list.
                      disabled={sendable.length === 0}
                      onCheckedChange={() => setSendingAll(sendable, tick !== true)}
                      aria-label={
                        tick === true
                          ? t`Unmark every comment in ${docBasename(group.docName)}`
                          : t`Mark every comment in ${docBasename(group.docName)} to send`
                      }
                      data-testid={`${testIdPrefix}-file-select-${group.docName}`}
                      // `focus-visible`, NOT `focus-within`: a mouse click leaves
                      // the box focused, so focus-within kept it revealed after the
                      // pointer had gone — one heading stuck showing a control the
                      // others were hiding. focus-visible only matches the keyboard
                      // route, which is the one that actually needs it drawn.
                      className="opacity-0 transition-opacity focus-visible:opacity-100 group-hover/file:opacity-100"
                    />
                    <CollapsibleTrigger
                      title={group.docName}
                      className="group flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded text-left text-[11px] text-muted-foreground hover:text-foreground"
                    >
                      <FileText className="size-3 shrink-0" />
                      <span className="truncate">{docBasename(group.docName)}</span>
                      <Badge
                        variant="outline"
                        className="shrink-0 px-1 py-0 text-[10px] tabular-nums"
                      >
                        {group.threads.length}
                      </Badge>
                      <ChevronRight
                        aria-hidden="true"
                        className="size-3 shrink-0 transition-transform group-data-[state=open]:rotate-90 motion-reduce:transition-none"
                      />
                    </CollapsibleTrigger>
                  </div>
                  <CollapsibleContent className="flex flex-col gap-2 overflow-hidden data-[state=open]:animate-[collapsible-down_150ms_ease-out] data-[state=closed]:animate-[collapsible-up_150ms_ease-in] motion-reduce:animate-none">
                    {group.threads.map(card)}
                  </CollapsibleContent>
                </Collapsible>
              </section>
            );
          })
        ) : (
          visible.map(card)
        )}
      </PanelBody>
      {/* Outside PanelBody so a long list scrolls UNDER the actions rather than
          pushing them off the bottom. */}
      {active.length > 0 && (
        <CommentSendFooter threadIds={scopedSending} testIdPrefix={testIdPrefix} />
      )}
    </Panel>
  );
}

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
  Check,
  ChevronRight,
  CircleDot,
  FileText,
  FoldVertical,
  UnfoldVertical,
} from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
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
import { subscribeFocusThread, useQueueSelection } from './store';
import { ThreadCard } from './ThreadCard';
import type { CommentThread } from './types';

export function CommentListPanel({
  threads,
  groupByDocument = false,
  empty,
  testIdPrefix,
}: {
  threads: readonly CommentThread[];
  /** Project scope buckets under a filename; a single doc has nothing to bucket by. */
  groupByDocument?: boolean;
  empty: ReactNode;
  testIdPrefix: string;
}) {
  const { t } = useLingui();
  const [showResolved, setShowResolved] = useState(false);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const cardRefs = useRef(new Map<string, HTMLElement>());
  // Captured once on mount — relative timestamps don't need to tick live, and
  // calling Date.now() during render violates the React Compiler purity rule.
  const [now] = useState(() => Date.now());
  // Tracks what is CLOSED, not what is open, so groups mount expanded and stay
  // that way: comments are hand-written and few, and a file that appears while
  // you are reading — one posted from another window — arrives expanded like the
  // rest instead of silently landing folded because it was not in an opened-set.
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const sending = useQueueSelection();

  function toggleFile(docName: string, open: boolean) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (open) next.delete(docName);
      else next.add(docName);
      return next;
    });
  }

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
  const groups = groupByDocument ? groupByDoc(visible) : [];
  // Every group is open when the collapsed set is empty, which is also the mount
  // state — so the one control reads "collapse all" until you have folded every
  // file yourself, and flips to "expand all" only then.
  const allCollapsed = groups.length > 0 && groups.every((g) => collapsed.has(g.docName));
  // Scoped to what this panel lists: the This-doc footer must never ship a
  // comment on a file the reader is not looking at.
  const scopedSending = active.filter((thread) => sending.includes(thread.id)).map((t) => t.id);

  function card(thread: CommentThread) {
    return (
      <ThreadCard
        key={thread.id}
        thread={thread}
        now={now}
        sending={sending.includes(thread.id)}
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
        {/* Icons, not labels, for both controls. Spelled out, "Show resolved
            (93)" put a second number in a row that already ends in the count —
            two figures side by side that look alike and mean different things
            (how many are done vs how many are open). The resolved tally moves
            into the tooltip, where it is read on purpose rather than compared by
            accident, and the row keeps ONE number. */}
        <div className="flex items-center gap-1">
          {resolved.length > 0 && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-6 shrink-0 text-muted-foreground"
                  aria-label={showResolved ? t`Hide resolved comments` : t`Show resolved comments`}
                  aria-pressed={showResolved}
                  data-testid={`${testIdPrefix}-resolved-toggle`}
                  onClick={() => setShowResolved((v) => !v)}
                >
                  {showResolved ? (
                    <CircleDot aria-hidden="true" className="size-3.5" />
                  ) : (
                    <Check aria-hidden="true" className="size-3.5" />
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                {showResolved ? (
                  <Trans>Hide resolved</Trans>
                ) : (
                  <Trans>Show resolved ({resolved.length})</Trans>
                )}
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
      <PanelBody className="flex flex-col gap-3">
        {visible.length === 0 ? (
          <PanelEmpty>{empty}</PanelEmpty>
        ) : groupByDocument ? (
          groups.map((group) => (
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
                      No file-level tick. Selection lives on the cards and, for
                      everything at once, in the footer; a third one here
                      duplicates the card's own whenever a file holds a single
                      comment, and sits higher and further left than the control
                      it duplicates — so it reads as the primary one. */}
                <div className="flex items-center gap-1.5">
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
          ))
        ) : (
          visible.map(card)
        )}
      </PanelBody>
      {/* Outside PanelBody so a long list scrolls UNDER the actions rather than
          pushing them off the bottom. */}
      {active.length > 0 && (
        <CommentSendFooter
          threadIds={scopedSending}
          selectableIds={active.map((thread) => thread.id)}
          testIdPrefix={testIdPrefix}
        />
      )}
    </Panel>
  );
}

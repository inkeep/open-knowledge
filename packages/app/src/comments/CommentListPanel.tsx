import { Trans, useLingui } from '@lingui/react/macro';
import {
  CheckCheck,
  ChevronDown,
  CircleDot,
  FileText,
  FoldVertical,
  UnfoldVertical,
} from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
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

const SCROLL_FRAME_BUDGET = 20;

const RING_MS = 1_600;

interface FocusHandles {
  cards: ReadonlyMap<string, HTMLElement>;
  frame: { current: number | null };
  ring: { current: number | null };
  setFocusedId: (update: (current: string | null) => string | null) => void;
}

function focusCard(threadId: string, handles: FocusHandles): void {
  const { cards, frame, ring, setFocusedId } = handles;
  setFocusedId(() => threadId);
  if (frame.current !== null) cancelAnimationFrame(frame.current);
  let attempts = 0;
  const attempt = (): void => {
    frame.current = null;
    const card = cards.get(threadId);
    if (card) {
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
  groupByDocument?: boolean;
  empty: ReactNode;
  testIdPrefix: string;
  scopeSwitch?: ReactNode;
}) {
  const { t } = useLingui();
  const [showResolved, setShowResolved] = useState(false);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const cardRefs = useRef(new Map<string, HTMLElement>());
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const sending = useQueueSelection();
  const activeId = useOpenThread();

  function toggleFile(docName: string, open: boolean) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (open) next.delete(docName);
      else next.add(docName);
      return next;
    });
  }

  const ringTimer = useRef<number | null>(null);
  const scrollFrame = useRef<number | null>(null);
  const focusHandles = (): FocusHandles => ({
    cards: cardRefs.current,
    frame: scrollFrame,
    ring: ringTimer,
    setFocusedId,
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: focusHandles closes over refs and a state setter only, all stable for the component's life; keying the effect on it would re-subscribe on every render
  useEffect(() => {
    const focus = (threadId: string) => focusCard(threadId, focusHandles());
    const pending = getOpenThread();
    if (pending !== null) focus(pending);
    const stopOpens = subscribeOpenThread((threadId) => {
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
  const allCollapsed = groups.length > 0 && groups.every((g) => collapsed.has(g.docName));
  const scopedSending = active.filter((thread) => sending.includes(thread.id)).map((t) => t.id);
  const selectableIds = active.map((thread) => thread.id);
  const allTicked = selectableIds.length > 0 && scopedSending.length === selectableIds.length;

  function sendableIn(group: { threads: readonly CommentThread[] }): string[] {
    return group.threads
      .filter((thread) => thread.status !== 'resolved')
      .map((thread) => thread.id);
  }

  function fileTickState(sendable: readonly string[]): boolean | 'indeterminate' {
    const ticked = sendable.filter((id) => sending.includes(id)).length;
    if (ticked === 0) return false;
    return ticked === sendable.length ? true : 'indeterminate';
  }

  const tickState = fileTickState(selectableIds);

  function card(thread: CommentThread) {
    return (
      <ThreadCard
        key={thread.id}
        thread={thread}
        sending={sending.includes(thread.id)}
        active={activeId === thread.id}
        focused={focusedId === thread.id}
        layout={groupByDocument ? 'project' : 'doc'}
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
        <div className="flex min-w-0 items-center gap-2">
          <PanelTitle>
            <Trans>Comments</Trans>
          </PanelTitle>
          <PanelCount>{active.length}</PanelCount>
        </div>
        {}
        <div className="flex items-center gap-1">
          {resolved.length > 0 && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 shrink-0 gap-1 px-1.5 text-muted-foreground"
                  aria-label={
                    showResolved
                      ? t`Hide resolved comments (${resolved.length})`
                      : t`Show resolved comments (${resolved.length})`
                  }
                  aria-pressed={showResolved}
                  data-testid={`${testIdPrefix}-resolved-toggle`}
                  onClick={() => setShowResolved((v) => !v)}
                >
                  {}
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
              {}
              <TooltipContent>
                {showResolved ? <Trans>Hide resolved</Trans> : <Trans>Show resolved</Trans>}
              </TooltipContent>
            </Tooltip>
          )}
          {}
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
        </div>
      </PanelHeader>
      {scopeSwitch}
      {}
      <PanelBody className={groupByDocument ? 'flex flex-col gap-3' : 'flex flex-col gap-0'}>
        {visible.length === 0 ? (
          <PanelEmpty>{empty}</PanelEmpty>
        ) : groupByDocument ? (
          groups.map((group) => {
            const sendable = sendableIn(group);
            const tick = fileTickState(sendable);
            return (
              <section
                key={group.docName}
                aria-label={group.docName}
                className="shrink-0 overflow-hidden rounded-xl border"
              >
                <Collapsible
                  open={!collapsed.has(group.docName)}
                  onOpenChange={(open) => toggleFile(group.docName, open)}
                  className="group/file-card flex flex-col"
                >
                  {}
                  <div className="group/file flex items-center gap-2 border-b px-3 py-2.5 group-data-[state=closed]/file-card:border-b-0">
                    <span className="relative size-4 shrink-0">
                      {tick === false && (
                        <FileText
                          aria-hidden="true"
                          className="pointer-events-none absolute inset-0 size-4 text-muted-foreground transition-opacity group-hover/file:opacity-0 group-has-[:focus-visible]/file:opacity-0 [@media(hover:none)]:opacity-0 motion-reduce:transition-none"
                        />
                      )}
                      <Checkbox
                        checked={tick}
                        disabled={sendable.length === 0}
                        onCheckedChange={() => setSendingAll(sendable, tick !== true)}
                        aria-label={
                          tick === true
                            ? t`Unmark every comment in ${docBasename(group.docName)}`
                            : t`Mark every comment in ${docBasename(group.docName)} to send`
                        }
                        data-testid={`${testIdPrefix}-file-select-${group.docName}`}
                        className={
                          tick === false
                            ? 'absolute inset-0 opacity-0 transition-opacity group-hover/file:opacity-100 group-has-[:focus-visible]/file:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100 motion-reduce:transition-none'
                            : 'absolute inset-0'
                        }
                      />
                    </span>
                    <CollapsibleTrigger
                      title={group.docName}
                      className="group flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded text-left text-sm text-foreground"
                    >
                      <span className="min-w-0 flex-1 truncate">{docBasename(group.docName)}</span>
                      <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                        {group.threads.length}
                      </span>
                      <ChevronDown
                        aria-hidden="true"
                        className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=closed]:-rotate-90 motion-reduce:transition-none"
                      />
                    </CollapsibleTrigger>
                  </div>
                  <CollapsibleContent className="flex flex-col overflow-hidden data-[state=open]:animate-[collapsible-down_150ms_ease-out] data-[state=closed]:animate-[collapsible-up_150ms_ease-in] motion-reduce:animate-none">
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
      {}
      {active.length > 0 && (
        <CommentSendFooter
          threadIds={scopedSending}
          totalCount={selectableIds.length}
          selection={
            <Checkbox
              id={`${testIdPrefix}-select-all`}
              checked={tickState}
              onCheckedChange={() => setSendingAll(selectableIds, !allTicked)}
              aria-label={allTicked ? t`Unmark every comment` : t`Mark every comment to send`}
              data-testid={`${testIdPrefix}-select-all`}
            />
          }
          testIdPrefix={testIdPrefix}
        />
      )}
    </Panel>
  );
}

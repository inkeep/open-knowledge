/**
 * The dispatch queue as a doc-panel tab.
 *
 * Project-scoped (comments across every file), shown under the Comments tab's
 * "Queue" scope — the same batch the composer's comments chip carries. Every
 * queued comment is pre-selected; deselect any to exclude it, then Send hands
 * the checked threads to an agent and removes them (deselected ones stay for a
 * later batch).
 *
 * Cards sit under a per-file heading rather than each carrying a file badge —
 * the queue spans documents, and with several comments on the same file the
 * badge repeated the same name down the rail while stealing the width the ✕
 * needed.
 *
 * The actions sit in a pinned footer rather than after the list, so a queue of
 * twenty scrolls UNDER them instead of pushing Send off the bottom.
 */

import { Trans, useLingui } from '@lingui/react/macro';
import { FileText, X } from 'lucide-react';
import { RegisteredAgentIcon } from '@/components/acp/RegisteredAgentIcon';
import { AgentSplitButton } from '@/components/handoff/AgentSplitButton';
import { TargetIcon } from '@/components/handoff/OpenInAgentMenuItem';
import { cliIconTargetId } from '@/components/handoff/terminal-cli-display';
import { useReusableSession } from '@/components/reusable-session-store';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Panel,
  PanelBody,
  PanelCount,
  PanelEmpty,
  PanelFooter,
  PanelHeader,
  PanelTitle,
} from '@/components/ui/panel';
import { openAgentSettings } from '@/lib/use-settings-route';
import { appendQueueToOpenSession } from './append-to-open-session';
import { docBasename, revealThread, ThreadTargetLine } from './comment-chips';
import { QueueNewChatRow } from './QueueNewChatRow';
import { groupByDoc } from './queue-grouping';
import {
  clearQueue,
  dispatchComments,
  getThreadById,
  removeFromQueue,
  toggleQueueSelection,
  useQueue,
  useQueueSelection,
} from './store';
import { useCommentAgentPicker } from './use-comment-agent-picker';
import { useCommentDispatch } from './use-comment-delivery';

export function CommentQueuePanel() {
  const { t } = useLingui();
  const picker = useCommentAgentPicker();
  const composeFreshTurn = useCommentDispatch();
  const queue = useQueue();
  const selectedIds = useQueueSelection();
  const items = queue.map((id) => getThreadById(id)).filter((thread) => thread !== null);
  const selectedCount = items.filter((thread) => selectedIds.includes(thread.id)).length;
  // The send picks its own destination: a live chat takes the batch, and with
  // none open it starts one. Published by the dock itself, so the button can
  // never promise an append the host would then refuse — and not keyed on the
  // dock's position, which hosts the same sessions bottom or right.
  const openSession = useReusableSession();
  /**
   * The mark for where a send actually goes.
   *
   * Drawn from the OPEN SESSION when there is one — not from the agent
   * preference, which is what a fresh turn would use. The two disagree the
   * moment you switch tabs, and the icon claiming Claude while the button
   * points at a Cursor tab is exactly that disagreement.
   */
  const destinationIcon =
    openSession === null ? (
      picker.isThreadSelected ? (
        <RegisteredAgentIcon
          agentId={picker.threadAgent?.id ?? ''}
          iconUrl={picker.threadAgent?.iconUrl}
          className="size-4"
        />
      ) : picker.cli !== null ? (
        <TargetIcon id={cliIconTargetId(picker.cli)} className="size-4" aria-hidden />
      ) : picker.target ? (
        <TargetIcon id={picker.target.id} className="size-4" aria-hidden />
      ) : undefined
    ) : openSession.kind === 'thread' ? (
      <RegisteredAgentIcon
        agentId={openSession.agentId}
        iconUrl={openSession.iconUrl}
        className="size-4"
      />
    ) : (
      <TargetIcon id={cliIconTargetId(openSession.cli)} className="size-4" aria-hidden />
    );
  /**
   * Send to the chat that is open, or start one.
   *
   * The two halves behave differently on purpose. A fresh turn RUNS the batch,
   * so it resolves what ships. An append lands in the live session's input
   * UNSENT — a thread takes it as a staged draft, a live CLI as a
   * no-carriage-return write — so the human presses enter, nothing has shipped,
   * and the queue is left intact.
   */
  function sendQueue(): void {
    if (openSession === null) {
      // A fresh turn RUNS the batch, so it resolves what ships.
      void dispatchComments({ compose: composeFreshTurn });
      return;
    }
    // An append lands UNSENT in the live session's input, so nothing resolves —
    // the human still has to press enter.
    void appendQueueToOpenSession();
  }

  return (
    <Panel>
      <PanelHeader>
        <PanelTitle>
          <Trans>Queue</Trans>
        </PanelTitle>
        <PanelCount>{queue.length}</PanelCount>
      </PanelHeader>
      <PanelBody className="flex flex-col gap-4">
        {items.length === 0 ? (
          <PanelEmpty>
            <Trans>Nothing queued. Comment on a passage to add it here.</Trans>
          </PanelEmpty>
        ) : (
          groupByDoc(items).map((group) => (
            <section key={group.docName} aria-label={group.docName} className="flex flex-col gap-2">
              {/* The file names the group once instead of riding every card.
                  Basename, not the full path: the rail is narrow and a nested
                  path pushes the row past the panel edge; the full path stays
                  reachable as the tooltip. Not sticky — PanelBody's scroll-fade
                  mask fades whatever sits at its top edge, so a pinned header
                  would sit there half-faded. */}
              <h3
                className="flex items-center gap-1.5 text-[11px] text-muted-foreground"
                title={group.docName}
              >
                <FileText className="size-3 shrink-0" />
                <span className="truncate">{docBasename(group.docName)}</span>
                <Badge variant="outline" className="shrink-0 px-1 py-0 text-[10px] tabular-nums">
                  {group.threads.length}
                </Badge>
              </h3>
              {group.threads.map((thread) => (
                <div key={thread.id} className="flex gap-2 rounded-md border p-2">
                  <Checkbox
                    checked={selectedIds.includes(thread.id)}
                    onCheckedChange={() => toggleQueueSelection(thread.id)}
                    aria-label={t`Include in dispatch`}
                    className="mt-0.5"
                  />
                  {/* The quote + body are the jump target: click to open that
                      document and scroll to the anchored passage. The checkbox
                      and ✕ stay separate controls so selecting or removing an
                      item never navigates away from the queue. */}
                  <Button
                    type="button"
                    variant="ghost"
                    aria-label={t`Go to this comment in ${docBasename(thread.docName)}`}
                    onClick={() => revealThread(thread)}
                    className="h-auto min-h-0 min-w-0 flex-1 flex-col items-start gap-1 px-0 py-0 text-left font-normal hover:bg-transparent"
                  >
                    <ThreadTargetLine thread={thread} className="text-xs" />
                    <span className="line-clamp-2 w-full text-sm whitespace-normal text-foreground">
                      {thread.body}
                    </span>
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="size-5 shrink-0 p-0 text-muted-foreground hover:text-foreground"
                    aria-label={t`Remove from queue`}
                    onClick={() => removeFromQueue(thread.id)}
                  >
                    <X className="size-3" />
                  </Button>
                </div>
              ))}
            </section>
          ))
        )}
      </PanelBody>
      {/* Outside PanelBody so a long queue scrolls UNDER the actions rather than
          pushing them off the bottom. */}
      {items.length > 0 && (
        <PanelFooter>
          <Button size="sm" variant="ghost" className="min-w-0" onClick={clearQueue}>
            <span className="truncate">
              <Trans>Clear</Trans>
            </span>
          </Button>
          {/* The shared split button, so the agent picker here is the same
              standing preference (In app / Terminal / Configure agents) every
              other send surface uses — with the queue's own destination rows
              injected above it via `menuLeading`. */}
          <AgentSplitButton
            primary={
              <>
                {destinationIcon}
                {/* The destination is IN the button, not just the menu: this
                    batch spans documents and cannot be un-sent, so "where is
                    this going" is exactly what you check before committing, and
                    a bare "Send" never said. */}
                {/* The icon names the destination; the words say what the click
                    does. Spelling the agent out too made the button rename
                    itself on every tab switch, which reads as the control
                    changing rather than the target. */}
                <span className="truncate">
                  {openSession !== null ? (
                    <Trans>Send to chat</Trans>
                  ) : (
                    <Trans>Start a new chat</Trans>
                  )}
                </span>
              </>
            }
            onPrimary={sendQueue}
            primaryDisabled={selectedCount === 0}
            // With no chat open the button already starts one, so an override
            // row would just duplicate it — the menu is then the plain agent
            // picker it has always been.
            menuLeading={
              openSession !== null ? (
                <QueueNewChatRow
                  onStartNewChat={() => void dispatchComments({ compose: composeFreshTurn })}
                />
              ) : undefined
            }
            onOpenSettings={openAgentSettings}
            menuEmptyState={
              <p className="px-2 py-1.5 text-sm text-muted-foreground" aria-live="polite">
                {picker.probePending ? (
                  <Trans>Checking for agents</Trans>
                ) : (
                  <Trans>No agents enabled</Trans>
                )}
              </p>
            }
            triggerAriaLabel={t`Choose where to send the queue`}
            testIds={{
              primary: 'comment-queue-send',
              trigger: 'comment-queue-send-trigger',
              menu: 'comment-queue-send-menu',
              option: (id) => `comment-queue-agent-option-${id}`,
              threadAgent: (key) => `comment-queue-agent-option-thread-${key}`,
              settings: 'comment-queue-agent-option-settings',
              terminal: (cli) => `comment-queue-agent-option-terminal-${cli}`,
            }}
            {...picker.rows}
          />
        </PanelFooter>
      )}
    </Panel>
  );
}

/**
 * "Send to chat" for a panel's checked comments.
 *
 * Shared by both comment scopes so the two sides of the tab are the same
 * control on different sets: This doc sends the checked comments on the open
 * file, This project sends every checked comment across the workspace. Split out
 * rather than duplicated because the destination logic — which chat a send lands
 * in, and what the button is allowed to promise — is the part that must not
 * drift between them.
 *
 * The batch it sends is passed in, never read from the store here: the panel
 * that owns the checkboxes is the one that knows which of them are on screen.
 */

import { Trans, useLingui } from '@lingui/react/macro';
import { RegisteredAgentIcon } from '@/components/acp/RegisteredAgentIcon';
import { AgentSplitButton } from '@/components/handoff/AgentSplitButton';
import { useReusableSession } from '@/components/reusable-session-store';
import { PanelFooter } from '@/components/ui/panel';
import { formatShortcut, formatShortcutLabel } from '@/lib/keyboard-shortcuts';
import { openAgentSettings } from '@/lib/use-settings-route';
import { QueueNewChatRow } from './QueueNewChatRow';
import { dispatchComments } from './store';
import { useCommentAgentPicker } from './use-comment-agent-picker';
import { useCommentDispatch } from './use-comment-delivery';
import { useSendQueue } from './use-send-queue';

export function CommentSendFooter({
  threadIds,
  testIdPrefix,
}: {
  /** Ticked, and therefore going out — the batch this button hands over. */
  threadIds: readonly string[];
  testIdPrefix: string;
}) {
  const { t } = useLingui();
  const picker = useCommentAgentPicker();
  const composeFreshTurn = useCommentDispatch();
  // The send picks its own destination: a live chat takes the batch, and with
  // none open it starts one. Published by the dock itself, so the button can
  // never promise an append the host would then refuse — and not keyed on the
  // dock's position, which hosts the same sessions bottom or right.
  // Comments go to in-app threads, so only a THREAD counts as reusable here. A
  // live CLI tab is a session this panel will not send to, and treating it as
  // one made the button read "Send to chat" while pointing at the terminal.
  const reusableThread = useReusableSession();
  const openSession = reusableThread?.kind === 'thread' ? reusableThread : null;
  const send = useSendQueue();
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
      <RegisteredAgentIcon
        agentId={picker.threadAgent?.id ?? ''}
        iconUrl={picker.threadAgent?.iconUrl}
        className="size-4"
      />
    ) : (
      <RegisteredAgentIcon
        agentId={openSession.agentId}
        iconUrl={openSession.iconUrl}
        className="size-4"
      />
    );

  return (
    // The footer is the send alone now. The bulk tick and its count moved to the
    // head of the list, where they line up with the per-card ticks they act on.
    <PanelFooter className="justify-end">
      {/* Both scopes carry it, because the chord reads the visible scope
          (`visible-scope.ts`) and therefore sends exactly what this button
          sends. Showing it on only one scope would put a glyph beside a button
          whose click and whose key covered different sets.
          Beside the send button, not inside it. Inside, it had to be `shrink-0`
          next to a label that is deliberately `truncate` for this narrow rail,
          so the chord bought its own width by truncating the label sooner — and
          overflowed the button when it could not. As a sibling it just takes its
          place in the footer's flex row.
          A legend, not a control; `aria-hidden` is what keeps the glyphs out of
          the accessible tree — a plain span's text content IS announced, and
          `title` is only a name fallback for elements that have none. The chord
          stays reachable for screen readers through Settings → Hotkeys, which
          renders the same registry row. */}
      <div className="flex min-w-0 items-center gap-2">
        {/* `font-sans`, the same face `Kbd` uses and for the same reason: ⇧ and
            ⌘ have no glyph in the mono face, so they fell back to a symbol font
            whose metrics do not match the "Enter" typeset beside them — the
            marks sat off the baseline of their own string. `leading-none` so the
            row's `items-center` centres the glyphs rather than a box padded out
            by line-height. Still a bare span, not `Kbd`: its pill carries a
            height, min-width, padding and background, and would reshape the row
            it annotates. */}
        <span
          aria-hidden="true"
          className="shrink-0 font-sans text-xs leading-none text-muted-foreground"
          title={t`Send to chat (${formatShortcutLabel('send-comment-queue')})`}
        >
          {formatShortcut('send-comment-queue')}
        </span>
        {/* The shared split button, but with the Desktop and Terminal slots
          deliberately empty: comments always start an in-app thread, so the menu
          picks WHICH agent, never which kind of surface. Passing empty
          destination props rather than making them optional keeps the omission
          explicit at this call site — the component still renders those sections
          for every other sender. */}
        <AgentSplitButton
          installedTargets={[]}
          selectedTargetId={null}
          onSelectTarget={() => {}}
          primary={
            <>
              {destinationIcon}
              {/* The destination is IN the button, not just the menu: a batch
                cannot be un-sent, so "where is this going" is exactly what you
                check before committing, and a bare "Send" never said.
                The icon names the destination; the words say what the click
                does. Spelling the agent out too made the button rename itself on
                every tab switch, which reads as the control changing rather than
                the target. */}
              {/* Both states SEND — only where differs. The label changes
                because the destination does, not because the verb does: a chat
                you are in takes the batch as its next turn, and with none open
                one starts. */}
              <span className="truncate">
                {openSession !== null ? (
                  <Trans>Send to chat</Trans>
                ) : (
                  <Trans>Start a new chat</Trans>
                )}
              </span>
            </>
          }
          onPrimary={() => send(threadIds)}
          primaryDisabled={threadIds.length === 0}
          // With no chat open the button already starts one, so an override row
          // would just duplicate it — the menu is then the plain agent picker it
          // has always been.
          menuLeading={
            openSession !== null ? (
              <QueueNewChatRow
                onStartNewChat={() =>
                  void dispatchComments({ compose: composeFreshTurn, threadIds })
                }
              />
            ) : undefined
          }
          onOpenSettings={openAgentSettings}
          menuEmptyState={
            <p className="px-2 py-1.5 text-sm text-muted-foreground" aria-live="polite">
              <Trans>No agents enabled</Trans>
            </p>
          }
          triggerAriaLabel={t`Choose where to send these comments`}
          testIds={{
            primary: `${testIdPrefix}-send`,
            trigger: `${testIdPrefix}-send-trigger`,
            menu: `${testIdPrefix}-send-menu`,
            option: (id) => `${testIdPrefix}-agent-option-${id}`,
            threadAgent: (key) => `${testIdPrefix}-agent-option-thread-${key}`,
            settings: `${testIdPrefix}-agent-option-settings`,
            terminal: (cli) => `${testIdPrefix}-agent-option-terminal-${cli}`,
          }}
          {...picker.rows}
        />
      </div>
    </PanelFooter>
  );
}

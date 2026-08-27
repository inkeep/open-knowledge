/**
 * Per-message actions on a sent user turn: the stamp + Copy + Edit row that
 * sits under the bubble, and the editor that replaces the bubble's text when
 * Edit is pressed.
 *
 * Editing a sent message does NOT rewrite history — the transcript is the log
 * of what was actually said to the agent, and a turn the agent already answered
 * can't be un-said. Edit re-sends: the original stays where it is and the
 * revision lands as a new turn. That is also what makes "send it somewhere
 * else" coherent, since the destination thread has no such history to rewrite.
 */

import type { AttachmentPart } from '@inkeep/open-knowledge-core/acp/thread-protocol';
import { Trans, useLingui } from '@lingui/react/macro';
import { ChevronDown, Pencil } from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { useCalendarDayNow } from '@/components/acp/calendar-day-store';
import { RegisteredAgentIcon } from '@/components/acp/RegisteredAgentIcon';
import { formatSentAt } from '@/components/acp/sent-at';
import { CopyButton } from '@/components/CopyButton';
import { Button } from '@/components/ui/button';
import { ButtonGroup } from '@/components/ui/button-group';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Spinner } from '@/components/ui/spinner';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  ComposerMentionInput,
  type ComposerMentionInputHandle,
} from '@/editor/ComposerMentionInput';
import { useEnabledOverrides } from '@/lib/acp/enabled-agents';
import { enabledThreadAgents } from '@/lib/acp/launcher-selection';
import { type RegisteredAgent, useRegisteredAgents } from '@/lib/acp/registered-agents';
import { scheduleClipboardWrite } from '@/lib/share/clipboard-adapter';
import { cn } from '@/lib/utils';

/** Where a revised message goes. `this-thread` re-sends into the conversation
 *  it came from; `new-thread` starts a fresh one with the named agent. */
export type ResendTarget =
  | { kind: 'this-thread' }
  | { kind: 'new-thread'; agent: Pick<RegisteredAgent, 'source' | 'id'> };

/**
 * The stamp + actions under a sent bubble.
 *
 * Hidden until hover or focus everywhere except the newest turn: a transcript
 * is read far more often than it is acted on, and a permanent pair of icons
 * under every turn competes with the words. The newest turn is the exception
 * because sending a revision to a DIFFERENT agent is a capability nothing else
 * in the app points at — behind a hover on every turn it would go undiscovered.
 * `focus-within` is what keeps the hidden ones reachable by keyboard.
 */
export function UserMessageActions({
  text,
  sentAt,
  alwaysVisible = false,
  restoreFocus = false,
  onEdit,
}: {
  text: string;
  sentAt?: number;
  alwaysVisible?: boolean;
  /** The row is coming back because the editor it replaced just closed. Focus
   *  returns to the Edit button that opened it — otherwise the focused node
   *  unmounts, focus falls to `<body>`, and a keyboard reader restarts from
   *  the top of the transcript instead of the turn they were working on. */
  restoreFocus?: boolean;
  onEdit: () => void;
}): ReactNode {
  const { t, i18n } = useLingui();
  const now = useCalendarDayNow();
  const editRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    // `preventScroll` because sending re-engages the transcript's live edge:
    // scrolling the edited turn back into view would undo that and park the
    // reader on their own words while the reply streams off-screen.
    if (restoreFocus) editRef.current?.focus({ preventScroll: true });
  }, [restoreFocus]);

  return (
    <div
      className={cn(
        'mt-1 flex items-center justify-end gap-1 text-muted-foreground',
        alwaysVisible
          ? null
          : 'opacity-0 transition-opacity focus-within:opacity-100 group-hover/user-message:opacity-100',
      )}
      data-testid="agent-thread-user-message-actions"
    >
      {sentAt !== undefined ? (
        // `title` carries the exact instant the abbreviated stamp drops, the
        // same escape hatch the comment stamp offers.
        <time
          dateTime={new Date(sentAt).toISOString()}
          title={new Date(sentAt).toLocaleString(i18n.locale || undefined)}
          className="me-1 text-xs"
          data-testid="agent-thread-user-message-sent-at"
        >
          {formatSentAt(sentAt, now, i18n.locale || undefined)}
        </time>
      ) : null}
      {/* The shared button, not a local one: it routes through the clipboard
          adapter, which prefers the Electron IPC bridge (unconditionally
          reliable in the desktop app, where the browser API's transient-
          activation gate is not) and falls back to `execCommand` where an
          embedding host's Permissions-Policy denies `clipboard-write`. */}
      <CopyButton
        copyContent={text}
        clipboardWrite={scheduleClipboardWrite}
        size="icon-xs"
        ariaLabel={t`Copy message`}
        testId="agent-thread-user-message-copy"
      />
      {/* disableHoverableContent for the same reason as CopyButton: this
          content only echoes the button's accessible name, and its grace
          polygon would otherwise hold the tooltip open over Copy's near
          edge. */}
      <Tooltip disableHoverableContent>
        <TooltipTrigger asChild>
          <Button
            ref={editRef}
            type="button"
            size="icon-xs"
            variant="ghost"
            aria-label={t`Edit and send again`}
            onClick={onEdit}
            data-testid="agent-thread-user-message-edit"
          >
            <Pencil className="size-3.5" aria-hidden="true" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{t`Edit and send again`}</TooltipContent>
      </Tooltip>
    </div>
  );
}

/**
 * The bubble in edit mode: the message text in the same `@`-mention field the
 * composer uses, over a Cancel / Send pair.
 *
 * Send is split because the revision has two decisions in it, not one — what it
 * says, and who reads it. The primary half keeps the common case one click
 * (back into this conversation); the menu is where a revision goes to a clean
 * thread, or to a different agent, without retyping it there.
 */
export function UserMessageEditor({
  initialText,
  currentAgent,
  canSendHere,
  onCancel,
  onSend,
}: {
  initialText: string;
  /** The agent answering this thread — the "new chat" default. */
  currentAgent: { source: 'registry' | 'custom'; id: string; name: string; iconUrl?: string };
  /**
   * Whether this thread still accepts sends. False withdraws only the
   * same-thread destination — a revision handed to a fresh thread never touches
   * this one, and a crashed agent is exactly when that is worth the most.
   */
  canSendHere: boolean;
  onCancel: () => void;
  /** `chips` are `@`-mentions typed into the revision itself; the caller adds
   *  back whatever the original message carried. The field stays put until this
   *  settles; settling does NOT mean the send was acknowledged. */
  onSend: (text: string, target: ResendTarget, chips: readonly AttachmentPart[]) => Promise<void>;
}): ReactNode {
  const { t } = useLingui();
  const fieldRef = useRef<ComposerMentionInputHandle>(null);
  const [draftEmpty, setDraftEmpty] = useState(initialText.trim() === '');
  // Creating a thread takes seconds, and the field now stays open across that
  // wait. Without this, a second click reaches the launcher's dedup guard and
  // reports a collision for a send that is about to succeed.
  const [sending, setSending] = useState(false);
  const otherAgents = useOtherResendAgents(currentAgent);

  // Seed the field and put the caret AFTER the text. Plain focus lands at
  // offset 0, so an edit would open standing in front of your own sentence.
  useEffect(() => {
    fieldRef.current?.setText(initialText);
    fieldRef.current?.focusEnd();
  }, [initialText]);

  const send = (target: ResendTarget): void => {
    if (sending) return;
    const content = fieldRef.current?.getContent();
    const next = content?.instruction.trim() ?? '';
    if (next === '') return;
    setSending(true);
    void onSend(next, target, content?.attachments ?? []).finally(() => setSending(false));
  };

  const sendHere = (): void => {
    if (!canSendHere) return;
    send({ kind: 'this-thread' });
  };

  return (
    <div className="flex flex-col gap-2" data-testid="agent-thread-user-message-editor">
      <ComposerMentionInput
        ref={fieldRef}
        ariaLabel={t`Edit and send again`}
        placeholder={t`Edit and send again`}
        onEmptyChange={setDraftEmpty}
        onSubmit={sendHere}
        onEscape={onCancel}
        className="max-h-60 overflow-y-auto text-sm"
        testId="agent-thread-user-message-edit-field"
      />
      <div className="flex items-center justify-end gap-1.5">
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={onCancel}
          data-testid="agent-thread-user-message-edit-cancel"
        >
          <Trans>Cancel</Trans>
        </Button>
        <ButtonGroup>
          <Button
            type="button"
            size="sm"
            disabled={draftEmpty || !canSendHere || sending}
            aria-busy={sending}
            onClick={sendHere}
            data-testid="agent-thread-user-message-edit-send"
          >
            {sending ? (
              <>
                <Spinner className="size-3" aria-hidden="true" />
                {t`Sending…`}
              </>
            ) : (
              t`Send`
            )}
          </Button>
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                size="sm"
                disabled={draftEmpty || sending}
                aria-label={t`Choose where to send this message`}
                data-testid="agent-thread-user-message-edit-send-menu"
              >
                <ChevronDown className="size-3.5" aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              className="max-h-80 min-w-[220px]"
              data-testid="agent-thread-user-message-send-targets"
            >
              <DropdownMenuItem
                disabled={!canSendHere}
                onSelect={sendHere}
                data-testid="agent-thread-send-target-this-thread"
              >
                <span className="flex-1">
                  <Trans>Send in this chat</Trans>
                </span>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuGroup aria-label={t`Send to a new chat`}>
                <DropdownMenuLabel>
                  <Trans>Send to a new chat</Trans>
                </DropdownMenuLabel>
                <DropdownMenuItem
                  onSelect={() => send({ kind: 'new-thread', agent: currentAgent })}
                  data-testid="agent-thread-send-target-new-thread"
                >
                  <RegisteredAgentIcon
                    agentId={currentAgent.id}
                    iconUrl={currentAgent.iconUrl}
                    className="size-4"
                  />
                  <span className="flex-1 truncate">{currentAgent.name}</span>
                </DropdownMenuItem>
                {otherAgents.map((agent) => (
                  <DropdownMenuItem
                    key={`${agent.source}:${agent.id}`}
                    onSelect={() => send({ kind: 'new-thread', agent })}
                    data-testid={`agent-thread-send-target-agent-${agent.source}:${agent.id}`}
                  >
                    <RegisteredAgentIcon
                      agentId={agent.id}
                      iconUrl={agent.iconUrl}
                      className="size-4"
                    />
                    <span className="flex-1 truncate">{agent.name}</span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </ButtonGroup>
        {/* A disabled control's silent label swap is invisible to screen
            readers, so a region populating on start is what carries the news,
            mounted empty from the editor's first render so the announcement is
            not lost to a region that appears and fills in the same cycle.
            Activating Send blurs it to the body, the menu path has no focusable
            trigger to return to, and submitting with Enter never leaves the
            field — in none of the three is anything focused watching the button
            whose label just changed. */}
        <span role="status" aria-live="polite" className="sr-only">
          {sending ? t`Sending…` : null}
        </span>
      </div>
    </div>
  );
}

/**
 * The enabled in-app agents other than the one answering this thread — the rest
 * of the "new chat" menu.
 *
 * Picking one here does NOT re-register it or move the sticky default the way
 * the launcher pickers do. This is one message's destination, not a change of
 * mind about which agent you work with, and quietly repointing the composer
 * because a turn was resent elsewhere is a side effect nothing on screen
 * predicts.
 */
function useOtherResendAgents(current: {
  source: 'registry' | 'custom';
  id: string;
}): readonly RegisteredAgent[] {
  const overrides = useEnabledOverrides();
  const registeredAgents = useRegisteredAgents();
  return enabledThreadAgents(registeredAgents, overrides).filter(
    (agent) => !(agent.source === current.source && agent.id === current.id),
  );
}

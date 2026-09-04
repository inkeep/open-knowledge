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

export type ResendTarget =
  | { kind: 'this-thread' }
  | { kind: 'new-thread'; agent: Pick<RegisteredAgent, 'source' | 'id'> };

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
  restoreFocus?: boolean;
  onEdit: () => void;
}): ReactNode {
  const { t, i18n } = useLingui();
  const now = useCalendarDayNow();
  const editRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
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
        <time
          dateTime={new Date(sentAt).toISOString()}
          title={new Date(sentAt).toLocaleString(i18n.locale || undefined)}
          className="me-1 text-xs"
          data-testid="agent-thread-user-message-sent-at"
        >
          {formatSentAt(sentAt, now, i18n.locale || undefined)}
        </time>
      ) : null}
      {}
      <CopyButton
        copyContent={text}
        clipboardWrite={scheduleClipboardWrite}
        size="icon-xs"
        ariaLabel={t`Copy message`}
        testId="agent-thread-user-message-copy"
      />
      {}
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

export function UserMessageEditor({
  initialText,
  currentAgent,
  canSendHere,
  onCancel,
  onSend,
}: {
  initialText: string;
  currentAgent: { source: 'registry' | 'custom'; id: string; name: string; iconUrl?: string };
  canSendHere: boolean;
  onCancel: () => void;
  onSend: (text: string, target: ResendTarget, chips: readonly AttachmentPart[]) => Promise<void>;
}): ReactNode {
  const { t } = useLingui();
  const fieldRef = useRef<ComposerMentionInputHandle>(null);
  const [draftEmpty, setDraftEmpty] = useState(initialText.trim() === '');
  const [sending, setSending] = useState(false);
  const otherAgents = useOtherResendAgents(currentAgent);

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
        {}
        <span role="status" aria-live="polite" className="sr-only">
          {sending ? t`Sending…` : null}
        </span>
      </div>
    </div>
  );
}

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

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
  threadIds: readonly string[];
  testIdPrefix: string;
}) {
  const { t } = useLingui();
  const picker = useCommentAgentPicker();
  const composeFreshTurn = useCommentDispatch();
  const reusableThread = useReusableSession();
  const openSession = reusableThread?.kind === 'thread' ? reusableThread : null;
  const send = useSendQueue();
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
    <PanelFooter className="justify-end">
      {}
      <div className="flex min-w-0 items-center gap-2">
        {}
        <span
          aria-hidden="true"
          className="shrink-0 font-sans text-xs leading-none text-muted-foreground"
          title={t`Send to chat (${formatShortcutLabel('send-comment-queue')})`}
        >
          {formatShortcut('send-comment-queue')}
        </span>
        {}
        <AgentSplitButton
          enabledTargets={[]}
          selectedTargetId={null}
          onSelectTarget={() => {}}
          primary={
            <>
              {destinationIcon}
              {}
              {}
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

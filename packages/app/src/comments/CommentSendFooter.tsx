import { Trans, useLingui } from '@lingui/react/macro';
import type { ReactNode } from 'react';
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
  totalCount,
  selection,
  testIdPrefix,
}: {
  threadIds: readonly string[];
  totalCount: number;
  selection: ReactNode;
  testIdPrefix: string;
}) {
  const { t } = useLingui();
  const picker = useCommentAgentPicker();
  const composeFreshTurn = useCommentDispatch();
  const reusableThread = useReusableSession();
  const openSession = reusableThread?.kind === 'thread' ? reusableThread : null;
  const send = useSendQueue();
  const shortcut = formatShortcut('send-comment-queue').replace('Enter', '↵');
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
    <PanelFooter className="px-3 py-2">
      {}
      <div className="flex w-full min-w-0 flex-wrap items-center gap-2">
        <div className="flex min-w-max flex-1 items-center justify-between gap-2">
          <label
            htmlFor={`${testIdPrefix}-select-all`}
            className="flex min-w-0 cursor-pointer items-center gap-2"
          >
            {selection}
            <span className="whitespace-nowrap text-xs text-muted-foreground tabular-nums">
              <Trans>
                {threadIds.length} of {totalCount}
              </Trans>
            </span>
          </label>
          <span
            aria-hidden="true"
            className="shrink-0 font-sans text-2xs leading-none text-muted-foreground/80"
            title={
              openSession === null
                ? t`Start a new chat (${formatShortcutLabel('send-comment-queue')})`
                : t`Send to chat (${formatShortcutLabel('send-comment-queue')})`
            }
          >
            {shortcut}
          </span>
        </div>
        <AgentSplitButton
          className="ms-auto max-w-full shrink-0"
          primaryClassName="min-w-0 flex-1"
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

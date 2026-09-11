import {
  agentIdForTerminalCli,
  getAgentRecord,
  type HostSnapshot,
  TERMINAL_CLIS,
  type TerminalCli,
} from '@inkeep/open-knowledge-core';
import { useLingui } from '@lingui/react/macro';
import { TriangleAlert } from 'lucide-react';
import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  type ApplyAgentConnectionsResult,
  applyAgentConnectionIntents,
  subscribeAgentConnectionChanges,
} from '@/lib/agent-connections';
import {
  type ApplyConnections,
  ConfigureConnectionDialog,
  connectionsFromSnapshot,
  hasPairedConnectionRows,
  intentsForParts,
} from './settings/AgentConnectionDialogs';
import { deriveRowConnectionStatus } from './settings/agent-connection-status';
import { TerminalNoticeBanner } from './TerminalNoticeBanner';

export function TerminalAgentConnectionBanner({
  cli,
  onRestart,
  applyConnections = applyAgentConnectionIntents,
}: {
  cli: TerminalCli;
  onRestart: () => void;
  applyConnections?: ApplyConnections;
}) {
  const { t } = useLingui();
  const [snapshot, setSnapshot] = useState<HostSnapshot | null>(null);
  const [notConnectedDismissed, setNotConnectedDismissed] = useState(false);
  const [open, setOpen] = useState(false);
  const [readFailed, setReadFailed] = useState(false);
  const [reload, setReload] = useState(0);
  const requestVersion = useRef(0);
  const actionRef = useRef<HTMLButtonElement>(null);
  const [restartRequired, setRestartRequired] = useState(false);
  const agentId = agentIdForTerminalCli(cli);
  const { displayName } = TERMINAL_CLIS[cli];

  function receiveInstall(result: ApplyAgentConnectionsResult) {
    if (result.snapshot !== null && !result.unavailable) {
      requestVersion.current += 1;
      setSnapshot(result.snapshot);
      setReadFailed(false);
    }
    if (
      result.report.actions.some(
        (step) =>
          (step.agentId === agentId ||
            (agentId !== undefined &&
              getAgentRecord(step.agentId)
                ?.satisfiers.find((satisfier) => satisfier.id === step.satisfierId)
                ?.sharedWith.includes(agentId))) &&
          step.desired === 'present' &&
          (step.action === 'written' || step.action === 'overwritten'),
      )
    )
      setRestartRequired(true);
  }

  const receiveExternalInstall = useEffectEvent(receiveInstall);
  useEffect(() => subscribeAgentConnectionChanges(receiveExternalInstall), []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: the retry counter repeats the connection read
  useEffect(() => {
    let active = true;
    const version = ++requestVersion.current;
    void applyConnections([])
      .then((result) => {
        if (!active || requestVersion.current !== version) return;
        if (result.unavailable) return;
        setSnapshot(result.snapshot);
        setReadFailed(result.snapshot === null);
      })
      .catch(() => {
        if (active && requestVersion.current === version) setReadFailed(true);
      });
    return () => {
      active = false;
    };
  }, [applyConnections, reload]);

  if (agentId === undefined) return null;
  const connection =
    snapshot === null
      ? undefined
      : connectionsFromSnapshot(snapshot, {
          forceDetected: [agentId],
        }).find((entry) => entry.id === agentId);

  const status =
    snapshot === null
      ? null
      : deriveRowConnectionStatus({
          agentId,
          mode: 'terminal',
          snapshot,
          detected: true,
        });

  const connectionCheckFailed = readFailed || status === 'no-status';

  return (
    <>
      {connectionCheckFailed && !restartRequired ? (
        <TerminalNoticeBanner
          testId="terminal-connection-check-failed-banner"
          action={
            <Button
              size="sm"
              onClick={() => setReload((current) => current + 1)}
            >{t`Retry`}</Button>
          }
        >
          {t`Couldn't check which tools are connected.`}
        </TerminalNoticeBanner>
      ) : null}
      {status === 'not-connected' &&
      connection !== undefined &&
      !connectionCheckFailed &&
      !notConnectedDismissed &&
      !restartRequired ? (
        <TerminalNoticeBanner
          testId="terminal-readiness-banner"
          onDismiss={() => setNotConnectedDismissed(true)}
          icon={
            <TriangleAlert
              aria-hidden="true"
              className="size-4 shrink-0 text-amber-700 dark:text-amber-400"
            />
          }
          action={
            <Button ref={actionRef} size="sm" onClick={() => setOpen(true)}>
              {t`Connect tools`}
            </Button>
          }
        >
          {t`${displayName} is installed, but OpenKnowledge tools aren't connected to it yet.`}
        </TerminalNoticeBanner>
      ) : null}
      {restartRequired ? (
        <TerminalNoticeBanner
          testId="terminal-restart-banner"
          onDismiss={() => setRestartRequired(false)}
          icon={
            <TriangleAlert
              aria-hidden="true"
              className="size-4 shrink-0 text-amber-700 dark:text-amber-400"
            />
          }
          action={
            <Button ref={actionRef} size="sm" onClick={onRestart}>
              {t`Restart terminal`}
            </Button>
          }
        >
          {t`Restart this terminal session to use the newly installed OpenKnowledge tools.`}
        </TerminalNoticeBanner>
      ) : null}
      {open && connection !== undefined ? (
        <ConfigureConnectionDialog
          connection={connection}
          paired={hasPairedConnectionRows(agentId)}
          open
          onOpenChange={setOpen}
          onCloseAutoFocus={(event) => {
            if (actionRef.current !== null) {
              event.preventDefault();
              actionRef.current.focus();
            }
          }}
          onSave={async (parts, alsoRemove) => {
            const result = await applyConnections(intentsForParts(connection, parts, alsoRemove));
            receiveInstall(result);
            return result;
          }}
        />
      ) : null}
    </>
  );
}

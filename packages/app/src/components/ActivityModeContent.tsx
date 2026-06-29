import { t } from '@lingui/core/macro';
import { Plural, Trans, useLingui } from '@lingui/react/macro';
import { AlertCircle, ArrowLeft, Loader2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { withLargeFileOpenGuard } from '@/components/navigation-targets';
import { usePageList } from '@/components/PageListContext';
import { useDocumentContext, useDocumentTransition } from '@/editor/DocumentContext';
import { useActivityPanel } from '@/lib/use-activity-panel';
import { ActivityPanelFileRow } from './ActivityPanelFileRow';
import { AgentIcon } from './icons/AgentIcon';
import { Button } from './ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';


async function postAgentUndo(body: {
  connectionId: string;
  docName: string;
  scope: 'last' | 'file';
  agentName?: string;
}): Promise<void> {
  const res = await fetch('/api/agent-undo', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...body,
      agentId: body.connectionId,
    }),
  });
  if (!res.ok) {
    throw new Error(`agent-undo failed: HTTP ${res.status}`);
  }
}


function hashFromDocName(docName: string): string {
  return `#/${docName
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/')}`;
}

function navigateToDoc(docName: string): void {
  if (typeof window === 'undefined') return;
  window.location.hash = hashFromDocName(docName);
}


function LoadingState(): React.JSX.Element {
  return (
    <div
      className="flex h-full items-center justify-center p-6 text-muted-foreground"
      role="status"
      aria-busy="true"
    >
      <Loader2 className="mr-2 size-4 animate-spin" aria-hidden="true" />
      <span className="text-sm">
        <Trans>Loading agent activity</Trans>
      </span>
    </div>
  );
}

function ErrorState({ error, onRetry }: { error: string; onRetry: () => void }): React.JSX.Element {
  return (
    <div
      className="flex flex-col items-center gap-3 p-6 text-center"
      role="alert"
      data-testid="activity-panel-error"
    >
      <AlertCircle className="size-6 text-destructive" aria-hidden="true" />
      <div className="space-y-1">
        <p className="text-sm font-medium">
          <Trans>Failed to load activity</Trans>
        </p>
        <p className="text-xs text-muted-foreground">{error}</p>
      </div>
      <Button type="button" variant="outline" size="sm" onClick={onRetry}>
        <Trans>Retry</Trans>
      </Button>
    </div>
  );
}

function EmptyState(): React.JSX.Element {
  return (
    <div
      className="flex h-full items-center justify-center p-6 text-muted-foreground"
      data-testid="activity-panel-empty"
    >
      <p className="text-sm italic">
        <Trans>No edits yet.</Trans>
      </p>
    </div>
  );
}

function NoAgentSelectedState({
  onExit,
  showBackButton,
}: {
  onExit: () => void;
  showBackButton: boolean;
}): React.JSX.Element {
  const { t } = useLingui();
  return (
    <section
      className="flex h-full min-h-0 flex-col"
      data-testid="activity-panel-no-agent"
      aria-label={t`Agent activity`}
    >
      <div className="flex shrink-0 flex-row items-center gap-2 border-b border-border px-3 py-2">
        {showBackButton ? <BackToDocumentButton onClick={onExit} /> : null}
        <h2 className="truncate text-sm font-medium">
          <Trans>Agent activity</Trans>
        </h2>
      </div>
      <div className="flex flex-1 items-center justify-center p-6 text-muted-foreground">
        <p className="text-center text-sm italic">
          <Trans>Click an agent's avatar in the presence bar to view their session.</Trans>
        </p>
      </div>
    </section>
  );
}

function BackToDocumentButton({ onClick }: { onClick: () => void }): React.JSX.Element {
  const { t } = useLingui();
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7 shrink-0"
          onClick={onClick}
          aria-label={t`Back to document view`}
          data-testid="docpanel-exit-agent-mode"
        >
          <ArrowLeft />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        <Trans>Back to document view</Trans>
      </TooltipContent>
    </Tooltip>
  );
}

function SessionEndedBanner({ lastTs }: { lastTs: number | null }): React.JSX.Element {
  const [mountedAt] = useState<number>(() => Date.now());
  const ago = lastTs ? formatAgo(mountedAt - lastTs) : null;
  return (
    <div
      className="border-b border-border bg-muted/40 px-4 py-3 text-xs text-muted-foreground"
      data-testid="activity-panel-session-ended"
    >
      <span className="font-medium">
        <Trans>Session ended</Trans>
      </span>
      {ago ? <span> · {ago}</span> : null}
      <div className="mt-1 opacity-80">
        <Trans>Undo buttons are disabled — per-session state has been garbage-collected.</Trans>
      </div>
    </div>
  );
}

function formatAgo(diffMs: number): string {
  const ms = Math.max(0, diffMs);
  if (ms < 60_000) {
    const seconds = Math.round(ms / 1000);
    return t`${seconds}s ago`;
  }
  if (ms < 3_600_000) {
    const minutes = Math.round(ms / 60_000);
    return t`${minutes}m ago`;
  }
  const hours = Math.round(ms / 3_600_000);
  return t`${hours}h ago`;
}

function AgentAvatar({
  agent,
  size = 28,
}: {
  agent: { displayName: string; color: string; icon?: string };
  size?: number;
}): React.JSX.Element {
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center rounded-full text-white ring-2 ring-background"
      style={{ backgroundColor: agent.color, width: size, height: size }}
      aria-hidden="true"
    >
      <AgentIcon icon={agent.icon} width={size * 0.57} height={size * 0.57} />
    </span>
  );
}


interface ActivityModeBodyProps {
  data: ReturnType<typeof useActivityPanel>['data'];
  status: ReturnType<typeof useActivityPanel>['status'];
  error: ReturnType<typeof useActivityPanel>['error'];
  reload: () => void;
  fetchBurstDiff: (docName: string, stackIndex: number) => Promise<string>;
  onExit: () => void;
  onNavigate: (docName: string) => void;
  onUndoLast: (docName: string) => Promise<void>;
  onUndoAll: (docName: string) => Promise<void>;
  showBackButton: boolean;
}

function ActivityModeBody({
  data,
  status,
  error,
  reload,
  fetchBurstDiff,
  onExit,
  onNavigate,
  onUndoLast,
  onUndoAll,
  showBackButton,
}: ActivityModeBodyProps): React.JSX.Element {
  const { t } = useLingui();
  const lastTs = data?.files?.[0]?.lastTs ?? null;
  const fileCount = data?.files?.length ?? 0;
  return (
    <section
      className="flex h-full min-h-0 flex-col"
      data-testid="activity-panel"
      aria-label={t`Agent activity`}
    >
      <div className="flex flex-row items-center gap-2 border-b border-border px-3 py-2 shrink-0">
        {showBackButton ? <BackToDocumentButton onClick={onExit} /> : null}
        {data?.agent ? (
          <>
            <AgentAvatar agent={data.agent} />
            <div className="min-w-0 flex-1">
              <h2 className="truncate text-sm font-medium">{data.agent.displayName}</h2>
              <p className="truncate text-xs text-muted-foreground">
                {data.sessionAlive ? (
                  <Trans>Active</Trans>
                ) : lastTs !== null ? (
                  <Trans>Ended</Trans>
                ) : (
                  <Trans>No edit session yet</Trans>
                )}
                {data.files.length > 0 ? (
                  <>
                    {' · '}
                    <Plural value={fileCount} one="# file" other="# files" />
                  </>
                ) : null}
              </p>
            </div>
          </>
        ) : (
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-sm font-medium">
              <Trans>Agent activity</Trans>
            </h2>
          </div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto" data-testid="activity-panel-body">
        {status === 'loading' && data === null ? (
          <LoadingState />
        ) : status === 'error' && error ? (
          <ErrorState error={error} onRetry={reload} />
        ) : data === null ? (
          <EmptyState />
        ) : (
          <>
            {/*
              Only show "Session ended" when a session actually existed
              (lastTs !== null). Read-only agents — those that connect via
              the keepalive WS bootstrap and never invoke a write tool —
              have no session to "end"; the GC-explanation copy is
              actively misleading for them. The empty state ("No edits yet")
              is sufficient and accurate.
            */}
            {!data.sessionAlive && lastTs !== null ? <SessionEndedBanner lastTs={lastTs} /> : null}
            {data.files.length === 0 ? (
              <EmptyState />
            ) : (
              data.files.map((file) => (
                <ActivityPanelFileRow
                  key={file.docName}
                  file={file}
                  sessionAlive={data.sessionAlive}
                  isWriting={data.writingDocs.has(file.docName)}
                  onNavigate={onNavigate}
                  onUndoLast={onUndoLast}
                  onUndoAll={onUndoAll}
                  fetchBurstDiff={fetchBurstDiff}
                />
              ))
            )}
          </>
        )}
      </div>
    </section>
  );
}


export function ActivityModeContent({
  showBackButton = true,
}: {
  showBackButton?: boolean;
} = {}): React.JSX.Element {
  const { t } = useLingui();
  const { docPanelAgentId, closeActivityPanel } = useDocumentContext();
  const { openTargetTransition } = useDocumentTransition();
  const { pageMeta } = usePageList();
  const { data, status, error, reload, fetchBurstDiff } = useActivityPanel(docPanelAgentId);

  if (docPanelAgentId === null) {
    return <NoAgentSelectedState onExit={closeActivityPanel} showBackButton={showBackButton} />;
  }

  const onNavigate = (docName: string): void => {
    openTargetTransition(
      withLargeFileOpenGuard({ kind: 'doc', target: docName, docName }, pageMeta),
    );
    navigateToDoc(docName);
  };

  const onUndoLast = async (docName: string): Promise<void> => {
    try {
      await postAgentUndo({
        connectionId: docPanelAgentId,
        docName,
        scope: 'last',
        agentName: data?.agent?.displayName,
      });
      reload();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      toast.error(t`Undo failed: ${message}`);
      reload();
    }
  };

  const onUndoAll = async (docName: string): Promise<void> => {
    try {
      await postAgentUndo({
        connectionId: docPanelAgentId,
        docName,
        scope: 'file',
        agentName: data?.agent?.displayName,
      });
      toast.success(t`Undone all edits on ${docName}`);
      reload();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      toast.error(t`Undo all failed: ${message}`);
      reload();
    }
  };

  return (
    <ActivityModeBody
      data={data}
      status={status}
      error={error}
      reload={reload}
      fetchBurstDiff={fetchBurstDiff}
      onExit={closeActivityPanel}
      onNavigate={onNavigate}
      onUndoLast={onUndoLast}
      onUndoAll={onUndoAll}
      showBackButton={showBackButton}
    />
  );
}

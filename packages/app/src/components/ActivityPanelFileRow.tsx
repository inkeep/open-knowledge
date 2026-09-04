// biome-ignore-all lint/plugin/no-raw-html-interactive-element: pre-rule backlog — the filename navigate target is a raw <button> awaiting shadcn migration; tracked at https://github.com/inkeep/open-knowledge/blob/main/biome-plugins/README.md#no-raw-html-interactive-elementgrit
import { t } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import { useEffect, useState } from 'react';
import { closeAgentDiff } from '@/lib/agent-diff-store';
import type { FileData } from '@/lib/use-activity-panel';
import { ActivityPanelBurstRow } from './ActivityPanelBurstRow';

interface ActivityPanelFileRowProps {
  file: FileData;
  sessionAlive: boolean;
  isWriting: boolean;
  onNavigate: (docName: string) => void;
  onUndoDrop: (docName: string, dropCount: number) => void | Promise<void>;
  onSetVersion: (keptCount: number) => void;
}

function formatRelative(ms: number, now: number): string {
  const diff = Math.max(0, now - ms);
  if (diff < 60_000) {
    const seconds = Math.round(diff / 1000);
    return t`${seconds}s ago`;
  }
  if (diff < 3_600_000) {
    const minutes = Math.round(diff / 60_000);
    return t`${minutes}m ago`;
  }
  const hours = Math.round(diff / 3_600_000);
  return t`${hours}h ago`;
}

export function ActivityPanelFileRow({
  file,
  sessionAlive,
  isWriting,
  onNavigate,
  onUndoDrop,
  onSetVersion,
}: ActivityPanelFileRowProps): React.JSX.Element | null {
  const { t } = useLingui();
  const { docName } = file;
  const [undoInFlight, setUndoInFlight] = useState(false);
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  const editCount = file.bursts.length;

  const commitDrop = (dropCount: number): void => {
    if (dropCount <= 0 || !sessionAlive || undoInFlight) return;
    setUndoInFlight(true);
    Promise.resolve(onUndoDrop(file.docName, dropCount)).finally(() => {
      setUndoInFlight(false);
      closeAgentDiff();
    });
  };

  if (file.bursts.length === 0) return null;

  return (
    <div className="border-b border-border" data-testid="activity-panel-file-row">
      {}
      <div className="flex items-center gap-2 px-3 py-2 text-sm">
        <button
          type="button"
          onClick={() => onNavigate(file.docName)}
          className="min-w-0 flex-1 truncate text-left text-foreground hover:underline focus-visible:outline-ring"
          aria-label={t`Navigate to ${docName}`}
          data-testid="activity-panel-file-row-filename"
          title={file.docName}
        >
          {file.docName}
        </button>
        <span className="shrink-0 font-mono text-xs">
          <span className="text-green-600 dark:text-green-400">+{file.additionsTotal}</span>{' '}
          <span className="text-red-600 dark:text-red-400">−{file.deletionsTotal}</span>
        </span>
        <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
          {formatRelative(file.lastTs, now)}
        </span>
        {isWriting ? (
          <span className="shrink-0 text-[11px] text-primary animate-pulse" role="status">
            <Trans>writing</Trans>
          </span>
        ) : null}
      </div>

      {}
      <div>
        {file.bursts.map((burst) => (
          <ActivityPanelBurstRow
            key={`${file.docName}:${burst.stackIndex}`}
            burst={burst}
            docName={file.docName}
            editCount={editCount}
            sessionAlive={sessionAlive}
            inFlight={undoInFlight}
            onOpenDiff={(b) => onSetVersion(b.stackIndex + 1)}
            onRestore={commitDrop}
          />
        ))}
      </div>
    </div>
  );
}

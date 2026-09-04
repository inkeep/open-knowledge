// biome-ignore-all lint/plugin/no-raw-html-interactive-element: pre-rule backlog — the diff-open row target is a raw <button> awaiting shadcn migration; the Restore action already uses shadcn Button. Tracked at https://github.com/inkeep/open-knowledge/blob/main/biome-plugins/README.md#no-raw-html-interactive-elementgrit
// biome-ignore-all lint/plugin/no-physical-direction-utility: pre-rule backlog — physical margin/padding/inset utilities predate the rule; drain by swapping ml/mr → ms/me, pl/pr → ps/pe, left/right → start/end, then deleting this line. See https://github.com/inkeep/open-knowledge/blob/main/biome-plugins/README.md#no-physical-direction-utilitygrit

import { t } from '@lingui/core/macro';
import { Plural, Trans, useLingui } from '@lingui/react/macro';
import { Undo2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Spinner } from '@/components/ui/spinner';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useAgentDiffView } from '@/lib/agent-diff-store';
import type { BurstData } from '@/lib/use-activity-panel';

interface ActivityPanelBurstRowProps {
  burst: BurstData;
  docName: string;
  editCount: number;
  sessionAlive: boolean;
  inFlight: boolean;
  onOpenDiff: (burst: BurstData) => void;
  onRestore: (laterEdits: number) => void;
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
  const d = new Date(ms);
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function ActivityPanelBurstRow({
  burst,
  docName,
  editCount,
  sessionAlive,
  inFlight,
  onOpenDiff,
  onRestore,
}: ActivityPanelBurstRowProps): React.JSX.Element {
  const { t } = useLingui();
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);
  const [dialogOpen, setDialogOpen] = useState(false);

  const activeDiff = useAgentDiffView();
  const burstNumber = burst.stackIndex + 1;
  const isActive = activeDiff?.docName === docName && activeDiff.keptCount === burstNumber;

  const laterEdits = editCount - burstNumber;
  const restoreDisabled = !sessionAlive || inFlight || laterEdits <= 0;

  function commitRestore(): void {
    setDialogOpen(false);
    onRestore(laterEdits);
  }

  return (
    <>
      <div className="flex items-center border-t border-border/50 pr-3">
        <button
          type="button"
          onClick={() => onOpenDiff(burst)}
          aria-pressed={isActive}
          aria-label={t`View diff for edit ${burstNumber} of ${docName}`}
          data-testid="activity-panel-burst-open"
          className={[
            'flex min-w-0 flex-1 items-center gap-2 px-4 py-1.5 text-xs text-muted-foreground transition-colors',
            isActive ? 'bg-muted' : 'hover:bg-muted/40',
          ].join(' ')}
        >
          <span className="font-mono">{formatRelative(burst.ts, now)}</span>
          <span className="ml-auto font-mono">
            <span className="text-green-600 dark:text-green-400">+{burst.additions}</span>{' '}
            <span className="text-red-600 dark:text-red-400">−{burst.deletions}</span>
          </span>
        </button>
        {}
        <span aria-hidden="true" className="mx-1.5 h-3 w-px shrink-0 bg-border" />
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-6 shrink-0 text-muted-foreground hover:text-destructive"
              data-testid="activity-panel-burst-restore"
              aria-label={t`Restore to edit ${burstNumber} of ${docName}`}
              disabled={restoreDisabled}
              onClick={() => setDialogOpen(true)}
            >
              {inFlight ? (
                <Spinner className="size-3" aria-hidden="true" />
              ) : (
                <Undo2 className="size-3" aria-hidden="true" />
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="left">
            {!sessionAlive
              ? t`Session ended — undo unavailable`
              : laterEdits > 0
                ? t`Restore to this edit`
                : t`Latest edit`}
          </TooltipContent>
        </Tooltip>
      </div>

      <Dialog
        open={dialogOpen}
        onOpenChange={(next) => {
          if (!next && !inFlight) setDialogOpen(false);
          else if (next) setDialogOpen(true);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t`Undo to this edit?`}</DialogTitle>
            <DialogDescription>
              <Plural
                value={laterEdits}
                one="Removes # newer edit on this file."
                other="Removes # newer edits on this file."
              />
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              data-testid="activity-panel-burst-restore-cancel"
              onClick={() => setDialogOpen(false)}
            >
              <Trans>Cancel</Trans>
            </Button>
            <Button
              variant="destructive"
              data-testid="activity-panel-burst-restore-confirm"
              disabled={inFlight}
              onClick={commitRestore}
            >
              {inFlight ? <Spinner className="mr-2 size-4" aria-hidden="true" /> : null}
              <Trans>Undo</Trans>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

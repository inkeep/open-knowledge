// biome-ignore-all lint/plugin/no-raw-html-interactive-element: pre-rule backlog — the diff-open row target is a raw <button> awaiting shadcn migration; the Restore action already uses shadcn Button. Tracked at https://github.com/inkeep/open-knowledge/blob/main/biome-plugins/README.md#no-raw-html-interactive-elementgrit
/**
 * ActivityPanelBurstRow — one burst (StackItem) inside a file's always-expanded
 * edit list. Shows {relative timestamp, `+N −M` diff stat} and a per-row
 * Restore (↩) action, mirroring the document Timeline's per-row restore.
 *
 * Clicking the row opens the burst's diff in the main editor pane (full-pane
 * overlay, `AgentDiffPane`). The Restore action undoes every edit newer than
 * this burst on this file (i.e. restores the file to this version); it is
 * disabled on the newest burst (nothing newer to undo) and when the session has
 * ended. The row is highlighted while its diff is the one open in the pane.
 */
import { t } from '@lingui/core/macro';
import { Plural, Trans, useLingui } from '@lingui/react/macro';
import { Loader2, Undo2 } from 'lucide-react';
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
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useAgentDiffView } from '@/lib/agent-diff-store';
import type { BurstData } from '@/lib/use-activity-panel';

interface ActivityPanelBurstRowProps {
  burst: BurstData;
  docName: string;
  /** Total applied edits on this file — used to count how many are newer. */
  editCount: number;
  /** Undo unavailable (session ended). */
  sessionAlive: boolean;
  /** An undo is currently committing on this file — freezes the Restore control. */
  inFlight: boolean;
  /** Open this burst's diff in the main editor pane. */
  onOpenDiff: (burst: BurstData) => void;
  /** Restore to this burst: drop the `laterEdits` newer edits on this file. */
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
  // Older than an hour → absolute HH:MM:SS
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
  // React Compiler: `Date.now()` is impure — hoist behind useState + tick
  // every 30 s so relative-timestamp labels stay fresh without violating
  // render purity.
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);
  const [dialogOpen, setDialogOpen] = useState(false);

  // Highlight the burst whose diff is currently open in the main pane. The
  // Activity panel is scoped to a single agent, so matching on doc + burst
  // coordinate is sufficient to disambiguate. This burst's version is
  // `stackIndex + 1` (edits applied up to and including it).
  const activeDiff = useAgentDiffView();
  const burstNumber = burst.stackIndex + 1;
  const isActive = activeDiff?.docName === docName && activeDiff.keptCount === burstNumber;

  // Edits newer than this burst — exactly what restoring to this version undoes.
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
        {/* Visual separator anchors the destructive Restore action as its own region. */}
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
                <Loader2 className="size-3 animate-spin" aria-hidden="true" />
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
              {inFlight ? (
                <Loader2 className="mr-2 size-4 animate-spin" aria-hidden="true" />
              ) : null}
              <Trans>Undo</Trans>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

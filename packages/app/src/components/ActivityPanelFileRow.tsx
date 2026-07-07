// biome-ignore-all lint/plugin/no-raw-html-interactive-element: pre-rule backlog — file uses raw <button>/<input>/<textarea> awaiting shadcn migration; tracked at https://github.com/inkeep/open-knowledge/blob/main/biome-plugins/README.md#no-raw-html-interactive-elementgrit
/**
 * ActivityPanelFileRow — one file entry in the Activity Panel's scrollable
 * body. The header row is:
 *   {carrot, filename link, [↶] Undo last, [⏪] Undo all, +N −M, timestamp,
 *    optional writing indicator}.
 *
 * The two undo buttons are icon-only (`Undo2` + `Rewind` from lucide) with
 * tooltips; they live on the header row rather than the expanded-section
 * footer so per-file actions are discoverable without first expanding the
 * burst list. Carrot click toggles expand/collapse; filename click navigates
 * the main editor without closing the panel. The undo buttons
 * `stopPropagation` so clicking them doesn't also toggle the carrot.
 *
 * Expanded state renders each burst via <ActivityPanelBurstRow>.
 *
 * Undo semantics:
 *   - `[↶]` Undo last — fires immediately, no confirm (matches today).
 *   - `[⏪]` Undo all — opens a shadcn Dialog; confirm dispatches onUndoAll.
 *     Blast-radius asymmetry is intentional.
 *
 * Both buttons disabled when `sessionAlive === false` OR `bursts.length === 0`.
 * The row itself also disappears when `bursts.length === 0`.
 */
import { t } from '@lingui/core/macro';
import { Plural, Trans, useLingui } from '@lingui/react/macro';
import { ChevronDown, ChevronRight, Rewind, Undo2 } from 'lucide-react';
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
import type { FileData } from '@/lib/use-activity-panel';
import { ActivityPanelBurstRow } from './ActivityPanelBurstRow';

interface ActivityPanelFileRowProps {
  file: FileData;
  sessionAlive: boolean;
  isWriting: boolean;
  onNavigate: (docName: string) => void;
  onUndoLast: (docName: string) => void | Promise<void>;
  onUndoAll: (docName: string) => void | Promise<void>;
  fetchBurstDiff: (docName: string, stackIndex: number) => Promise<string>;
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
  onUndoLast,
  onUndoAll,
  fetchBurstDiff,
}: ActivityPanelFileRowProps): React.JSX.Element | null {
  const { t } = useLingui();
  const { docName } = file;
  const [expanded, setExpanded] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [undoInFlight, setUndoInFlight] = useState(false);
  // `Date.now()` is an impure function — calling it directly in render
  // violates React Compiler's purity contract. Seed `now` once at mount + tick
  // it every ~30 s so the relative timestamp ("15s ago") stays reasonably
  // fresh without re-rendering every frame.
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  // Empty rows disappear. Defensive guard in the component itself in case
  // the parent hasn't filtered yet (should be rare since the hook's
  // data.files is the source of truth and typically pre-filters).
  if (file.bursts.length === 0) return null;

  const disabled = !sessionAlive || file.bursts.length === 0 || undoInFlight;
  const burstCount = file.bursts.length;
  const disabledReason = !sessionAlive
    ? t`Session ended — undo unavailable`
    : file.bursts.length === 0
      ? t`Nothing to undo on this file`
      : null;

  const handleUndoLast = (e: React.MouseEvent): void => {
    e.stopPropagation();
    if (disabled) return;
    setUndoInFlight(true);
    Promise.resolve(onUndoLast(file.docName)).finally(() => setUndoInFlight(false));
  };

  const handleUndoAllClick = (e: React.MouseEvent): void => {
    e.stopPropagation();
    if (disabled) return;
    setConfirmOpen(true);
  };

  const handleUndoAllConfirm = (): void => {
    setConfirmOpen(false);
    if (disabled) return;
    setUndoInFlight(true);
    Promise.resolve(onUndoAll(file.docName)).finally(() => setUndoInFlight(false));
  };

  return (
    <div className="border-b border-border" data-testid="activity-panel-file-row">
      {/* Header row: carrot | filename | undo-last | undo-all | stat | ts | writing. */}
      <div className="flex items-center gap-2 px-3 py-2 text-sm">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex size-5 shrink-0 items-center justify-center rounded hover:bg-muted"
          aria-expanded={expanded}
          aria-label={expanded ? t`Collapse ${docName}` : t`Expand ${docName}`}
          data-testid="activity-panel-file-row-carrot"
        >
          {expanded ? (
            <ChevronDown className="size-4" aria-hidden="true" />
          ) : (
            <ChevronRight className="size-4" aria-hidden="true" />
          )}
        </button>
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
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-6 shrink-0"
              onClick={handleUndoLast}
              disabled={disabled}
              aria-label={t`Undo last edit on ${docName}`}
              data-testid="activity-panel-undo-last"
            >
              <Undo2 className="size-3.5" aria-hidden="true" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">{disabledReason ?? t`Undo last edit`}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-6 shrink-0"
              onClick={handleUndoAllClick}
              disabled={disabled}
              aria-label={t`Undo all edits on ${docName}`}
              data-testid="activity-panel-undo-all"
            >
              <Rewind className="size-3.5" aria-hidden="true" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">{disabledReason ?? t`Undo all edits`}</TooltipContent>
        </Tooltip>
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

      {expanded ? (
        <div>
          {file.bursts.map((burst) => (
            <ActivityPanelBurstRow
              key={`${file.docName}:${burst.stackIndex}`}
              burst={burst}
              docName={file.docName}
              fetchBurstDiff={fetchBurstDiff}
            />
          ))}
        </div>
      ) : null}

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              <Trans>Undo all edits on this file?</Trans>
            </DialogTitle>
            <DialogDescription>
              <Trans>
                Reverts every change this agent made to{' '}
                <span className="font-mono text-foreground">{docName}</span> this session (
                <Plural value={burstCount} one="# burst" other="# bursts" />
                ). Other files and writers are unaffected.
              </Trans>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setConfirmOpen(false)}
              data-testid="activity-panel-undo-all-cancel"
            >
              <Trans>Cancel</Trans>
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={handleUndoAllConfirm}
              data-testid="activity-panel-undo-all-confirm"
            >
              <Trans>Undo all</Trans>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

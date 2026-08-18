/**
 * The consent screen for linking one host skills folder into another: it draws
 * which folder survives, then groups everything the merge touches by what it
 * costs you — moves and duplicate drops are lossless, destroyed entries and
 * replaced deliveries are not.
 *
 * Presentational: the caller owns the write and clears `open` when it settles.
 * The confirm control is a plain Button (not AlertDialogAction) so the dialog
 * does not tear itself down before the caller's awaited work finishes, matching
 * SkillInstallConfirmDialog and DeleteConfirmationDialog.
 *
 * Direction is the thing users read backwards, so it is drawn rather than
 * described: the picked folder is on the left becoming a pointer, the surviving
 * folder on the right keeping the skills.
 */
import type { SkillFolderLinkPreview } from '@inkeep/open-knowledge-core';
import { Trans, useLingui } from '@lingui/react/macro';
import { ArrowRight, Copy, Trash2, Unlink } from 'lucide-react';
import {
  AlertDialog,
  AlertDialogBody,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';

export interface SkillFolderLinkConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The folder being consumed — it becomes the symlink. */
  pick: string;
  /** The folder that survives and keeps the skills. */
  keep: string;
  preview: SkillFolderLinkPreview;
  onConfirm: () => void;
}

/** One outcome group: icon + label + count, with the names it covers. `tone`
 *  carries whether the group costs the user anything — destructive for the two
 *  that do, muted for the duplicate drop that does not. */
function OutcomeRow({
  icon,
  label,
  detail,
  names,
  tone,
  testId,
}: {
  icon: React.ReactNode;
  label: React.ReactNode;
  detail?: React.ReactNode;
  names: readonly string[];
  tone: 'default' | 'muted' | 'destructive';
  testId: string;
}) {
  const toneClass =
    tone === 'destructive'
      ? 'text-destructive'
      : tone === 'muted'
        ? 'text-muted-foreground'
        : 'text-foreground';
  return (
    <div className="flex gap-2.5" data-testid={testId}>
      <span className={`mt-0.5 shrink-0 ${toneClass}`} aria-hidden>
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-1.5">
          <span className={`font-medium text-xs ${toneClass}`}>{label}</span>
          <span className="text-[10px] text-muted-foreground tabular-nums">{names.length}</span>
        </div>
        {detail ? <p className="text-[11px] text-muted-foreground leading-snug">{detail}</p> : null}
        <div className="mt-1 flex flex-wrap gap-x-2 gap-y-0.5">
          {names.map((n) => (
            <code key={n} className="break-all text-[11px] text-muted-foreground">
              {n}
            </code>
          ))}
        </div>
      </div>
    </div>
  );
}

export function SkillFolderLinkConfirmDialog({
  open,
  onOpenChange,
  pick,
  keep,
  preview,
  onConfirm,
}: SkillFolderLinkConfirmDialogProps) {
  const { t } = useLingui();

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            <Trans>Link these skill folders?</Trans>
          </AlertDialogTitle>
          <AlertDialogDescription>
            <Trans>Both agents end up reading everything in {keep}.</Trans>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogBody className="flex flex-col gap-4 py-1">
          {/* Direction, drawn. Reading it backwards is the mistake this
              surface keeps producing, so it leads. */}
          <div className="flex items-center gap-2" data-testid="skill-folder-link-direction">
            <div className="min-w-0 flex-1 rounded border border-border/60 px-2 py-1.5">
              <code className="block break-all font-mono text-[11px]">{pick}</code>
              <span className="text-[10px] text-muted-foreground">
                <Trans>becomes a symlink</Trans>
              </span>
            </div>
            <ArrowRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            <div className="min-w-0 flex-1 rounded border border-border/60 bg-muted/40 px-2 py-1.5">
              <code className="block break-all font-mono text-[11px]">{keep}</code>
              <span className="text-[10px] text-muted-foreground">
                <Trans>keeps the skills</Trans>
              </span>
            </div>
          </div>

          <div className="flex flex-col gap-3">
            {preview.moves.length > 0 ? (
              <OutcomeRow
                testId="skill-folder-link-moves"
                icon={<ArrowRight className="size-3.5" />}
                tone="default"
                label={<Trans>Move across</Trans>}
                names={preview.moves}
              />
            ) : null}
            {preview.drops.length > 0 ? (
              <OutcomeRow
                testId="skill-folder-link-drops"
                icon={<Copy className="size-3.5" />}
                tone="muted"
                label={<Trans>Duplicates dropped</Trans>}
                detail={t`Identical in both — ${pick} still reads them.`}
                names={preview.drops}
              />
            ) : null}
            {preview.replaces.length > 0 ? (
              <OutcomeRow
                testId="skill-folder-link-replaces"
                icon={<Unlink className="size-3.5" />}
                tone="destructive"
                label={<Trans>Skills reassigned</Trans>}
                detail={t`These currently read from another folder. After linking, they read from ${keep} instead.`}
                names={preview.replaces}
              />
            ) : null}
            {preview.removes.length > 0 ? (
              <OutcomeRow
                testId="skill-folder-link-removes"
                icon={<Trash2 className="size-3.5" />}
                tone="destructive"
                label={<Trans>Deleted for good</Trans>}
                detail={t`OK can't move these, so they go when ${pick} does.`}
                names={preview.removes}
              />
            ) : null}
          </div>
        </AlertDialogBody>
        <AlertDialogFooter>
          <AlertDialogCancel>
            <Trans>Cancel</Trans>
          </AlertDialogCancel>
          <Button onClick={onConfirm} data-testid="skill-folder-link-confirm">
            <Trans>Link folders</Trans>
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

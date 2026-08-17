/**
 * The consent screen for installing or uninstalling a built-in skill: it names
 * the skill, shows its full three-tier context cost, and lists every
 * destination path that will be written (install) or removed (uninstall) before
 * anything touches disk. Nothing is written until the user confirms — the
 * owning surface performs the install once `onConfirm` fires and closes the
 * dialog when that settles.
 *
 * Presentational: the async install/uninstall and its in-flight state belong to
 * the caller. The confirm control is a plain Button (not AlertDialogAction) so
 * the dialog does not tear itself down before the caller's awaited work settles
 * — the same reason DeleteConfirmationDialog keeps a plain Button.
 *
 * The dialog owns its `open` prop (rather than rendering content-only) because
 * it has to notice the destination set drifting underneath it: if a host
 * appears or disappears while the dialog is open, the list re-renders and the
 * next confirm click only acknowledges the fresh destinations, so the user
 * never commits a set they never read.
 */
import type { SkillCostTiers } from '@inkeep/open-knowledge-core';
import { Trans, useLingui } from '@lingui/react/macro';
import { useState } from 'react';
import { SkillCostValue } from '@/components/SkillCostValue';
import { SkillDestinationList } from '@/components/SkillDestinationList';
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

export interface SkillInstallConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: 'install' | 'uninstall';
  name: string;
  /** The skill's own frontmatter description. */
  description: string;
  /** Every destination path that will be written (install) or removed
   *  (uninstall), including declared custom roots. */
  paths: readonly string[];
  /** Full three-tier cost. Absent hides the cost block. */
  size?: SkillCostTiers;
  /** Fired when the user confirms the destination set currently shown. */
  onConfirm: () => void;
}

export function SkillInstallConfirmDialog({
  open,
  onOpenChange,
  mode,
  name,
  description,
  paths,
  size,
  onConfirm,
}: SkillInstallConfirmDialogProps) {
  const { t } = useLingui();

  // Snapshot the destinations the user has read, re-taken each time the dialog
  // opens. While open, live paths drifting from that snapshot flips
  // destinationsChanged; the first confirm click then re-acknowledges rather
  // than committing. Reset-on-open via the previous-value render pattern (not an
  // effect) so a reused dialog instance doesn't carry a stale snapshot into its
  // next open. Newline joins because a filesystem path can hold a space but not
  // a newline.
  const currentSig = paths.join('\n');
  const [ackedSig, setAckedSig] = useState(currentSig);
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setAckedSig(currentSig);
  }
  const destinationsChanged = open && currentSig !== ackedSig;

  function onPrimary() {
    if (destinationsChanged) {
      setAckedSig(currentSig);
      return;
    }
    onConfirm();
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {mode === 'install' ? t`Install ${name}` : t`Uninstall ${name}`}
          </AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogBody className="flex flex-col gap-4 py-1">
          {size ? (
            <div className="flex flex-col gap-1">
              <span className="text-xs font-medium text-muted-foreground">
                <Trans>Context cost</Trans>
              </span>
              <SkillCostValue size={size} />
            </div>
          ) : null}
          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">
              {mode === 'install' ? <Trans>Installs to</Trans> : <Trans>Removes from</Trans>}
            </span>
            <SkillDestinationList paths={paths} />
          </div>
          {destinationsChanged ? (
            <p
              role="status"
              className="text-xs text-amber-600 dark:text-amber-500"
              data-testid="skill-destinations-changed"
            >
              <Trans>The destinations changed. Review the list, then confirm.</Trans>
            </p>
          ) : null}
        </AlertDialogBody>
        <AlertDialogFooter>
          <AlertDialogCancel>
            <Trans>Cancel</Trans>
          </AlertDialogCancel>
          <Button
            variant={mode === 'uninstall' ? 'destructive' : 'default'}
            onClick={onPrimary}
            data-testid="skill-confirm-primary"
          >
            {mode === 'install' ? <Trans>Install</Trans> : <Trans>Uninstall</Trans>}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

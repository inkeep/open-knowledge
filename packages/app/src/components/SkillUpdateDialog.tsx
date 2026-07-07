/**
 * SkillUpdateDialog — confirm refreshing a starter-pack skill from OK's bundled
 * source. The update REPLACES the current content; the server checkpoints the
 * doc first, so the pre-update version is recoverable from version history. The
 * confirmation names both (replaces edits / restorable) so the choice is informed.
 */
import type { SkillsListEntry } from '@inkeep/open-knowledge-core';
import { Trans, useLingui } from '@lingui/react/macro';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  DialogBody,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  Dialog as DialogRoot,
  DialogTitle,
} from '@/components/ui/dialog';
import { skillDisplayName } from '@/lib/skill-scope';
import { updatePackSkill } from '@/lib/skills-api';

interface Props {
  /** The pack skill to update; `null` keeps the dialog closed. */
  skill: SkillsListEntry | null;
  onOpenChange: (open: boolean) => void;
  /** Called after a successful update so the parent re-fetches. */
  onUpdated: () => void;
}

export function SkillUpdateDialog({ skill, onOpenChange, onUpdated }: Props) {
  const { t } = useLingui();
  const [updating, setUpdating] = useState(false);

  async function handleUpdate(target: SkillsListEntry) {
    setUpdating(true);
    const result = await updatePackSkill({ scope: target.scope, name: target.name });
    setUpdating(false);
    const display = skillDisplayName(target.name);
    if (!result.ok) {
      toast.error(t`Couldn't update skill: ${result.error}`);
      return;
    }
    // The pre-update content is checkpointed server-side — name the restore path
    // so a user who didn't mean to lose edits knows where to recover them.
    toast.success(
      result.checkpointRef
        ? t`Updated "${display}" to ${result.version} — your previous version is in history if you need to restore it.`
        : t`Updated "${display}" to ${result.version}.`,
    );
    onUpdated();
    onOpenChange(false);
  }

  return (
    <DialogRoot
      open={skill !== null}
      onOpenChange={(open) => {
        if (!open && !updating) onOpenChange(false);
      }}
    >
      {skill ? (
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>
              <Trans>Update "{skillDisplayName(skill.name)}"?</Trans>
            </DialogTitle>
            <DialogDescription>
              {skill.installedVersion ? (
                <Trans>
                  This replaces the current skill content with the bundled version{' '}
                  {skill.bundledVersion ?? ''} (you have {skill.installedVersion}). Any local edits
                  will be replaced — your current version is saved to history first, so you can
                  restore it.
                </Trans>
              ) : (
                <Trans>
                  This replaces the current skill content with the bundled version{' '}
                  {skill.bundledVersion ?? ''}. Any local edits will be replaced — your current
                  version is saved to history first, so you can restore it.
                </Trans>
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogBody />
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline" disabled={updating}>
                <Trans>Cancel</Trans>
              </Button>
            </DialogClose>
            <Button onClick={() => void handleUpdate(skill)} disabled={updating}>
              {updating ? <Trans>Updating</Trans> : <Trans>Update</Trans>}
            </Button>
          </DialogFooter>
        </DialogContent>
      ) : null}
    </DialogRoot>
  );
}

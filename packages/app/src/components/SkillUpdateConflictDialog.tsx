import { Trans } from '@lingui/react/macro';
import { DiffView } from '@/components/DiffView';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

/**
 * Confirm-diff shown when Update would overwrite a locally-modified skill. Renders
 * the user's current SKILL.md body against the incoming upstream (read-only reuse
 * of `DiffView`), then lets them Take upstream (apply, discarding local edits —
 * recoverable from version history) or Keep mine (cancel). Only opened when the
 * skill is modified AND upstream changed; a clean skill updates without this gate.
 */
export function SkillUpdateConflictDialog({
  open,
  onOpenChange,
  skillName,
  localBody,
  upstreamBody,
  applying,
  onTakeUpstream,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  skillName: string;
  localBody: string;
  upstreamBody: string;
  applying: boolean;
  onTakeUpstream: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] max-w-3xl flex-col">
        <DialogHeader>
          <DialogTitle>
            <Trans>Update "{skillName}" over your edits?</Trans>
          </DialogTitle>
          <DialogDescription>
            <Trans>
              You edited this skill locally and the source has new changes. Taking upstream replaces
              your version; your edits stay recoverable in version history.
            </Trans>
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="min-h-0 flex-1 overflow-auto">
          {/* old = your current body, new = incoming upstream. */}
          <DiffView oldContent={localBody} newContent={upstreamBody} layout="unified" />
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={applying}>
            <Trans>Keep mine</Trans>
          </Button>
          <Button onClick={onTakeUpstream} disabled={applying}>
            {applying ? <Trans>Updating</Trans> : <Trans>Take upstream</Trans>}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

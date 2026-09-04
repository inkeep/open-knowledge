import { Trans } from '@lingui/react/macro';
import { MultiFileDiff } from '@pierre/diffs/react';
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
import { okPierreTheme } from '@/lib/pierre-theme';

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
      {}
      <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-5xl">
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
          {}
          <MultiFileDiff
            className="conflict-view"
            oldFile={{ name: skillName, contents: localBody }}
            newFile={{ name: skillName, contents: upstreamBody }}
            options={{ overflow: 'wrap', diffStyle: 'unified', theme: okPierreTheme() }}
          />
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

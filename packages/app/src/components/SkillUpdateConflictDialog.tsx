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

/**
 * Confirm-diff shown when Update would overwrite a locally-modified skill. Renders
 * the user's current SKILL.md body against the incoming upstream (read-only
 * `MultiFileDiff`), then lets them Take upstream (apply, discarding local edits —
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
      {/* Side-by-side diff of two prose bodies: at the dialog base width the
          columns are narrow enough that a single sentence wraps over four
          lines and the two sides stop being comparable at a glance. The `sm:`
          prefix is required to beat DialogContent's own `sm:max-w-sm`. */}
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
          {/* old = your current body, new = incoming upstream.
              `diffStyle` is explicit because Pierre's diff renderer defaults to
              `split`, which would put two narrow columns of wrapped prose side
              by side. Unified also matches the conflict surface, whose renderer
              hardcodes unified and cannot be switched. */}
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

import type { SkillScope } from '@inkeep/open-knowledge-core';
import { Trans } from '@lingui/react/macro';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useMoveSkillScope } from '@/hooks/use-move-skill-scope';
import { useSkillScopeLabels } from '@/lib/skill-scope';

export interface SkillScopeMoveTarget {
  scope: SkillScope;
  name: string;
  toScope: SkillScope;
}

/**
 * The confirm-before-move dialog for a skill scope change (project ↔ global),
 * shared by the toolbar level control (`useSkillScopeMove`) and the sidebar
 * three-dot menu (§9.5). Target-driven so it can be mounted by a stable parent
 * (`useSkillActions.dialogs`) independent of any menu that unmounts on select.
 * Moving relocates files on disk + re-installs into your editors, so it never
 * commits on open — only on the explicit Move button.
 */
export function SkillScopeMoveDialog({
  target,
  onOpenChange,
}: {
  target: SkillScopeMoveTarget | null;
  onOpenChange: (open: boolean) => void;
}) {
  const scopeLabels = useSkillScopeLabels();
  const moveScope = useMoveSkillScope();
  const [moving, setMoving] = useState(false);
  if (!target) return null;
  const { scope, name, toScope } = target;

  return (
    <Dialog open onOpenChange={(open) => !open && !moving && onOpenChange(false)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            <Trans>Move to {scopeLabels[toScope]}?</Trans>
          </DialogTitle>
          <DialogDescription>
            <Trans>
              This moves <code className="font-mono">{name}</code> from {scopeLabels[scope]} to{' '}
              {scopeLabels[toScope]}, relocating its files on disk and re-installing it in your
              editors at the {scopeLabels[toScope]} level.
            </Trans>
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline" disabled={moving}>
              <Trans>Cancel</Trans>
            </Button>
          </DialogClose>
          <Button
            data-testid="skill-scope-move-confirm"
            disabled={moving}
            onClick={async () => {
              setMoving(true);
              await moveScope({ scope, name }, toScope);
              setMoving(false);
              onOpenChange(false);
            }}
          >
            <Trans>Move</Trans>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

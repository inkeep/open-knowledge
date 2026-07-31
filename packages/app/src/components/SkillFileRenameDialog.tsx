import type { SkillsListEntry } from '@inkeep/open-knowledge-core';
import { Trans, useLingui } from '@lingui/react/macro';
import { useEffect, useId, useState } from 'react';
import { toast } from 'sonner';
import { useManagedArtifactRetarget } from '@/components/ManagedArtifactProperties';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { isValidBundleFilePath } from '@/lib/skill-bundle-paths';
import { renameSkillFile } from '@/lib/skills-api';

export interface SkillFileRenameTarget {
  skill: SkillsListEntry;
  filePath: string;
}

/**
 * Rename/move ONE bundle file (§8.9). The field holds the full bundle-relative
 * path, so a rename and a move-between-subdirs are the same edit
 * (`references/a.md` → `references/deep/a.md`). The server enforces the
 * allowlist + containment + never-overwrite; a project `.md` reference's open
 * tab retargets to the moved doc.
 */
export function SkillFileRenameDialog({
  target,
  onOpenChange,
}: {
  target: SkillFileRenameTarget | null;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useLingui();
  const retarget = useManagedArtifactRetarget();
  const inputId = useId();
  const [path, setPath] = useState('');
  const [saving, setSaving] = useState(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: re-seed only when the target changes, not on every keystroke.
  useEffect(() => {
    if (target) setPath(target.filePath);
  }, [target?.skill.scope, target?.skill.name, target?.filePath]);

  if (!target) return null;

  const trimmed = path.trim();
  const unchanged = trimmed === target.filePath;
  const invalid = trimmed === '' || !isValidBundleFilePath(trimmed);
  const canSave = !invalid && !unchanged && !saving;

  async function submit() {
    if (!target || !canSave) return;
    setSaving(true);
    const result = await renameSkillFile({
      scope: target.skill.scope,
      name: target.skill.name,
      from: target.filePath,
      to: trimmed,
    });
    setSaving(false);
    if (!result.ok) {
      toast.error(t`Rename failed: ${result.error}`);
      return;
    }
    if (result.fromDocName !== undefined && result.toDocName !== undefined) {
      retarget(result.fromDocName, result.toDocName);
    }
    toast.success(t`Renamed to ${result.to}`);
    onOpenChange(false);
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !saving) onOpenChange(false);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            <Trans>Rename file</Trans>
          </DialogTitle>
          <DialogDescription>
            <Trans>
              Move or rename this file inside the skill — the path stays under references/ or
              scripts/.
            </Trans>
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor={inputId}>
            <Trans>Path</Trans>
          </Label>
          <Input
            id={inputId}
            value={path}
            onChange={(e) => setPath(e.target.value)}
            aria-invalid={invalid && trimmed !== ''}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submit();
            }}
          />
          {invalid && trimmed !== '' ? (
            <p className="text-destructive text-xs">
              <Trans>
                Use a relative path inside the skill (no .., no spaces; SKILL.md is managed).
              </Trans>
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            <Trans>Cancel</Trans>
          </Button>
          <Button onClick={() => void submit()} disabled={!canSave}>
            {saving ? <Trans>Renaming</Trans> : <Trans>Rename</Trans>}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

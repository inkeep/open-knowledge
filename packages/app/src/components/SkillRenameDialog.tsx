import { SKILL_NAME_REGEX, type SkillsListEntry } from '@inkeep/open-knowledge-core';
import { Trans, useLingui } from '@lingui/react/macro';
import { useEffect, useId, useState } from 'react';
import { toast } from 'sonner';
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
import { moveSkill } from '@/lib/skills-api';

interface Props {
  /** The skill to rename; `null` keeps the dialog closed. */
  skill: SkillsListEntry | null;
  /** Existing names in this skill's scope, for the collision check. */
  existingNames: ReadonlySet<string>;
  onOpenChange: (open: boolean) => void;
  /** Called after a successful rename with the new name. */
  onRenamed?: (name: string) => void;
}

/**
 * Rename a skill. Thin wrapper over `moveSkill` (the same POST `/api/skill`
 * rename the editor's name field uses) with the shared `SKILL_NAME_REGEX` +
 * collision validation, so a skill can be renamed from its row without opening
 * the editor — mirroring the file row's Rename.
 */
export function SkillRenameDialog({ skill, existingNames, onOpenChange, onRenamed }: Props) {
  const { t } = useLingui();
  const open = skill !== null;
  const inputId = useId();
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);

  // Seed the field from the skill each time the dialog opens for a new target.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-seed only when the target skill changes, not on every keystroke.
  useEffect(() => {
    if (skill) setName(skill.name);
  }, [skill?.scope, skill?.name]);

  if (!skill) return null;

  const trimmed = name.trim();
  const unchanged = trimmed === skill.name;
  const invalid = trimmed === '' || !SKILL_NAME_REGEX.test(trimmed);
  const collides = !invalid && !unchanged && existingNames.has(trimmed);
  const canSave = !invalid && !collides && !unchanged && !saving;

  async function submit() {
    if (!skill || !canSave) return;
    setSaving(true);
    const result = await moveSkill({ scope: skill.scope, fromName: skill.name, toName: trimmed });
    setSaving(false);
    if (!result.ok) {
      toast.error(t`Couldn't rename "${skill.name}": ${result.error}`);
      return;
    }
    toast.success(t`Renamed to "${trimmed}"`);
    onRenamed?.(trimmed);
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? null : onOpenChange(false))}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            <Trans>Rename skill</Trans>
          </DialogTitle>
          <DialogDescription>
            <Trans>Renames the folder on disk and the id agents use to invoke it.</Trans>
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor={inputId}>
            <Trans>Name</Trans>
          </Label>
          <Input
            id={inputId}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submit();
            }}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            aria-invalid={invalid || collides}
            aria-describedby={
              (invalid && trimmed !== '') || collides ? `${inputId}-error` : undefined
            }
            className="font-mono"
          />
          {invalid && trimmed !== '' ? (
            <p id={`${inputId}-error`} className="text-xs text-destructive">
              <Trans>
                Use lowercase letters, digits, and <code className="font-mono">-</code> only.
              </Trans>
            </p>
          ) : collides ? (
            <p id={`${inputId}-error`} className="text-xs text-destructive">
              <Trans>A skill with that name already exists.</Trans>
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>
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

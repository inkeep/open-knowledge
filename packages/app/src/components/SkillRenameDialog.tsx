import { SKILL_NAME_REGEX, type SkillsListEntry } from '@inkeep/open-knowledge-core';
import { Trans } from '@lingui/react/macro';
import { useEffect, useId, useState } from 'react';
import { useRenameSkill } from '@/components/ManagedArtifactProperties';
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
  const renameSkill = useRenameSkill();
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
  // A space is the most common mistake, so message it explicitly (§12.9); the
  // 64-char cap is also enforced by the input's maxLength (§12.10).
  const hasSpace = /\s/.test(name);
  const tooLong = trimmed.length > 64;
  const invalid = trimmed === '' || !SKILL_NAME_REGEX.test(trimmed) || tooLong;
  const collides = !invalid && !unchanged && existingNames.has(trimmed);
  const canSave = !invalid && !collides && !unchanged && !saving;

  async function submit() {
    if (!skill || !canSave) return;
    setSaving(true);
    // Shared flow: POST the move, toast, AND retarget the open tab. Before this the
    // dialog only did the move + toast, so renaming the skill you were viewing left
    // the tab stranded on the deleted source doc.
    const result = await renameSkill({ scope: skill.scope, name: skill.name }, trimmed);
    setSaving(false);
    if (!result.ok) return; // the shared hook already surfaced the error toast
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
            maxLength={64}
            aria-invalid={invalid || collides}
            aria-describedby={
              (invalid && trimmed !== '') || collides ? `${inputId}-error` : undefined
            }
            className="font-mono"
          />
          {invalid && trimmed !== '' ? (
            <p id={`${inputId}-error`} className="text-xs text-destructive">
              {hasSpace ? (
                <Trans>
                  No spaces — use <code className="font-mono">-</code> instead.
                </Trans>
              ) : tooLong ? (
                <Trans>Keep the name to 64 characters or fewer.</Trans>
              ) : (
                <Trans>
                  Use lowercase letters, digits, and <code className="font-mono">-</code> only.
                </Trans>
              )}
            </p>
          ) : collides ? (
            <p id={`${inputId}-error`} className="text-xs text-destructive">
              <Trans>A skill with that name already exists.</Trans>
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            className="font-mono uppercase"
            onClick={() => onOpenChange(false)}
            disabled={saving}
          >
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

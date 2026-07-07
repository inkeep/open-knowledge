import { SKILL_NAME_REGEX, type SkillScope } from '@inkeep/open-knowledge-core';
import { Trans, useLingui } from '@lingui/react/macro';
import { useId, useState } from 'react';
import { toast } from 'sonner';
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
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { useSkills } from '@/hooks/use-skills';
import { SKILL_SCOPE_ORDER, skillNameSetsByScope, useSkillScopeLabels } from '@/lib/skill-scope';
import { saveSkill } from '@/lib/skills-api';

interface Props {
  defaultScope: SkillScope;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called after a successful create with the new skill's scope + name. */
  onCreated: (created: { scope: SkillScope; name: string }) => void;
}

/**
 * Create a new skill: pick a scope (Project vs Global), name it, describe it.
 * On create the `SKILL.md` is written and the caller opens it as an editor tab —
 * the live CRDT editor takes over from there (body + description edits are CRDT
 * mutations). Nothing is written until Create, so there are no orphaned drafts.
 */
export function NewSkillDialog({ defaultScope, open, onOpenChange, onCreated }: Props) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        {open ? (
          <Body defaultScope={defaultScope} onOpenChange={onOpenChange} onCreated={onCreated} />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function Body({
  defaultScope,
  onOpenChange,
  onCreated,
}: {
  defaultScope: SkillScope;
  onOpenChange: (open: boolean) => void;
  onCreated: (created: { scope: SkillScope; name: string }) => void;
}) {
  const { t } = useLingui();
  const nameId = useId();
  const descriptionId = useId();
  const scopeId = useId();
  const scopeLabels = useSkillScopeLabels();
  const skillsState = useSkills();
  const nameSets = skillNameSetsByScope(skillsState.status === 'ready' ? skillsState.data : []);

  const [scope, setScope] = useState<SkillScope>(defaultScope);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [touched, setTouched] = useState(false);
  const [creating, setCreating] = useState(false);

  const trimmedName = name.trim();
  const nameInvalid = trimmedName === '' || !SKILL_NAME_REGEX.test(trimmedName);
  const nameCollides = !nameInvalid && nameSets[scope].has(trimmedName);
  const canCreate = !creating && !nameInvalid && !nameCollides;

  // Lenient sanitize while TYPING: lowercase, illegal-char runs → a single
  // hyphen, collapse hyphen runs, trim only LEADING hyphens. Trailing hyphens
  // are kept so a hyphenated name (`image-location`) can be typed at all — the
  // `-` is momentarily trailing as you type it, and trimming it on every
  // keystroke (the old behavior) made hyphens impossible to enter. A trailing
  // hyphen is trimmed on blur.
  function sanitizeNameInput(text: string): string {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/-{2,}/g, '-')
      .replace(/^-+/, '');
  }

  async function create() {
    if (!canCreate) {
      setTouched(true);
      return;
    }
    setCreating(true);
    const result = await saveSkill({
      scope,
      name: trimmedName,
      frontmatter: { name: trimmedName, description: description.trim() },
      body: '',
    });
    setCreating(false);
    if (!result.ok) {
      toast.error(t`Couldn't create skill: ${result.error}`);
      return;
    }
    toast.success(t`Skill "${trimmedName}" created`);
    onCreated({ scope, name: trimmedName });
    onOpenChange(false);
  }

  const showNameError = touched && (nameInvalid || nameCollides);

  return (
    <>
      <DialogHeader>
        <DialogTitle>
          <Trans>New skill</Trans>
        </DialogTitle>
        <DialogDescription>
          <Trans>Teach agents a repeatable task. You can edit the body after creating.</Trans>
        </DialogDescription>
      </DialogHeader>
      <DialogBody className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={scopeId}>
            <Trans>Scope</Trans>
          </Label>
          <Select value={scope} onValueChange={(v) => setScope(v as SkillScope)}>
            <SelectTrigger id={scopeId} size="sm" className="w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SKILL_SCOPE_ORDER.map((s) => (
                <SelectItem key={s} value={s}>
                  {scopeLabels[s]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={nameId}>
            <Trans>Name</Trans>
          </Label>
          <Input
            id={nameId}
            data-testid="skill-name-input"
            value={name}
            onChange={(e) => setName(sanitizeNameInput(e.target.value))}
            onBlur={() => {
              setTouched(true);
              setName((n) => n.replace(/-+$/, ''));
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void create();
            }}
            aria-invalid={showNameError}
            className="font-mono"
          />
          {showNameError ? (
            <p className="text-[11px] text-destructive">
              {nameCollides ? (
                <Trans>A skill with this name already exists.</Trans>
              ) : (
                <Trans>Use lowercase letters, digits, and hyphens only.</Trans>
              )}
            </p>
          ) : (
            <p className="text-[11px] text-muted-foreground">
              <Trans>The folder on disk and the id agents use to invoke this skill.</Trans>
            </p>
          )}
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={descriptionId}>
            <Trans>Description</Trans>
          </Label>
          <Textarea
            id={descriptionId}
            data-testid="skill-description-input"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            className="min-h-16 resize-none"
          />
          <p className="text-[11px] text-muted-foreground">
            <Trans>What agents match on to decide when to use the skill.</Trans>
          </p>
        </div>
      </DialogBody>
      <DialogFooter>
        <Button
          variant="outline"
          className="font-mono uppercase"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onOpenChange(false)}
          disabled={creating}
        >
          <Trans>Cancel</Trans>
        </Button>
        <Button
          data-testid="skill-create-button"
          onClick={() => void create()}
          disabled={!canCreate}
        >
          {creating ? <Trans>Creating</Trans> : <Trans>Create skill</Trans>}
        </Button>
      </DialogFooter>
    </>
  );
}

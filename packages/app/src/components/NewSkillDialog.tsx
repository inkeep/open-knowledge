import { SKILL_NAME_REGEX, type SkillScope } from '@inkeep/open-knowledge-core';
import { Trans, useLingui } from '@lingui/react/macro';
import { useEffect, useId, useRef, useState } from 'react';
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
import { Textarea } from '@/components/ui/textarea';
import { DEFAULT_NEW_SKILL_DESCRIPTION } from '@/hooks/use-create-blank-skill';

export function NewSkillDialog({
  open,
  onOpenChange,
  scope,
  existingNames,
  busy,
  onCreate,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  scope: SkillScope;
  existingNames: ReadonlySet<string>;
  busy: boolean;
  onCreate: (input: { name: string; description: string }) => void;
}) {
  const { t } = useLingui();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string | null>(null);
  const nameId = useId();
  const descriptionId = useId();
  const errorId = useId();
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    let next = 'new-skill';
    for (let i = 2; existingNames.has(next); i++) next = `new-skill-${i}`;
    setName(next);
    setDescription(DEFAULT_NEW_SKILL_DESCRIPTION);
    setError(null);
  }, [open, existingNames]);

  function validationError(candidate: string): string | null {
    const trimmed = candidate.trim();
    if (!trimmed) return t`Name cannot be empty`;
    if (!SKILL_NAME_REGEX.test(trimmed)) return t`Use lowercase letters, numbers, and hyphens only`;
    if (existingNames.has(trimmed)) return t`A skill named "${trimmed}" already exists here`;
    return null;
  }

  function submit() {
    const trimmed = name.trim();
    const err = validationError(trimmed);
    if (err) {
      setError(err);
      nameRef.current?.focus();
      return;
    }
    onCreate({ name: trimmed, description: description.trim() || DEFAULT_NEW_SKILL_DESCRIPTION });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            <Trans>New skill</Trans>
          </DialogTitle>
          <DialogDescription>
            {scope === 'global' ? (
              <Trans>Create a personal skill, available across every project.</Trans>
            ) : (
              <Trans>Create a skill for this project.</Trans>
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          <div className="flex flex-col gap-2">
            <label className="text-sm font-medium" htmlFor={nameId}>
              <Trans>Name</Trans>
            </label>
            <Input
              ref={nameRef}
              id={nameId}
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setError(null);
              }}
              placeholder="my-skill"
              autoFocus
              onFocus={(e) => e.currentTarget.select()}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? errorId : undefined}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !busy) {
                  e.preventDefault();
                  submit();
                }
              }}
            />
            {error ? (
              <p id={errorId} role="alert" className="text-1sm text-destructive">
                {error}
              </p>
            ) : null}
          </div>
          <div className="flex flex-col gap-2">
            <label className="text-sm font-medium" htmlFor={descriptionId}>
              <Trans>Description</Trans>
            </label>
            <Textarea
              id={descriptionId}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              placeholder={DEFAULT_NEW_SKILL_DESCRIPTION}
            />
            <p className="text-2xs text-muted-foreground">
              <Trans>Tells agents when to reach for this skill. You can edit it later.</Trans>
            </p>
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            <Trans>Cancel</Trans>
          </Button>
          <Button onClick={submit} disabled={busy || !name.trim()}>
            {busy ? <Trans>Creating</Trans> : <Trans>Create</Trans>}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

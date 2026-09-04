import type { SkillsListEntry } from '@inkeep/open-knowledge-core';
import { t } from '@lingui/core/macro';
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
import { useDocumentContext } from '@/editor/DocumentContext';
import { skillEntryFileLiveDocName } from '@/lib/managed-artifact-doc-name';
import { isValidBundleFilePath } from '@/lib/skill-bundle-paths';
import { writeSkillFile } from '@/lib/skills-api';

export interface SkillFileCreateTarget {
  skill: SkillsListEntry;
  prefix?: string;
}

function bundlePathProblem(trimmed: string): string | null {
  if (/\s/.test(trimmed)) return t`Spaces aren't allowed in the path`;
  const segments = trimmed.split('/');
  if (segments.some((seg) => seg === '.' || seg === '..'))
    return t`The path can't leave the skill (no . or ..)`;
  if (segments.some((seg) => seg === '')) return t`Empty folder names aren't allowed (//)`;
  if (segments.length === 1 && trimmed.toLowerCase() === 'skill.md')
    return t`SKILL.md is managed by the skill itself — pick another name`;
  if (!isValidBundleFilePath(trimmed)) return t`Use a relative path inside the skill`;
  return null;
}

export function SkillFileCreateDialog({
  target,
  onOpenChange,
}: {
  target: SkillFileCreateTarget | null;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useLingui();
  const { openTarget } = useDocumentContext();
  const inputId = useId();
  const [path, setPath] = useState('');
  const [saving, setSaving] = useState(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: re-seed only when the target changes, not on every keystroke.
  useEffect(() => {
    if (target) setPath(target.prefix ?? 'references/');
  }, [target?.skill.scope, target?.skill.name, target?.prefix]);

  if (!target) return null;

  const trimmed = path.trim();
  const incomplete = trimmed === '' || trimmed.endsWith('/');
  const problem = incomplete ? null : bundlePathProblem(trimmed);
  const invalid = incomplete || problem !== null;
  const canSave = !invalid && !saving;
  const folderPart = trimmed.includes('/') ? trimmed.split('/').slice(0, -1).join('/') : null;

  const basename = trimmed.split('/').pop() ?? '';
  const effective = basename !== '' && !basename.includes('.') ? `${trimmed}.md` : trimmed;

  async function submit() {
    if (!target || !canSave) return;
    setSaving(true);
    const isMd = /\.mdx?$/i.test(effective);
    const result = await writeSkillFile({
      scope: target.skill.scope,
      name: target.skill.name,
      path: effective,
      content: isMd
        ? `# ${
            effective
              .split('/')
              .pop()
              ?.replace(/\.mdx?$/i, '') ?? ''
          }\n`
        : '',
    });
    setSaving(false);
    if (!result.ok) {
      toast.error(t`Couldn't create ${effective}: ${result.error}`);
      return;
    }
    toast.success(t`Created ${result.path}`);
    if (isMd) {
      const docName = skillEntryFileLiveDocName(target.skill, effective);
      openTarget({ kind: 'doc', target: docName, docName });
    }
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
            <Trans>New skill file</Trans>
          </DialogTitle>
          <DialogDescription>
            <Trans>
              A path inside the skill — any folder works (e.g. references/notes.md). Folders in the
              path are created for you.
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
            placeholder="references/notes.md"
            aria-invalid={problem !== null}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submit();
            }}
          />
          {problem !== null ? (
            <p className="text-destructive text-xs">{problem}</p>
          ) : incomplete && trimmed !== '' ? (
            <p className="text-muted-foreground text-xs">
              <Trans>Add a file name (e.g. notes.md)</Trans>
            </p>
          ) : effective !== trimmed ? (
            <p className="text-muted-foreground text-xs">
              <Trans>
                Will be created as <span className="font-mono text-foreground/80">{effective}</span>
              </Trans>
            </p>
          ) : folderPart ? (
            <p className="text-muted-foreground text-xs">
              <Trans>
                Creates the <span className="font-mono text-foreground/80">{folderPart}/</span>{' '}
                folder
              </Trans>
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            <Trans>Cancel</Trans>
          </Button>
          <Button onClick={() => void submit()} disabled={!canSave}>
            {saving ? <Trans>Creating</Trans> : <Trans>Create</Trans>}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

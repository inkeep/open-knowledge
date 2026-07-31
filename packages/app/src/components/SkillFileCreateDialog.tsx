import type { SkillsListEntry } from '@inkeep/open-knowledge-core';
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
  /** Seed prefix for the path field (`references/` by default; a dir row seeds
   *  its own path). */
  prefix?: string;
}

/**
 * Create a new bundle file inside a skill (§7 follow-up). The field holds the
 * full bundle-relative path, so nested folders come free — `references/deep/x.md`
 * creates `deep/` on write (the server mkdirs parents). Markdown lands as a
 * live editable doc and opens immediately; anything else (scripts, text
 * fixtures) is written fs-direct.
 */
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
  const invalid = trimmed === '' || !isValidBundleFilePath(trimmed);
  const canSave = !invalid && !saving;
  // When the path nests, name the folder(s) that'll be created so the implicit
  // mkdir is honest rather than a surprise.
  const folderPart = trimmed.includes('/') ? trimmed.split('/').slice(0, -1).join('/') : null;

  async function submit() {
    if (!target || !canSave) return;
    setSaving(true);
    const isMd = /\.mdx?$/i.test(trimmed);
    const result = await writeSkillFile({
      scope: target.skill.scope,
      name: target.skill.name,
      path: trimmed,
      content: isMd
        ? `# ${
            trimmed
              .split('/')
              .pop()
              ?.replace(/\.mdx?$/i, '') ?? ''
          }\n`
        : '',
    });
    setSaving(false);
    if (!result.ok) {
      toast.error(t`Couldn't create ${trimmed}: ${result.error}`);
      return;
    }
    toast.success(t`Created ${result.path}`);
    // Markdown references open as live editable docs right away.
    if (isMd) {
      const docName = skillEntryFileLiveDocName(target.skill, trimmed);
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

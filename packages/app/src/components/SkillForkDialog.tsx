import { SKILL_NAME_REGEX, type SkillsListEntry } from '@inkeep/open-knowledge-core';
import { Trans, useLingui } from '@lingui/react/macro';
import { MultiFileDiff } from '@pierre/diffs/react';
import { useEffect, useId, useState } from 'react';
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
import { okPierreTheme } from '@/lib/pierre-theme';
import { skillHostRootDir } from '@/lib/skill-scope';
import { fetchSkillPreview, resolveSkillFork } from '@/lib/skills-api';

export interface SkillForkTarget {
  skill: SkillsListEntry;
  editor: string;
}

export function SkillForkDialog({
  target,
  onOpenChange,
}: {
  target: SkillForkTarget | null;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useLingui();
  const inputId = useId();
  const [forkBody, setForkBody] = useState<string | null>(null);
  const [canonicalBody, setCanonicalBody] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [toName, setToName] = useState('');
  const [busy, setBusy] = useState(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reload only when the target identity changes
  useEffect(() => {
    setForkBody(null);
    setCanonicalBody(null);
    setPreviewError(false);
    setRenaming(false);
    if (!target) return;
    const { skill, editor } = target;
    const base = skill.absolutePath?.slice(0, -`/${skill.path}`.length) ?? null;
    if (base === null) {
      setPreviewError(true);
      return;
    }
    const canonicalDir = `${base}/${skill.path.replace(/\/SKILL\.mdx?$/i, '')}`;
    const forkDir = `${base}/${skillHostRootDir(editor, skill.scope)}/${skill.name}`;
    const controller = new AbortController();
    for (const [dir, set] of [
      [canonicalDir, setCanonicalBody],
      [forkDir, setForkBody],
    ] as const) {
      void fetchSkillPreview({ source: dir, name: skill.name }, controller.signal)
        .then((res) => {
          if (controller.signal.aborted) return;
          if (res.ok) set(res.skillMd);
          else setPreviewError(true);
        })
        .catch(() => {
          if (!controller.signal.aborted) setPreviewError(true);
        });
    }
    return () => controller.abort();
  }, [target?.skill.scope, target?.skill.name, target?.editor]);

  if (!target) return null;
  const { skill, editor } = target;

  async function act(action: 'align' | 'make-source' | 'rename') {
    if (!target) return;
    setBusy(true);
    const result = await resolveSkillFork({
      scope: skill.scope,
      name: skill.name,
      editor,
      action,
      ...(action === 'rename' ? { toName: toName.trim() } : {}),
    });
    setBusy(false);
    if (!result.ok) {
      toast.error(t`Couldn't resolve the fork: ${result.error}`);
      return;
    }
    toast.success(
      action === 'align'
        ? t`Aligned ${editor} to the source (its bytes are backed up)`
        : action === 'make-source'
          ? t`The ${editor} version is now the source`
          : t`Kept both — "${toName.trim()}" is its own skill now`,
    );
    onOpenChange(false);
  }

  const trimmed = toName.trim();
  const renameInvalid = trimmed === '' || !SKILL_NAME_REGEX.test(trimmed) || trimmed === skill.name;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onOpenChange(false);
      }}
    >
      {}
      <DialogContent className="flex max-h-[85vh] w-full flex-col sm:max-w-5xl">
        <DialogHeader>
          <DialogTitle>
            <Trans>
              Two versions of "{skill.name}" — source vs {editor}
            </Trans>
          </DialogTitle>
          <DialogDescription>
            <Trans>
              The {editor} folder holds a different version of this skill. Pick which one wins, or
              keep both under different names. Whatever you replace is backed up first.
            </Trans>
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="min-h-0 flex-1 overflow-auto">
          {canonicalBody !== null && forkBody !== null ? (
            <MultiFileDiff
              className="pierre-diff"
              oldFile={{ name: skill.name, contents: canonicalBody }}
              newFile={{ name: skill.name, contents: forkBody }}
              options={{ overflow: 'wrap', diffStyle: 'unified', theme: okPierreTheme() }}
            />
          ) : previewError ? (
            <div className="flex min-h-56 items-center justify-center px-6 text-center text-muted-foreground text-sm">
              <Trans>
                Couldn't load the version preview. You can still choose how to resolve it below.
              </Trans>
            </div>
          ) : (
            <div className="flex min-h-56 items-center justify-center text-muted-foreground text-sm">
              <Trans>Loading both versions</Trans>
            </div>
          )}
          {renaming ? (
            <div className="mt-3 space-y-1.5">
              <Label htmlFor={inputId}>
                <Trans>New name for the {editor} version</Trans>
              </Label>
              <Input
                id={inputId}
                value={toName}
                onChange={(e) => setToName(e.target.value)}
                placeholder={`${skill.name}-${editor}`}
                aria-invalid={renameInvalid && trimmed !== ''}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !renameInvalid) void act('rename');
                }}
              />
            </div>
          ) : null}
        </DialogBody>
        <DialogFooter>
          {renaming ? (
            <>
              <Button variant="outline" onClick={() => setRenaming(false)} disabled={busy}>
                <Trans>Back</Trans>
              </Button>
              <Button onClick={() => void act('rename')} disabled={busy || renameInvalid}>
                <Trans>Keep both</Trans>
              </Button>
            </>
          ) : (
            <>
              <Button
                variant="outline"
                onClick={() => {
                  setToName(`${skill.name}-${editor}`);
                  setRenaming(true);
                }}
                disabled={busy}
              >
                <Trans>Keep both</Trans>
              </Button>
              <Button variant="outline" onClick={() => void act('make-source')} disabled={busy}>
                <Trans>Use {editor} version</Trans>
              </Button>
              <Button onClick={() => void act('align')} disabled={busy}>
                <Trans>Keep source</Trans>
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

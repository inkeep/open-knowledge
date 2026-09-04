import { Trans, useLingui } from '@lingui/react/macro';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { toast } from 'sonner';
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
import { useDocumentContext } from '@/editor/DocumentContext';
import { useSkills } from '@/hooks/use-skills';
import { useConfigContext } from '@/lib/config-provider';
import { skillEntryLiveDocName } from '@/lib/managed-artifact-doc-name';
import {
  clearSkillTrackPrompt,
  getSkillTrackPrompt,
  subscribeToSkillTrackPrompt,
} from '@/lib/skill-track-prompt-store';
import { trackSkillInGit } from '@/lib/skills-api';

export function SkillTrackInGitDialog() {
  const { t } = useLingui();
  const prompt = useSyncExternalStore(subscribeToSkillTrackPrompt, getSkillTrackPrompt);
  const { openTarget } = useDocumentContext();
  const { merged } = useConfigContext();
  const skillsState = useSkills({ enabled: prompt !== null });
  const [line, setLine] = useState<string | null>(null);
  const [gitignorePath, setGitignorePath] = useState('.gitignore');
  const [applying, setApplying] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const scope = prompt?.scope;
  const name = prompt?.name;
  useEffect(() => {
    if (scope === undefined || name === undefined) {
      setLine(null);
      return;
    }
    let cancelled = false;
    setPreviewError(null);
    void trackSkillInGit({ name, scope }).then((r) => {
      if (cancelled) return;
      if (!r.ok) {
        setPreviewError(r.error);
        return;
      }
      setLine(r.line);
      setGitignorePath(r.gitignorePath);
    });
    return () => {
      cancelled = true;
    };
  }, [scope, name]);

  if (!prompt) return null;

  const close = () => {
    if (applying) return;
    clearSkillTrackPrompt();
  };

  return (
    <Dialog open onOpenChange={(open) => !open && close()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            <Trans>"{prompt.name}" is ignored by git</Trans>
          </DialogTitle>
          <DialogDescription>
            <Trans>
              Your agents still load this skill, but OpenKnowledge can't open or edit it: it won't
              index a file that git is set to ignore, because syncing it would fail. Adding one line
              to {gitignorePath} makes it editable here.
            </Trans>
          </DialogDescription>
        </DialogHeader>
        {previewError !== null && (
          <p className="text-destructive text-sm">
            <Trans>
              Couldn't read the {gitignorePath} rule: {previewError}
            </Trans>
          </p>
        )}
        {line !== null && (
          <pre className="overflow-x-auto rounded-md bg-muted px-3 py-2 font-mono text-sm">
            {line}
          </pre>
        )}
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline" disabled={applying}>
              <Trans>Cancel</Trans>
            </Button>
          </DialogClose>
          <Button
            data-testid="skill-track-in-git-confirm"
            disabled={applying || line === null}
            onClick={async () => {
              setApplying(true);
              const result = await trackSkillInGit({
                name: prompt.name,
                scope: prompt.scope,
                apply: true,
              });
              setApplying(false);
              if (!result.ok) {
                toast.error(t`Couldn't update ${gitignorePath}: ${result.error}`);
                return;
              }
              clearSkillTrackPrompt();
              const entry =
                skillsState.status === 'ready'
                  ? skillsState.data.find((s) => s.scope === prompt.scope && s.name === prompt.name)
                  : undefined;
              if (entry) {
                const docName = skillEntryLiveDocName(entry);
                openTarget(
                  { kind: 'doc', target: docName, docName },
                  {
                    tabBehavior:
                      (merged?.editor?.previewTabs ?? true) ? 'replace-active' : 'append',
                  },
                );
              }
            }}
          >
            <Trans>Add to {gitignorePath}</Trans>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

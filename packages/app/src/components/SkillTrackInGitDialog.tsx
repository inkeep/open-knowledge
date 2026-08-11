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

/**
 * Why a skill you can see refuses to open, and the one line that fixes it.
 *
 * A gitignored bundle is listed but never indexed — OK will not index a doc the
 * sync engine could never commit — so the row is real and the click has nothing
 * behind it. `.claude/*` is a common rule, which made this look like a random
 * bug rather than a policy. The dialog shows the literal `.gitignore` line
 * BEFORE writing: it edits the user's repo, so it never happens on open.
 *
 * The line re-includes the whole skills DIRECTORY because git cannot re-include
 * a file whose parent directory is excluded; the server owns that rule and
 * hands it back here, so the two can't drift.
 *
 * Mounted once in `App` — the guard fires from the shared opener, which has no
 * surface of its own.
 */
export function SkillTrackInGitDialog() {
  const { t } = useLingui();
  const prompt = useSyncExternalStore(subscribeToSkillTrackPrompt, getSkillTrackPrompt);
  const { openTarget } = useDocumentContext();
  const { merged } = useConfigContext();
  // Gated: this host is mounted for the whole session but inert almost all of
  // it, and `/api/skills` is a synchronous walk of every skills root on the
  // machine. Ungated it costs that scan at every boot and on every `files`
  // signal, for a dialog nobody has opened.
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
    // Preview only — `apply` defaults to false, so this cannot touch the repo.
    void trackSkillInGit({ name, scope }).then((r) => {
      if (cancelled) return;
      if (!r.ok) {
        // Without this the dialog explains the fix and then disables the only
        // button that applies it, with no reason given.
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
              // Open what the user asked for in the first place. Addressed by
              // the entry's own doc name rather than back through the opener,
              // whose `ignored` guard is still true until the list refetches.
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

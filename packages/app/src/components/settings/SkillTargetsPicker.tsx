import {
  EDITOR_LABELS,
  PROJECT_SKILL_EDITOR_IDS,
  type SkillTargetEditor,
} from '@inkeep/open-knowledge-core';
import { Trans, useLingui } from '@lingui/react/macro';
import { toast } from 'sonner';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { useSkillTargets } from '@/hooks/use-skill-targets';

/**
 * Project-wide picker for the skill-target editor set (`.ok/skill-targets.json`).
 * Toggling an editor persists the new set and re-projects every managed skill
 * (authored + OK's shipped `open-knowledge` bundle) into / out of that editor's
 * skill folder. Lives at the top of the Skills manager because it governs where
 * *every* skill in the project installs, not any single one.
 *
 * `configured` distinguishes an explicit committed set from one detected from
 * the project's configured editors — the copy makes that visible so the user
 * knows whether they're overriding a default or confirming it.
 */
export function SkillTargetsPicker() {
  const { t } = useLingui();
  const { state, save, saving } = useSkillTargets();
  const headingId = 'settings-skill-targets-heading';

  // Only editors that have a project skill surface can be targets (claude /
  // cursor / codex — claude-desktop has no project skill dir).
  const editors = PROJECT_SKILL_EDITOR_IDS as readonly SkillTargetEditor[];

  const selected = state.status === 'ready' ? new Set(state.data.targets) : new Set<string>();

  const toggle = async (id: SkillTargetEditor, next: boolean) => {
    if (state.status !== 'ready') return;
    const set = new Set(state.data.targets);
    if (next) set.add(id);
    else set.delete(id);
    try {
      await save([...set]);
    } catch (err) {
      toast.error(
        t`Couldn't update skill targets: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  return (
    <section
      aria-labelledby={headingId}
      className="space-y-2 rounded-lg border bg-card p-3"
      data-testid="settings-skill-targets"
    >
      <div>
        <h4 id={headingId} className="text-sm font-medium">
          <Trans>Install skills into</Trans>
        </h4>
        <p className="text-1sm text-muted-foreground">
          {state.status === 'ready' && !state.data.configured ? (
            <Trans>
              Detected from the editors this project is set up for. Adjust to control where every
              skill installs.
            </Trans>
          ) : (
            <Trans>Choose which editors every skill in this project installs into.</Trans>
          )}
        </p>
      </div>

      {state.status === 'error' ? (
        <div className="text-1sm text-destructive" role="alert" data-testid="skill-targets-error">
          <Trans>Failed to load skill targets: {state.message}</Trans>
        </div>
      ) : state.status === 'idle' || state.status === 'loading' ? (
        <div className="space-y-2 pt-1">
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-5 w-40" />
        </div>
      ) : (
        <fieldset className="flex flex-col gap-2 pt-1" disabled={saving}>
          <legend className="sr-only">
            <Trans>Editors to install skills into</Trans>
          </legend>
          {editors.map((id) => {
            const inputId = `skill-target-${id}`;
            return (
              <Label key={id} htmlFor={inputId} className="text-sm font-normal">
                <Checkbox
                  id={inputId}
                  checked={selected.has(id)}
                  onCheckedChange={(next) => toggle(id, next === true)}
                  disabled={saving}
                  data-testid={`skill-target-${id}`}
                />
                <span>{EDITOR_LABELS[id]}</span>
              </Label>
            );
          })}
        </fieldset>
      )}
    </section>
  );
}

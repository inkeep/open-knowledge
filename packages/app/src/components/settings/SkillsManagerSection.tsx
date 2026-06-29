import type { SkillScope, SkillsListEntry } from '@inkeep/open-knowledge-core';
import { Trans, useLingui } from '@lingui/react/macro';
import { Plus } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { NewSkillDialog } from '@/components/NewSkillDialog';
import { SkillRow } from '@/components/SkillRow';
import { SkillTargetsPicker } from '@/components/settings/SkillTargetsPicker';
import { useSkillActions } from '@/components/skill-actions';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useSkills } from '@/hooks/use-skills';
import { skillLiveDocName } from '@/lib/managed-artifact-doc-name';
import { openManagedArtifactTab } from '@/lib/open-managed-artifact-tab';
import { SKILL_SCOPE_ORDER, useSkillScopeLabels } from '@/lib/skill-scope';
import { useSettingsRoute } from '@/lib/use-settings-route';


interface ScopeGroupChrome {
  title: ReactNode;
  blurb: ReactNode;
  empty: ReactNode;
}

function useScopeChrome(): Record<SkillScope, ScopeGroupChrome> {
  const { t } = useLingui();
  const labels = useSkillScopeLabels();
  return {
    global: {
      title: labels.global,
      blurb: t`Available in every project on this computer.`,
      empty: t`No global skills yet.`,
    },
    project: {
      title: labels.project,
      blurb: t`Shared via git with everyone working on this project.`,
      empty: t`No project skills yet. Author one to teach agents a repeatable task scoped to this knowledge base.`,
    },
  };
}

export function SkillsManagerSection() {
  const state = useSkills();
  const chrome = useScopeChrome();
  const titleId = 'settings-skills-title';

  const settingsRoute = useSettingsRoute();
  const [newSkillOpen, setNewSkillOpen] = useState(false);

  function openSkillTab(scope: SkillScope, name: string) {
    openManagedArtifactTab(skillLiveDocName(scope, name));
    settingsRoute.close();
  }

  const actions = useSkillActions();

  return (
    <section aria-labelledby={titleId} className="space-y-4" data-testid="settings-skills-section">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <h3 id={titleId} className="text-base font-semibold">
            <Trans>Skills</Trans>
          </h3>
          <p className="text-sm text-muted-foreground">
            <Trans>
              Skills teach agents repeatable tasks. Author them here; install a skill to project it
              into your editors' skill folders.
            </Trans>
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="shrink-0 font-mono uppercase"
          onClick={() => setNewSkillOpen(true)}
          data-testid="settings-skills-new-button"
        >
          <Plus className="size-3.5" aria-hidden />
          <Trans>New skill</Trans>
        </Button>
      </div>

      <SkillTargetsPicker />

      {state.status === 'error' ? (
        <div
          className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive"
          role="alert"
          data-testid="settings-skills-error"
        >
          <Trans>Failed to load skills: {state.message}</Trans>
        </div>
      ) : state.status === 'idle' || state.status === 'loading' ? (
        <div className="rounded-lg border bg-card p-3 space-y-2">
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
        </div>
      ) : (
        SKILL_SCOPE_ORDER.map((scope) => {
          const skills = state.data
            .filter((s) => s.scope === scope)
            .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
          if (scope === 'global' && skills.length === 0) return null;
          return (
            <ScopeGroup
              key={scope}
              chrome={chrome[scope]}
              scope={scope}
              skills={skills}
              installingName={actions.installingName}
              onEdit={(skill) => openSkillTab(skill.scope, skill.name)}
              onDelete={actions.requestDelete}
              onInstall={actions.install}
              onUninstall={actions.uninstall}
            />
          );
        })
      )}

      {actions.dialogs}

      <NewSkillDialog
        defaultScope="project"
        open={newSkillOpen}
        onOpenChange={setNewSkillOpen}
        onCreated={({ scope, name }) => openSkillTab(scope, name)}
      />
    </section>
  );
}

function ScopeGroup({
  chrome,
  scope,
  skills,
  installingName,
  onEdit,
  onDelete,
  onInstall,
  onUninstall,
}: {
  chrome: ScopeGroupChrome;
  scope: SkillScope;
  skills: readonly SkillsListEntry[];
  installingName: string | null;
  onEdit: (skill: SkillsListEntry) => void;
  onDelete: (skill: SkillsListEntry) => void;
  onInstall: (skill: SkillsListEntry) => void;
  onUninstall: (skill: SkillsListEntry) => void;
}) {
  const headingId = `settings-skills-${scope}-heading`;
  return (
    <section
      aria-labelledby={headingId}
      className="space-y-2"
      data-testid={`skills-group-${scope}`}
    >
      <div>
        <h4 id={headingId} className="text-sm font-medium">
          {chrome.title}
        </h4>
        <p className="text-1sm text-muted-foreground">{chrome.blurb}</p>
      </div>
      <div className="rounded-lg border bg-card">
        {skills.length === 0 ? (
          <p
            className="px-3 py-4 text-sm text-muted-foreground"
            data-testid={`skills-group-${scope}-empty`}
          >
            {chrome.empty}
          </p>
        ) : (
          <ul className="space-y-1 p-2" data-testid={`skills-group-${scope}-list`}>
            {skills.map((skill) => (
              <SkillRow
                key={skill.name}
                skill={skill}
                installing={installingName === skill.name}
                onEdit={() => onEdit(skill)}
                onDelete={() => onDelete(skill)}
                onInstall={() => onInstall(skill)}
                onUninstall={() => onUninstall(skill)}
              />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

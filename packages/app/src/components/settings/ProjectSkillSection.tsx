import { Trans, useLingui } from '@lingui/react/macro';
import { useState } from 'react';
import { toast } from 'sonner';
import { SkillConsentRow } from '@/components/SkillConsentRow';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useSkills } from '@/hooks/use-skills';
import { emitSkillsChanged } from '@/lib/documents-events';
import { openSkillPreviewTab } from '@/lib/open-managed-artifact-tab';
import { skillClusterHosts } from '@/lib/skill-scope';
import { builtinBundleDir, useBuiltinSkillBlurb } from './builtin-skill-copy';

export function ProjectSkillSection() {
  const { t } = useLingui();
  const blurbFor = useBuiltinSkillBlurb();
  const skills = useSkills();
  const bridge = typeof window !== 'undefined' ? window.okDesktop : undefined;
  const [installing, setInstalling] = useState(false);

  const heading = (
    <div>
      <h4 className="text-sm font-medium">
        {}
        <Trans comment="Heading above the project's own skill row, in Settings → This project → Skills Studio">
          Skills from OpenKnowledge
        </Trans>
      </h4>
      <p className="text-1sm text-muted-foreground">
        <Trans comment="Says what the project skill is for, then the thing that makes it different from the user-scope ones: it is committed to the repo">
          This one teaches your AI tools how to work with OpenKnowledge. It lives in the project
          folder, so it installs for everyone who opens the project.
        </Trans>
      </p>
    </div>
  );

  if (skills.status === 'error') {
    return (
      <section
        className="space-y-2 rounded-lg border bg-card p-3"
        data-testid="settings-project-skill"
      >
        {heading}
        <p className="text-1sm text-muted-foreground" data-testid="project-skill-unavailable">
          <Trans>Couldn't read whether this project's skill is installed.</Trans>
        </p>
      </section>
    );
  }

  if (skills.status !== 'ready') {
    return (
      <section
        className="space-y-2 rounded-lg border bg-card p-3"
        data-testid="settings-project-skill"
      >
        {heading}
        {}
        <div
          role="status"
          aria-live="polite"
          aria-busy="true"
          className="pt-1"
          data-testid="project-skill-loading"
        >
          <span className="sr-only">
            <Trans>Loading skills</Trans>
          </span>
          <Skeleton className="h-12 w-full" />
        </div>
      </section>
    );
  }

  const skill = skills.data.find((s) => s.managed === true && s.scope === 'project') ?? null;
  if (skill === null) {
    if (!bridge) return null;
    return (
      <section
        className="space-y-2 rounded-lg border bg-card p-3"
        data-testid="settings-project-skill"
      >
        {heading}
        <div className="flex items-center justify-between gap-3 rounded-md border border-border bg-background/50 p-3">
          <p className="text-1sm text-muted-foreground">
            <Trans>Not installed in this project yet.</Trans>
          </p>
          <Button
            size="sm"
            disabled={installing}
            data-testid="project-skill-install"
            onClick={() => {
              setInstalling(true);
              void bridge.projectIntegrations
                .setComponent({
                  component: { kind: 'skill' },
                  enabled: true,
                })
                .then((result) => {
                  if (!result.ok) toast.error(result.error);
                  else emitSkillsChanged();
                })
                .catch((err: unknown) => {
                  toast.error(
                    t`Couldn't install the project skill: ${err instanceof Error ? err.message : String(err)}`,
                  );
                })
                .then(() => setInstalling(false));
            }}
          >
            {installing ? <Trans>Installing</Trans> : <Trans>Install</Trans>}
          </Button>
        </div>
      </section>
    );
  }
  const source = builtinBundleDir(skill.absolutePath);
  const rowDescription = blurbFor('project') ?? skill.description ?? '';
  const openPreview = source
    ? () =>
        openSkillPreviewTab({
          flavor: 'builtin',
          source,
          name: skill.name,
          subtitle: '',
          level: 'project',
        })
    : undefined;

  return (
    <section
      className="space-y-2 rounded-lg border bg-card p-3"
      data-testid="settings-project-skill"
    >
      {heading}

      <ul className="overflow-hidden rounded-md border border-border bg-background/50">
        <li className="hover:bg-accent">
          <SkillConsentRow
            name={skill.name}
            description={rowDescription}
            hosts={skillClusterHosts(skill)}
            onActivate={openPreview}
            control={
              openPreview ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={openPreview}
                  data-testid="project-skill-manage"
                >
                  <Trans>Manage</Trans>
                </Button>
              ) : undefined
            }
          />
        </li>
      </ul>
    </section>
  );
}

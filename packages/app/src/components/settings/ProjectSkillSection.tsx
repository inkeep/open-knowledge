/**
 * Settings → This project → Skills Studio, top block: the `open-knowledge`
 * skill this project ships to whoever opens it.
 *
 * The project-scope sibling of `BuiltInSkillsSection`, moved out of This
 * project → AI tools for the same reason. Moving only the
 * user-global half would have left exactly one skill filed under AI tools,
 * which is worse than no rule at all: skills live in Skills Studio,
 * connections live in AI tools, no exceptions to carry in your head.
 *
 * Unlike the user-global bundles this one is committed to the repo, so the
 * block says so — installing it installs it for everyone on the project.
 *
 * Sourced from `/api/skills`, the same list the sidebar, the tree and the
 * skill's own page read. It used to read the desktop bridge instead, which is a
 * second answer to a question that already had one: the bridge enumerates the
 * bundles the app SHIPS, the endpoint reports what is on disk. They disagreed
 * the moment anything changed from the skill's own page, and this row went on
 * showing the install set from before.
 */

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
        {/* Same heading as the user-scope block: both are skills OpenKnowledge
            ships, and naming provenance there but scope here would split one
            kind of thing across two axes. The scope difference is the second
            sentence's job, and the page's own scope chip already says it. */}
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
        {/* Same shape as SettingsContentSkeleton: a bare skeleton is silence to
            a screen reader, which is indistinguishable from an empty page. */}
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
    // Not installed. The row used to vanish entirely, which read as "there is
    // no such skill" — instead say so and offer the install (desktop only: the
    // bridge owns the project-skill seeding path).
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
  // Falls back to the frontmatter description only if the copy module does not
  // know this bundle (a newer server shipping one we have no localized line
  // for).
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
              // An explicit verb beside the row: the body-click preview was the
              // only way in, and nothing said the row was interactive at all.
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

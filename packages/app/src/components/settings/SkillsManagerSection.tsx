import type { SkillScope } from '@inkeep/open-knowledge-core';
import { Trans } from '@lingui/react/macro';
import { SkillTargetsPicker } from '@/components/settings/SkillTargetsPicker';

/**
 * Settings → Skills, one page per scope: THIS PROJECT carries the project
 * skill folders, USER carries the global (user-home) ones — matching the
 * settings nav's own scope split. Per-skill reach lives in each skill's
 * install menu; authoring and browsing live in the editor's Skills sidebar.
 */
export function SkillsManagerSection({ scope }: { scope: SkillScope }) {
  const titleId = `settings-skills-title-${scope}`;

  return (
    <section aria-labelledby={titleId} className="space-y-4" data-testid="settings-skills-section">
      <div className="space-y-1">
        <h3 id={titleId} className="text-base font-semibold">
          <Trans>Skills</Trans>
        </h3>
        <p className="text-sm text-muted-foreground">
          {scope === 'project' ? (
            <Trans>
              Skills teach agents repeatable tasks. Author and manage them from the Skills section
              in the editor; each skill's install menu controls where it lives. These are this
              project's skill folders.
            </Trans>
          ) : (
            <Trans>
              Your user-level skill folders — available in every project on this machine. Each
              skill's install menu controls where it lives.
            </Trans>
          )}
        </p>
      </div>

      <SkillTargetsPicker scope={scope} />
    </section>
  );
}

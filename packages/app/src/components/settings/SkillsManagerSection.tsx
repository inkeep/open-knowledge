import type { SkillScope } from '@inkeep/open-knowledge-core';
import { Trans } from '@lingui/react/macro';
import { SkillTargetsPicker } from '@/components/settings/SkillTargetsPicker';
import { BuiltInSkillsSection } from './BuiltInSkillsSection';
import { ProjectSkillSection } from './ProjectSkillSection';
import { SettingsSectionHeader } from './SettingsSectionHeader';

/**
 * Settings → Skills Studio, one page per scope: THIS PROJECT carries the
 * project's own skill and its skill folders, USER carries the skills OK ships
 * plus the user-home folders — matching the settings nav's own scope split.
 *
 * Installing is the first thing on the page, folders second, because usability
 * testing found the reverse unusable: a tab named Skills that held only folder
 * symlinks, while the install lived a page away under AI tools & CLI. Authoring and browsing
 * still live in the editor's Skills sidebar; per-skill reach still lives in
 * each skill's install menu.
 */
export function SkillsManagerSection({ scope }: { scope: SkillScope }) {
  const titleId = `settings-skills-title-${scope}`;

  return (
    <section aria-labelledby={titleId} className="space-y-4" data-testid="settings-skills-section">
      <SettingsSectionHeader
        titleId={titleId}
        title={<Trans>Skills Studio</Trans>}
        scope={scope === 'project' ? 'project' : 'user'}
      >
        {scope === 'project' ? (
          <Trans>
            Skills that come with this project, and the folders its AI tools read them from.
          </Trans>
        ) : (
          <Trans>
            Skills teach your AI tools repeatable tasks. Write your own in the editor's Skills
            sidebar; this page is where they get switched on and shared.
          </Trans>
        )}
      </SettingsSectionHeader>

      {scope === 'project' ? <ProjectSkillSection /> : <BuiltInSkillsSection />}

      <SkillTargetsPicker scope={scope} />
    </section>
  );
}

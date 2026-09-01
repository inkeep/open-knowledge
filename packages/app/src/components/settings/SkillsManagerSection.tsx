import type { SkillScope } from '@inkeep/open-knowledge-core';
import { Trans } from '@lingui/react/macro';
import { SkillTargetsPicker } from '@/components/settings/SkillTargetsPicker';
import { BuiltInSkillsSection } from './BuiltInSkillsSection';
import { ProjectSkillSection } from './ProjectSkillSection';
import { SettingsSectionHeader } from './SettingsSectionHeader';

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

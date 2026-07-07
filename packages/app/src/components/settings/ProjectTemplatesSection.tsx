import { Trans, useLingui } from '@lingui/react/macro';
import { TemplatesManagerSection } from './TemplatesManagerSection';

/**
 * Settings -> Project templates. Manages templates at the project root's
 * `.ok/templates/` directory — available across every folder in the project.
 * Folder-level templates (under `<folder>/.ok/templates/`) stay on each
 * folder's overview page.
 *
 * Thin wrapper around the shared `TemplatesManagerSection`; see that component
 * for the list / edit / delete / new mechanics.
 */
export function ProjectTemplatesSection() {
  const { t } = useLingui();
  return (
    <TemplatesManagerSection
      config={{
        scope: 'local',
        title: t`Project templates`,
        description: (
          <Trans>
            Stored at <code className="font-mono">.ok/templates/</code> in this project. Available
            in every folder (folder-scoped templates can override by filename).
          </Trans>
        ),
        emptyMessage: t`No project templates yet. Create one to make it available everywhere in this project. Folder-scoped templates live on each folder's overview page.`,
        loadErrorTitle: t`Failed to load project templates`,
        badge: { label: t`project`, variant: 'gray' },
        settingsId: 'settings-project-templates-title',
        testIdPrefix: 'project-templates',
      }}
    />
  );
}

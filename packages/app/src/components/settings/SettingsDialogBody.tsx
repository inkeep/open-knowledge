import type { ConfigBinding, OkignoreBinding } from '@inkeep/open-knowledge-core';
import { Trans, useLingui } from '@lingui/react/macro';
import { SharingSection } from '@/components/settings/SharingSection';
import { AccountSection } from './AccountSection';
import { AiToolsSection } from './AiToolsSection';
import { AttachmentsSection } from './AttachmentsSection';
import { ConfigureAgentsSection } from './ConfigureAgentsSection';
import { ContentRulesSection } from './ContentRulesSection';
import { SectionSkeleton } from './field-controls';
import { HotkeysSection } from './HotkeysSection';
import { IntegrationsSection } from './IntegrationsSection';
import { LinkPreviewsSection } from './LinkPreviewsSection';
import {
  MarkdownlintPluginSection,
  ProjectPluginsManageSection,
  UserPluginsManageSection,
} from './LintingSection';
import { LINT_PLUGIN_UI } from './lint-plugins';
import { NetworkAccessSection } from './NetworkAccessSection';
import { OkignoreSection } from './OkignoreSection';
import { ProjectAiToolsSection } from './ProjectAiToolsSection';
import { ProjectTemplatesSection } from './ProjectTemplatesSection';
import { SearchSection } from './SearchSection';
import { SettingsSectionHeader } from './SettingsSectionHeader';
import { SkillsManagerSection } from './SkillsManagerSection';
import { SlidesPluginSection } from './SlidesPluginSection';
import { SyncSection } from './SyncSection';
import { BoundSchemaSection } from './schema-section';
import { FIELDS_USER_PREFERENCES } from './settings-fields';
import { isTerminalSettingsAvailable } from './settings-host-gates';
import { TerminalSection } from './TerminalSection';
import { ThemePluginSection } from './ThemePluginSection';

interface SettingsDialogBodyProps {
  activeId: string;
  userBinding: ConfigBinding | null;
  okignoreBinding: OkignoreBinding | null;
  okignoreSynced: boolean;
  markdownlintRuleQuery?: { query: string; nonce: number } | null;
}

export function SettingsDialogBody({
  activeId,
  userBinding,
  okignoreBinding,
  okignoreSynced,
  markdownlintRuleQuery,
}: SettingsDialogBodyProps) {
  const { t } = useLingui();
  if (activeId === 'preferences') {
    return userBinding ? (
      <BoundSchemaSection
        title={t`Preferences`}
        description={t`Customize how the editor looks and behaves.`}
        scope="user"
        scopeBadge="user"
        binding={userBinding}
        fields={FIELDS_USER_PREFERENCES}
      />
    ) : (
      <SectionSkeleton />
    );
  }
  if (activeId === 'project-preferences') {
    return (
      <section
        aria-labelledby="settings-project-preferences-title"
        className="space-y-8"
        data-testid="settings-project-preferences"
      >
        <SettingsSectionHeader
          titleId="settings-project-preferences-title"
          title={<Trans>Preferences</Trans>}
          scope="project"
        >
          <Trans>
            Settings for this project. Some are shared with every collaborator through git; others
            apply only on this computer.
          </Trans>
        </SettingsSectionHeader>
        <AttachmentsSection />
        <ContentRulesSection />
        {isTerminalSettingsAvailable() ? <TerminalSection /> : null}
      </section>
    );
  }
  if (activeId === 'configure-agents') {
    return <ConfigureAgentsSection />;
  }
  if (activeId === 'hotkeys') {
    return <HotkeysSection />;
  }
  if (activeId === 'account') {
    return <AccountSection />;
  }
  if (activeId === 'sync') {
    return (
      <section
        aria-labelledby="settings-sync-sharing-title"
        className="space-y-8"
        data-testid="settings-sync-sharing"
      >
        <SettingsSectionHeader
          titleId="settings-sync-sharing-title"
          title={<Trans>Sync & sharing</Trans>}
        />
        <SyncSection />
        <SharingSection />
      </section>
    );
  }
  if (activeId === 'search') {
    return <SearchSection />;
  }
  if (activeId === 'link-previews') {
    return <LinkPreviewsSection />;
  }
  if (activeId === 'plugins-manage') {
    return <ProjectPluginsManageSection />;
  }
  if (activeId === 'user-plugins-manage') {
    return <UserPluginsManageSection userBinding={userBinding} />;
  }
  if (activeId === 'plugin:theme') {
    return userBinding ? <ThemePluginSection userBinding={userBinding} /> : <SectionSkeleton />;
  }
  if (activeId === 'plugin:slides') {
    return <SlidesPluginSection />;
  }
  if (activeId === 'plugin:markdownlint') {
    return <MarkdownlintPluginSection initialRuleQuery={markdownlintRuleQuery ?? null} />;
  }
  if (activeId.startsWith('plugin:')) {
    const pluginId = activeId.slice('plugin:'.length);
    const plugin = LINT_PLUGIN_UI.find((p) => p.id === pluginId);
    if (!plugin) return null;
    const PluginSection = plugin.Section;
    return <PluginSection key={activeId} />;
  }
  if (activeId === 'project-templates') {
    return <ProjectTemplatesSection />;
  }
  if (activeId === 'skills') {
    return <SkillsManagerSection scope="project" />;
  }
  if (activeId === 'user-skills') {
    return <SkillsManagerSection scope="global" />;
  }
  if (activeId === 'okignore') {
    return <OkignoreSection binding={okignoreBinding} synced={okignoreSynced} />;
  }
  if (activeId === 'ai-tools') {
    return <AiToolsSection />;
  }
  if (activeId === 'project-ai-tools') {
    return <ProjectAiToolsSection />;
  }
  if (activeId === 'network-access') {
    return <NetworkAccessSection />;
  }
  if (activeId === 'claude-desktop') {
    return <IntegrationsSection />;
  }
  return null;
}

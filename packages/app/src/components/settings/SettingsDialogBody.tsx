import type { ConfigBinding } from '@inkeep/open-knowledge-core/config/bind-config-doc';
import type { OkignoreBinding } from '@inkeep/open-knowledge-core/config/bind-okignore-doc';
import { Trans, useLingui } from '@lingui/react/macro';
import { TriangleAlert } from 'lucide-react';
import { type ComponentType, lazy } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { lazyWithPreload } from '@/lib/lazy-with-preload';
import { SettingsSectionHeader } from './SettingsSectionHeader';
import { FIELDS_USER_PREFERENCES } from './settings-fields';
import { isTerminalSettingsAvailable } from './settings-host-gates';

function lazySection<Props>(load: () => Promise<ComponentType<Props>>) {
  return lazy(async () => ({ default: await load() }));
}

const AboutSection = lazySection(async () => (await import('./AboutSection')).AboutSection);
const SharingSection = lazySection(async () => (await import('./SharingSection')).SharingSection);
const AccountSection = lazySection(async () => (await import('./AccountSection')).AccountSection);
const AgentConnectionsSection = lazySection(
  async () => (await import('./AgentConnectionsSection')).AgentConnectionsSection,
);
const AttachmentsSection = lazySection(
  async () => (await import('./AttachmentsSection')).AttachmentsSection,
);
const ContentRulesSection = lazySection(
  async () => (await import('./ContentRulesSection')).ContentRulesSection,
);
const SectionSkeleton = lazySection(async () => (await import('./field-controls')).SectionSkeleton);
const HotkeysSection = lazySection(async () => (await import('./HotkeysSection')).HotkeysSection);
const IntegrationsSection = lazySection(
  async () => (await import('./IntegrationsSection')).IntegrationsSection,
);
const LinkPreviewsSection = lazySection(
  async () => (await import('./LinkPreviewsSection')).LinkPreviewsSection,
);
const MarkdownlintPluginSection = lazySection(
  async () => (await import('./LintingSection')).MarkdownlintPluginSection,
);
const ProjectPluginsManageSection = lazySection(
  async () => (await import('./LintingSection')).ProjectPluginsManageSection,
);
const UserPluginsManageSection = lazySection(
  async () => (await import('./LintingSection')).UserPluginsManageSection,
);
const NetworkAccessSection = lazySection(
  async () => (await import('./NetworkAccessSection')).NetworkAccessSection,
);
const OkignoreSection = lazySection(
  async () => (await import('./OkignoreSection')).OkignoreSection,
);
const ProjectTemplatesSection = lazySection(
  async () => (await import('./ProjectTemplatesSection')).ProjectTemplatesSection,
);
const SearchSection = lazySection(async () => (await import('./SearchSection')).SearchSection);
const SkillsManagerSection = lazySection(
  async () => (await import('./SkillsManagerSection')).SkillsManagerSection,
);
const SlidesPluginSection = lazySection(
  async () => (await import('./SlidesPluginSection')).SlidesPluginSection,
);
const SyncSection = lazySection(async () => (await import('./SyncSection')).SyncSection);
const TerminalSection = lazySection(
  async () => (await import('./TerminalSection')).TerminalSection,
);
const ThemePluginSection = lazySection(
  async () => (await import('./ThemePluginSection')).ThemePluginSection,
);

const LintPluginSection = lazySection(async () => {
  const { LINT_PLUGIN_UI } = await import('./lint-plugins');
  return function LintPluginSection({ id }: { id: string }) {
    const plugin = LINT_PLUGIN_UI.find((entry) => entry.id === id);
    if (!plugin) return null;
    const PluginSection = plugin.Section;
    return <PluginSection />;
  };
});

const PreferencesSection = lazyWithPreload(async () => {
  const [{ BoundSchemaSection }, { OkCliPathRow }, { SpellingSettings }] = await Promise.all([
    import('./schema-section'),
    import('./OkCliPathRow'),
    import('./SpellingSettings'),
  ]);
  return {
    default: function PreferencesSection({
      title,
      description,
      binding,
    }: {
      title: string;
      description: string;
      binding: ConfigBinding;
    }) {
      return (
        <BoundSchemaSection
          title={title}
          description={description}
          scope="user"
          scopeBadge="user"
          binding={binding}
          fields={FIELDS_USER_PREFERENCES}
          slotsAfter={{
            'appearance.theme': <OkCliPathRow />,
            'appearance.language': <SpellingSettings />,
          }}
        />
      );
    },
  };
});

export const preloadPreferencesSection = PreferencesSection.preload;

function UserConfigPending({ loadFailed }: { loadFailed: boolean }) {
  if (!loadFailed) return <SectionSkeleton />;
  return (
    <Alert data-testid="settings-user-config-unavailable">
      <TriangleAlert aria-hidden="true" />
      <AlertTitle>
        <Trans>Your user settings could not be read</Trans>
      </AlertTitle>
      <AlertDescription>
        <Trans>OpenKnowledge keeps retrying and shows them as soon as the file can be read.</Trans>
      </AlertDescription>
    </Alert>
  );
}

interface SettingsDialogBodyProps {
  activeId: string;
  userBinding: ConfigBinding | null;
  userLoadFailed?: boolean;
  okignoreBinding: OkignoreBinding | null;
  okignoreSynced: boolean;
  markdownlintRuleQuery?: { query: string; nonce: number } | null;
}

export function SettingsDialogBody({
  activeId,
  userBinding,
  userLoadFailed = false,
  okignoreBinding,
  okignoreSynced,
  markdownlintRuleQuery,
}: SettingsDialogBodyProps) {
  const { t } = useLingui();
  if (activeId === 'preferences') {
    return userBinding ? (
      <PreferencesSection
        title={t`Preferences`}
        description={t`Customize how the editor looks and behaves.`}
        binding={userBinding}
      />
    ) : (
      <UserConfigPending loadFailed={userLoadFailed} />
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
  if (activeId === 'agent-connections') {
    return <AgentConnectionsSection />;
  }
  if (activeId === 'hotkeys') {
    return <HotkeysSection />;
  }
  if (activeId === 'account') {
    return userBinding ? (
      <AccountSection userBinding={userBinding} />
    ) : (
      <UserConfigPending loadFailed={userLoadFailed} />
    );
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
        >
          <Trans>
            Sync keeps this computer's copy up to date with your Git remote. The shared settings
            below decide what teammates get when they open the project.
          </Trans>
        </SettingsSectionHeader>
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
    return userBinding ? (
      <ThemePluginSection userBinding={userBinding} />
    ) : (
      <UserConfigPending loadFailed={userLoadFailed} />
    );
  }
  if (activeId === 'plugin:slides') {
    return <SlidesPluginSection />;
  }
  if (activeId === 'plugin:markdownlint') {
    return <MarkdownlintPluginSection initialRuleQuery={markdownlintRuleQuery ?? null} />;
  }
  if (activeId.startsWith('plugin:')) {
    return <LintPluginSection key={activeId} id={activeId.slice('plugin:'.length)} />;
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
  if (activeId === 'network-access') {
    return <NetworkAccessSection />;
  }
  if (activeId === 'claude-desktop') {
    return <IntegrationsSection />;
  }
  if (activeId === 'about') {
    return <AboutSection />;
  }
  return null;
}

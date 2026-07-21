/**
 * Lazy body for the Settings modal — pulled in as a separate chunk by
 * `SettingsDialogShell.tsx` via `React.lazy`. Receives the active
 * sidebar section id + the user/okignore bindings (already gated by
 * their synced state at the shell level) and dispatches to the section
 * components.
 *
 * The shell ships Dialog/Sidebar/skeleton synchronously so the dialog
 * frame paints immediately on Cmd-,; this chunk's ~330kB of schema-form
 * harness (ConfigSchema, react-hook-form, schema-walker) + heavy
 * section bodies (Sync/Templates/Okignore/Integrations) loads in
 * parallel and swaps in. The section bodies and the shared form-field
 * machinery live in sibling files (`field-controls.tsx`,
 * `schema-section.tsx`, `*Section.tsx`) that this dispatcher imports
 * statically, so they all land in the same lazy chunk.
 *
 * The user-scope ConfigBinding is owned by ConfigProvider for the app
 * session — see `lib/config-provider.tsx`. The body is a pure consumer
 * of the props the shell passes (no provider creation, no per-open
 * teardown).
 */

import type { ConfigBinding, OkignoreBinding } from '@inkeep/open-knowledge-core';
import { useLingui } from '@lingui/react/macro';
import { SharingSection } from '@/components/settings/SharingSection';
import { AccountSection } from './AccountSection';
import { AiToolsSection } from './AiToolsSection';
import { AttachmentsSection } from './AttachmentsSection';
import { ConfigureAgentsSection } from './ConfigureAgentsSection';
import { EmbeddingsKeySection } from './EmbeddingsKeySection';
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
import { OkignoreSection } from './OkignoreSection';
import { ProjectAiToolsSection } from './ProjectAiToolsSection';
import { ProjectTemplatesSection } from './ProjectTemplatesSection';
import { SearchSection } from './SearchSection';
import { SkillsManagerSection } from './SkillsManagerSection';
import { SyncSection } from './SyncSection';
import { BoundSchemaSection } from './schema-section';
import { FIELDS_USER_PREFERENCES } from './settings-fields';
import { TerminalSection } from './TerminalSection';
import { ThemePluginSection } from './ThemePluginSection';

interface SettingsDialogBodyProps {
  activeId: string;
  userBinding: ConfigBinding | null;
  okignoreBinding: OkignoreBinding | null;
  okignoreSynced: boolean;
  /**
   * Set when the settings search navigated to a markdownlint rule — seeds the
   * rule browser's own search so the panel opens filtered to that rule. The
   * nonce lets a repeat navigation to the same rule re-seed.
   */
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
    return (
      <div className="space-y-8">
        {userBinding ? (
          <BoundSchemaSection
            title={t`Preferences`}
            description={t`Customize how the editor looks and behaves.`}
            scope="user"
            binding={userBinding}
            fields={FIELDS_USER_PREFERENCES}
          />
        ) : (
          <SectionSkeleton />
        )}
        <AttachmentsSection />
      </div>
    );
  }
  if (activeId === 'configure-agents') {
    // User-owned enable/disable for the launcher agent lists (In app / Terminal
    // / Desktop). Its own localStorage store, not the config binding.
    return <ConfigureAgentsSection />;
  }
  if (activeId === 'hotkeys') {
    return <HotkeysSection />;
  }
  if (activeId === 'account') {
    // Two machine-global credentials live here: the GitHub account and the
    // embeddings provider key (the latter shared across all projects; semantic
    // search is enabled per-project in This project → Search).
    return (
      <div className="space-y-8">
        <AccountSection />
        <EmbeddingsKeySection />
      </div>
    );
  }
  if (activeId === 'sync') {
    // When there's no git remote, SyncSection renders a setup CTA (the
    // Publish-to-GitHub wizard) rather than the auto-sync toggle. (Preview
    // was a sibling here until `preview.baseUrl` was removed from the
    // schema; if a project-scope setting reappears, stack it alongside
    // `<SyncSection />` again and rename the sidebar item back to something
    // more general.)
    return <SyncSection />;
  }
  if (activeId === 'search') {
    // Project-local semantic-search opt-in. Reads its own project-local
    // binding from ConfigContext (like SyncSection) — no prop threading.
    return <SearchSection />;
  }
  if (activeId === 'plugins-manage') {
    // Project-scope plugins management (This project → Plugins): toggle the
    // project's content-rule plugins + the audit pointer.
    return <ProjectPluginsManageSection />;
  }
  if (activeId === 'user-plugins-manage') {
    // User-scope plugins management (User → Plugins): toggle personal plugins
    // (Themes) via the user-scope binding.
    return <UserPluginsManageSection userBinding={userBinding} />;
  }
  if (activeId === 'plugin:theme') {
    // The theme "plugin" — a peer of the lint plugins in the Plugins menu, not a
    // lint plugin (it owns no `contentRules` slice). Its config is user-scope.
    return userBinding ? <ThemePluginSection userBinding={userBinding} /> : <SectionSkeleton />;
  }
  if (activeId === 'plugin:markdownlint') {
    // Dedicated branch (above the generic plugin fallthrough) so the settings
    // search can seed the panel's own rule search when it navigates to a rule.
    return <MarkdownlintPluginSection initialRuleQuery={markdownlintRuleQuery ?? null} />;
  }
  if (activeId.startsWith('plugin:')) {
    // One enabled lint plugin's settings panel.
    const pluginId = activeId.slice('plugin:'.length);
    const plugin = LINT_PLUGIN_UI.find((p) => p.id === pluginId);
    if (!plugin) return null;
    const PluginSection = plugin.Section;
    return <PluginSection key={activeId} />;
  }
  if (activeId === 'link-previews') {
    // Project-local external-link-preview egress control (on by default; this
    // section is the per-machine opt-out). Reads its own project-local binding
    // from ConfigContext, same as SearchSection. The nav item is hidden on the
    // packaged file:// renderer, whose Origin: null requests the preview route's
    // anti-proxy gate rejects (see the gating in SettingsDialogShell).
    return <LinkPreviewsSection />;
  }
  if (activeId === 'terminal') {
    // Desktop-only per-project shell consent (the nav item is gated to the
    // Electron host). Reads + writes its own project-local binding.
    return <TerminalSection />;
  }
  if (activeId === 'project-templates') {
    return <ProjectTemplatesSection />;
  }
  if (activeId === 'skills') {
    return <SkillsManagerSection />;
  }
  if (activeId === 'sharing') {
    return <SharingSection />;
  }
  if (activeId === 'okignore') {
    // Project-scope `.okignore` editor. Binding is shared with the
    // FileTree right-click "Hide this file/folder" affordance via
    // `<ConfigProvider>` — both write to the same Y.Text body.
    return <OkignoreSection binding={okignoreBinding} synced={okignoreSynced} />;
  }
  if (activeId === 'ai-tools') {
    // Global AI-tool management — desktop-only (nav item gated to the
    // Electron host). Talks to main over the integrations bridge.
    return <AiToolsSection />;
  }
  if (activeId === 'project-ai-tools') {
    // Project-local AI-tool management — desktop-only (nav item gated to the
    // Electron host). Talks to main over the projectIntegrations bridge,
    // scoped to the window's open project.
    return <ProjectAiToolsSection />;
  }
  if (activeId === 'claude-desktop') {
    return <IntegrationsSection />;
  }
  return null;
}

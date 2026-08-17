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
    // The project-scope sibling of User → Preferences: small-knob blocks
    // stacked on one page. Attachments + Content rules write the committed
    // project config; the Terminal shell toggle is per-machine
    // (project-local). The gate is the same function the shell uses for the
    // subsection entry, so a hidden block cannot have a live search entry. The
    // page/block heading cascade is the header component's `level` prop.
    //
    // The page header DOES carry a scope badge, unlike Sync & sharing below,
    // and the difference is deliberate rather than an oversight. This page has
    // a predominant scope: the two always-present blocks are both committed
    // `project`, and the only exception (Terminal, desktop + pty only) states
    // `This machine` on itself. Sync & sharing has no predominant scope — its
    // two blocks split evenly — so no single badge there could be true.
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
    // User-owned enable/disable for the launcher agent lists (In app / Terminal
    // / Desktop). Its own localStorage store, not the config binding.
    return <ConfigureAgentsSection />;
  }
  if (activeId === 'hotkeys') {
    return <HotkeysSection />;
  }
  if (activeId === 'account') {
    // The GitHub account credential. The embeddings API key moved to This
    // project → Search, next to the endpoint it belongs to (keys are per-project
    // now, not machine-global).
    return <AccountSection />;
  }
  if (activeId === 'sync') {
    // Sync & sharing: one page grouping two block-level sections that both
    // answer "how does this project's state move through git" — the sync mode
    // (with the Publish-to-GitHub setup CTA when there's no remote) and which OK
    // config artifacts are shared vs local-only. Same page/block cascade as
    // project Preferences above. SharingSection renders its own CLI-pointer stub
    // on non-desktop hosts.
    //
    // The page header carries no scope badge on purpose: the blocks below span
    // both scopes with no predominant one. Config sharing is committed
    // `project`, and Sync is mostly per-machine `project-local` but holds one
    // committed control (Shared default, which self-labels). Any single summary
    // badge here would be false for part of the page, so each block and that one
    // control state their own.
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
    // Project-local semantic-search opt-in. Reads its own project-local
    // binding from ConfigContext (like SyncSection) — no prop threading.
    return <SearchSection />;
  }
  if (activeId === 'link-previews') {
    // Project-local external-link-preview egress control (on by default; this
    // section is the per-machine opt-out). Reads its own project-local binding
    // from ConfigContext, same as SearchSection. The nav item is hidden on the
    // packaged file:// renderer, whose Origin: null requests the preview route's
    // anti-proxy gate rejects (see the gating in SettingsDialogShell).
    return <LinkPreviewsSection />;
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
  if (activeId === 'plugin:slides') {
    // The Slides "plugin" — a peer of the lint plugins in the Plugins menu, not
    // a lint plugin (it owns no `contentRules` slice). Dedicated branch above
    // the generic plugin fallthrough, which only knows the lint-plugin registry.
    return <SlidesPluginSection />;
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
  if (activeId === 'network-access') {
    // Expose-via-tunnel controls — desktop-only (nav item gated to the Electron
    // host). Writes the scope-split server.* leaves and restarts the server.
    return <NetworkAccessSection />;
  }
  if (activeId === 'claude-desktop') {
    return <IntegrationsSection />;
  }
  return null;
}

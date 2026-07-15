/**
 * Settings → Plugins — the no-code GUI for the markdown linter, organized as
 * lint plugins. Project scope: lint rules are an authoring standard shared with
 * the team via the committed `config.yml` + the project's native
 * `.markdownlint.*` file (the source of truth for rules).
 *
 * Exported sections: `ProjectPluginsManageSection` + `UserPluginsManageSection`
 * (per-plugin on/off, one manage page per scope) and `MarkdownlintPluginSection`
 * (the full-catalog rule browser — see `markdownlint-rule-browser.tsx`).
 */
import {
  type ConfigBinding,
  type ConfigPatch,
  humanFormat,
  type LintPluginId,
} from '@inkeep/open-knowledge-core';
import { Trans, useLingui } from '@lingui/react/macro';
import { ArrowUpRight } from 'lucide-react';
import type { ReactNode } from 'react';
import { toast } from 'sonner';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { useConfigContext } from '@/lib/config-provider';
import { dispatchExternalLinkClick } from '@/lib/external-link';
import { LINT_PLUGIN_META } from './lint-plugin-meta';
import { MarkdownlintRuleBrowser } from './markdownlint-rule-browser';

/** Project-scope content-rules config + a `contentRules`-patch writer. Shared by the sections. */
function useLinterConfig() {
  const { t } = useLingui();
  const { projectConfig, projectSynced, projectBinding } = useConfigContext();
  const contentRules = projectConfig?.contentRules;
  const bindingReady = projectSynced && projectBinding !== null;

  function write(patch: ConfigPatch['contentRules']): boolean {
    if (projectBinding === null) {
      toast.error(t`Content rules not yet loaded — try again in a moment`);
      return false;
    }
    const result = projectBinding.patch({ contentRules: patch });
    if (!result.ok) {
      toast.error(t`Failed to save content rules — ${humanFormat(result.error)}`);
      return false;
    }
    return true;
  }

  return { contentRules, bindingReady, write };
}

/** A `contentRules` patch toggling one plugin's `enabled` (dynamic key needs the cast). */
function pluginEnabledPatch(id: LintPluginId, enabled: boolean): ConfigPatch['contentRules'] {
  return { [id]: { enabled } } as ConfigPatch['contentRules'];
}

function PluginManageDescription({ id }: { id: LintPluginId }) {
  switch (id) {
    case 'markdownlint':
      return (
        <Trans>
          Common markdown issues — hard tabs, heading increments, list markers, and more.
        </Trans>
      );
  }
}

/**
 * Project-scope plugins management page (This project → Plugins). Toggles the
 * project's content-rule plugins on/off; the choice is committed to config.yml
 * and shared via git. Enabled plugins also appear under the Plugins sidebar
 * section with their own panel.
 */
export function ProjectPluginsManageSection() {
  const { t } = useLingui();
  const { contentRules, bindingReady, write } = useLinterConfig();

  return (
    <section
      aria-labelledby="settings-plugins-title"
      className="space-y-4"
      data-testid="settings-plugins-manage"
    >
      <div className="space-y-1">
        <h3 id="settings-plugins-title" className="text-base font-semibold">
          <Trans>Plugins</Trans>
        </h3>
        <p className="text-sm text-muted-foreground">
          <Trans>
            Project plugins are your project's authoring standard — turn them on or off here. The
            choice is committed to config.yml and shared with every collaborator via git. Each
            enabled plugin gets its own page under Plugins in the settings sidebar.
          </Trans>
        </p>
      </div>

      <div className="divide-y rounded-md border" data-testid="settings-plugins-list">
        {LINT_PLUGIN_META.map((plugin) => {
          const on = contentRules?.[plugin.id]?.enabled === true;
          return (
            <div key={plugin.id} className="flex items-center justify-between gap-3 px-3 py-2">
              <div className="min-w-0">
                <Label
                  htmlFor={`settings-plugin-toggle-${plugin.id}`}
                  className="text-sm font-medium"
                >
                  {plugin.label}
                </Label>
                <p className="text-sm text-muted-foreground">
                  <PluginManageDescription id={plugin.id} />
                </p>
              </div>
              <Switch
                id={`settings-plugin-toggle-${plugin.id}`}
                checked={on}
                disabled={!bindingReady}
                onCheckedChange={(next) => write(pluginEnabledPatch(plugin.id, next))}
                aria-label={on ? t`Disable ${plugin.label}` : t`Enable ${plugin.label}`}
                data-testid={`settings-plugin-toggle-${plugin.id}`}
              />
            </div>
          );
        })}
      </div>

      <p className="text-sm text-muted-foreground" data-testid="settings-plugins-audit-pointer">
        <Trans>Run a project audit from the Problems panel.</Trans>
      </p>
    </section>
  );
}

/**
 * User-scope plugins management page (User → Plugins). Toggles personal,
 * device-local plugins (Themes) on/off; the choice lives in your user config
 * and is never committed to the project.
 */
export function UserPluginsManageSection({ userBinding }: { userBinding: ConfigBinding | null }) {
  const { t } = useLingui();
  const { userConfig } = useConfigContext();
  // The theme plugin is user-scope (personal). Default on.
  const themeEnabled = userConfig?.appearance?.colorThemeEnabled !== false;

  return (
    <section
      aria-labelledby="settings-user-plugins-title"
      className="space-y-4"
      data-testid="settings-user-plugins-manage"
    >
      <div className="space-y-1">
        <h3 id="settings-user-plugins-title" className="text-base font-semibold">
          <Trans>Plugins</Trans>
        </h3>
        <p className="text-sm text-muted-foreground">
          <Trans>
            User plugins are personal to this device — turn them on or off here. The choice lives in
            your user config and is never committed to the project. Each enabled plugin gets its own
            page under Plugins in the settings sidebar.
          </Trans>
        </p>
      </div>

      <div className="rounded-md border p-3" data-testid="settings-user-plugins-list">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <Label htmlFor="settings-plugin-toggle-theme" className="text-sm font-medium">
              <Trans>Themes</Trans>
            </Label>
            <p className="text-sm text-muted-foreground">
              <Trans>
                A personal color-theme picker — not shared with your project. When on, it appears
                under Plugins in the sidebar.
              </Trans>
            </p>
          </div>
          <Switch
            id="settings-plugin-toggle-theme"
            checked={themeEnabled}
            disabled={userBinding === null}
            onCheckedChange={(next) => {
              if (!userBinding) return;
              const result = userBinding.patch({ appearance: { colorThemeEnabled: next } });
              if (!result.ok) toast.error(t`Failed to save theme setting`);
            }}
            aria-label={themeEnabled ? t`Disable Themes` : t`Enable Themes`}
            data-testid="settings-plugin-toggle-theme"
          />
        </div>
      </div>
    </section>
  );
}

/** Shared header for a per-plugin settings panel. */
function PluginSectionHeader({
  titleId,
  title,
  children,
}: {
  titleId: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1">
      <h3 id={titleId} className="text-base font-semibold">
        {title}
      </h3>
      <p className="text-sm text-muted-foreground">{children}</p>
    </div>
  );
}

/** markdownlint plugin: the full-catalog rule browser. */
export function MarkdownlintPluginSection() {
  return (
    <section
      aria-labelledby="settings-plugin-markdownlint-title"
      className="space-y-4"
      data-testid="settings-plugin-markdownlint"
    >
      <PluginSectionHeader titleId="settings-plugin-markdownlint-title" title="markdownlint">
        <Trans>
          Flag common markdown issues in the editor. Powered by{' '}
          <a
            href="https://github.com/DavidAnson/markdownlint"
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) =>
              dispatchExternalLinkClick(e, 'https://github.com/DavidAnson/markdownlint')
            }
            onAuxClick={(e) =>
              dispatchExternalLinkClick(e, 'https://github.com/DavidAnson/markdownlint')
            }
            className="inline-flex items-center gap-0.5 text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          >
            markdownlint
            <ArrowUpRight aria-hidden className="size-3" />
          </a>
          .
        </Trans>
      </PluginSectionHeader>
      <MarkdownlintRuleBrowser />
    </section>
  );
}

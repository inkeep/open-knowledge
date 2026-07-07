// biome-ignore-all lint/plugin/no-raw-html-interactive-element: pre-rule backlog — file uses raw <button> awaiting shadcn Button migration; tracked at https://github.com/inkeep/open-knowledge/blob/main/biome-plugins/README.md#no-raw-html-interactive-elementgrit
/**
 * Synchronous shell for the Settings modal — bundled in the main chunk.
 *
 * Owns the Dialog primitives, the sidebar (group computation + active-
 * section state + sidebar UI), and a Suspense boundary wrapping the
 * lazy body. The shell stays light so Cmd-, paints the dialog frame +
 * sidebar + a content-area skeleton on the same frame as the trigger,
 * while the heavy body (schema-form harness, RHF, ConfigSchema,
 * schema-walker, Sync/Templates/Okignore/Integrations sections) loads
 * in parallel and swaps in once resolved.
 *
 * The user-scope ConfigBinding is owned by ConfigProvider for the app
 * session; the shell consumes { userBinding, userSynced } from
 * useConfigContext() and gates the prop passed into the body so the
 * body's dispatch sees a synced binding or null — preserving the gating
 * semantics the dialog had before the shell/body split. Closing and
 * reopening Settings is flash-free because the provider stays warm and
 * the body chunk is cached after the first open.
 *
 * Sidebar IA:
 *   USER         → Preferences, Hotkeys, Account
 *   THIS PROJECT → Sync, Search, Templates, Ignore patterns, Config sharing
 *   INTEGRATIONS → Claude Desktop (hidden when desktopPresent === false)
 */

import { SHOW_INSTALL_SKILL } from '@inkeep/open-knowledge-core';
import { Trans, useLingui } from '@lingui/react/macro';
import { ArrowUpRight } from 'lucide-react';
import { Suspense, useEffect, useState } from 'react';
import { SettingsDialogBodyLazy } from '@/components/settings/SettingsDialogBodyLazy';
import { SettingsDialogErrorBoundary } from '@/components/settings/SettingsDialogErrorBoundary';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { useDocumentContext } from '@/editor/DocumentContext';
import { useConfigContext } from '@/lib/config-provider';
import { useClaudeDesktopIntegration } from '@/lib/handoff/use-claude-desktop-integration';
import { cn } from '@/lib/utils';

/**
 * GitHub Releases tag URL — mirrors `releaseUrlFor` in the desktop main
 * process (`packages/desktop/src/main/auto-updater.ts`), the same URL the
 * "What's new" release-notifier toast opens. Renderer-side duplicate
 * because the main-process module can't cross the preload boundary; the
 * URL shape is stable, and `encodeURIComponent` is defensive against a
 * malformed version producing a path-confusion URL.
 */
function releaseNotesUrl(version: string): string {
  return `https://github.com/inkeep/open-knowledge/releases/tag/v${encodeURIComponent(version)}`;
}

interface SidebarItem {
  id: string;
  label: string;
}

interface SidebarGroup {
  id: 'user' | 'project' | 'integrations';
  label: string;
  /**
   * `false` renders the group disabled (no-project state for THIS
   * PROJECT). Items are visible but not focusable; group label gets
   * an explanatory caption announced via aria-describedby.
   */
  enabled: boolean;
  items: SidebarItem[];
}

interface SettingsDialogShellProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function SettingsDialogShell({ open, onOpenChange }: SettingsDialogShellProps) {
  const { t } = useLingui();
  const { collabUrl } = useDocumentContext();
  const { userBinding, userSynced, okignoreBinding, okignoreSynced } = useConfigContext();
  const { desktopPresent } = useClaudeDesktopIntegration();

  // Always default to USER → Preferences on each fresh open. No
  // in-session memory of last-viewed section.
  const [activeId, setActiveId] = useState('preferences');
  useEffect(() => {
    if (open) setActiveId('preferences');
  }, [open]);

  // hasProject signals whether the project-scope binding is a valid
  // editing target. In current OK the editor UI always has a project
  // when `collabUrl` is set; the disabled-THIS-PROJECT branch is
  // defensive (e.g. Cmd-, before a project loads). Real "no project"
  // detection (e.g. `ok mcp` standalone before init) would gate via
  // a separate signal.
  const hasProject = collabUrl !== null;

  // The docked terminal is desktop-only (the real shell has no web host), so
  // its per-project revoke toggle only appears under the Electron preload.
  const isOkDesktopHost = typeof window !== 'undefined' && window.okDesktop != null;

  const groups: SidebarGroup[] = [
    {
      id: 'user',
      label: t`User`,
      enabled: true,
      items: [
        { id: 'preferences', label: t`Preferences` },
        { id: 'hotkeys', label: t`Hotkeys` },
        { id: 'account', label: t`Account` },
      ],
    },
    {
      id: 'project',
      label: t`This project`,
      enabled: hasProject,
      items: [
        { id: 'sync', label: t`Sync` },
        { id: 'search', label: t`Search` },
        ...(isOkDesktopHost ? [{ id: 'terminal', label: t`Terminal` }] : []),
        { id: 'project-templates', label: t`Templates` },
        { id: 'skills', label: t`Skills` },
        { id: 'okignore', label: t`Ignore patterns` },
        { id: 'sharing', label: t`Config sharing` },
      ],
    },
    {
      id: 'integrations',
      label: t`Integrations`,
      enabled: true,
      items:
        desktopPresent && SHOW_INSTALL_SKILL
          ? [{ id: 'claude-desktop', label: t`Claude Desktop` }]
          : [],
    },
  ];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex h-[700px] max-h-[calc(100dvh-4rem)] w-[900px] max-w-[calc(100%-2rem)] flex-col gap-0 overflow-hidden p-0 sm:grid sm:grid-cols-[220px_1fr] sm:max-w-[min(900px,calc(100%-2rem))]"
        data-testid="settings-dialog"
      >
        <DialogTitle className="sr-only">
          <Trans>Settings</Trans>
        </DialogTitle>
        <DialogDescription className="sr-only">
          <Trans>Configure user, project, and integration settings.</Trans>
        </DialogDescription>
        <SettingsSidebar groups={groups} activeId={activeId} onSelect={setActiveId} />
        <section
          aria-label={t`Settings content`}
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain subtle-scrollbar p-6"
          // biome-ignore lint/a11y/noNoninteractiveTabindex: this scrollable content section must be focusable so keyboard users can scroll long settings pages.
          tabIndex={0}
        >
          <SettingsDialogErrorBoundary>
            <Suspense fallback={<SettingsContentSkeleton />}>
              <SettingsDialogBodyLazy
                activeId={activeId}
                userBinding={userSynced ? userBinding : null}
                okignoreBinding={okignoreBinding}
                okignoreSynced={okignoreSynced}
              />
            </Suspense>
          </SettingsDialogErrorBoundary>
        </section>
      </DialogContent>
    </Dialog>
  );
}

interface SettingsSidebarProps {
  groups: SidebarGroup[];
  activeId: string;
  onSelect: (id: string) => void;
}

function SettingsSidebar({ groups, activeId, onSelect }: SettingsSidebarProps) {
  const { t } = useLingui();
  // Single navigation landmark with an explicit label. A complementary
  // landmark wrapping an unlabeled navigation produced two nested
  // landmarks for one sidebar — landmark navigation surfaced both
  // stops for what is one navigation surface. The sidebar IS the
  // primary navigation for the dialog content (clicks swap the active
  // body section), not tangentially-related content, so the
  // navigation role is the semantically correct outer element.
  return (
    <nav
      aria-label={t`Settings sections`}
      className="flex shrink-0 gap-x-3 overflow-x-auto overscroll-contain subtle-scrollbar scroll-fade-mask-x-max-sm border-b bg-muted/30 px-3 py-2 max-sm:pt-10 sm:h-full sm:flex-col sm:gap-0 sm:overflow-x-visible sm:overflow-y-auto sm:border-r sm:border-b-0 sm:py-4"
    >
      {groups.map((group) => (
        <SettingsSidebarGroup
          key={group.id}
          group={group}
          activeId={activeId}
          onSelect={onSelect}
        />
      ))}
      <SettingsSidebarVersion />
    </nav>
  );
}

/**
 * Bottom-pinned version + release-notes link. `mt-auto` works in the
 * sm+ vertical flex-col layout; in the max-sm horizontal layout the
 * footer trails after the last group (no `mt-auto` effect when the
 * parent is `flex-row`), which is the natural mobile behavior.
 *
 * Source of the version string:
 *   - Electron (`window.okDesktop?.appVersion`) — trusted, read from
 *     `app.getVersion()` at boot via the bridge contract.
 *   - Web — no equivalent runtime signal; the footer is suppressed
 *     entirely so we never render `v` or `vundefined`.
 *
 * Click action mirrors the "What's new" toast (Notice B in
 * `UpdateNotices.shared.ts`): `bridge.shell.openExternal(releaseUrl)`
 * routes through the main-process asset allowlist. The bridge is
 * guaranteed present whenever `appVersion` is — both are properties of
 * the same Electron preload contract.
 */
function SettingsSidebarVersion() {
  const bridge = typeof window !== 'undefined' ? (window.okDesktop ?? null) : null;
  const version = bridge?.appVersion;
  if (!bridge || !version) return null;

  const url = releaseNotesUrl(version);
  return (
    <div className="ml-auto shrink-0 px-2 sm:ml-0 sm:mt-auto sm:pt-3">
      <p
        className="whitespace-nowrap font-mono text-xs text-muted-foreground/70"
        data-testid="settings-sidebar-version"
      >
        v{version}
      </p>
      <button
        type="button"
        onClick={() => {
          void bridge.shell.openExternal(url);
        }}
        data-testid="settings-sidebar-release-notes"
        className={cn(
          'mt-0.5 inline-flex items-center gap-1 whitespace-nowrap rounded text-xs text-muted-foreground transition-colors hover:text-foreground',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        )}
      >
        <Trans>Release notes</Trans>
        <ArrowUpRight className="size-3" aria-hidden="true" />
      </button>
    </div>
  );
}

function SettingsSidebarGroup({
  group,
  activeId,
  onSelect,
}: {
  group: SidebarGroup;
  activeId: string;
  onSelect: (id: string) => void;
}) {
  if (group.items.length === 0) return null;
  const headerId = `settings-group-${group.id}`;
  const captionId = `${headerId}-caption`;
  return (
    <div className="flex shrink-0 items-center gap-2 sm:mb-4 sm:block">
      <h3
        id={headerId}
        aria-describedby={group.enabled ? undefined : captionId}
        className={cn(
          'shrink-0 whitespace-nowrap px-2 text-xs font-semibold uppercase tracking-wide font-mono sm:mb-1',
          group.enabled ? 'text-muted-foreground/80' : 'text-muted-foreground/50',
        )}
      >
        {group.label}
      </h3>
      {!group.enabled ? (
        <p id={captionId} className="px-2 text-xs italic text-muted-foreground/60 sm:mb-1">
          <Trans>Open a project to edit.</Trans>
        </p>
      ) : null}
      <ul aria-labelledby={headerId} className="flex gap-1 sm:block sm:space-y-0.5">
        {group.items.map((item) => (
          <li key={item.id}>
            <button
              type="button"
              // `aria-current="page"` is the specific match for an in-
              // dialog navigator that swaps the body content — wrapped
              // in a navigation landmark, each click is page-like
              // navigation within the dialog. Screen readers announce
              // "current page" instead of the less-informative generic
              // "current" that the unscoped `'true'` value produces.
              aria-current={activeId === item.id ? 'page' : undefined}
              aria-disabled={group.enabled ? undefined : true}
              // Disabled buttons get the same caption the group header
              // does — without this, a SR user who navigates directly
              // to a disabled button (form/button rotor, arrow keys in
              // browse mode) hears "Sync, dimmed, button" with no
              // context for why it's disabled. tabIndex=-1 keeps them
              // out of sequential tab order; aria-describedby surfaces
              // the "Open a project to edit." caption when they reach
              // the control by other means.
              aria-describedby={group.enabled ? undefined : captionId}
              tabIndex={group.enabled ? 0 : -1}
              disabled={!group.enabled}
              onClick={() => group.enabled && onSelect(item.id)}
              data-testid={`settings-sidebar-item-${item.id}`}
              className={cn(
                'w-auto whitespace-nowrap rounded px-2 py-1.5 text-left text-sm transition-colors sm:w-full',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                'disabled:cursor-not-allowed disabled:opacity-50',
                activeId === item.id && group.enabled
                  ? 'bg-accent text-accent-foreground'
                  : 'hover:bg-accent/50',
              )}
            >
              {item.label}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Paints inside the already-rendered dialog frame while the body chunk
 * resolves. The shell ships in the main bundle so the dialog frame +
 * sidebar are visible immediately and the content area shows shape-
 * matching placeholders that swap to real content without a frame flash.
 */
function SettingsContentSkeleton() {
  // The skeleton IS the async loading state for the lazy body chunk.
  // Announce it as a polite live region with aria-busy so AT users get
  // a non-interrupting signal that content is loading — without this,
  // a screen-reader user opening Settings hears the landmarks and
  // sidebar then encounters a silent content pane until the body
  // resolves. Mirrors the `role="status" aria-live="polite"` precedent
  // used by SavedIndicator in the body. Suspense unmounts this on body
  // resolve, so aria-busy doesn't need to flip — it's just gone.
  return (
    <div
      role="status"
      aria-live="polite"
      aria-busy="true"
      className="space-y-3"
      data-testid="settings-content-skeleton"
    >
      <span className="sr-only">
        <Trans>Loading settings</Trans>
      </span>
      <Skeleton className="h-5 w-32" />
      <Skeleton className="h-4 w-64" />
      <div className="space-y-2">
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-9 w-full" />
      </div>
    </div>
  );
}

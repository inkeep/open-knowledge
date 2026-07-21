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
 *   USER         → Preferences, Hotkeys, Account, Plugins (user-scope manage),
 *                  AI tools & CLI (Electron host only)
 *   THIS PROJECT → Sync, Search, Plugins (project-scope manage), Link previews
 *                  (hidden on the packaged file:// renderer), Templates, Ignore
 *                  patterns, Config sharing
 *   PLUGINS      → one panel per enabled plugin (project + user, side by side)
 *   INTEGRATIONS → Claude Desktop (hidden when desktopPresent === false)
 */

import { SHOW_INSTALL_SKILL } from '@inkeep/open-knowledge-core';
import { Plural, Trans, useLingui } from '@lingui/react/macro';
import { ArrowUpRight } from 'lucide-react';
import { Suspense, useEffect, useRef, useState } from 'react';
import { matchesCommandQuery, splitTextByQueryMatches } from '@/components/command-palette-search';
import { SettingsDialogBodyLazy } from '@/components/settings/SettingsDialogBodyLazy';
import { SettingsDialogErrorBoundary } from '@/components/settings/SettingsDialogErrorBoundary';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { useDocumentContext } from '@/editor/DocumentContext';
import { useConfigContext } from '@/lib/config-provider';
import { isFileProtocolPage } from '@/lib/file-protocol-page';
import { useClaudeDesktopIntegration } from '@/lib/handoff/use-claude-desktop-integration';
import { cn } from '@/lib/utils';
import { LINT_PLUGIN_META } from './lint-plugin-meta';
import { buildSettingsSearchIndex, type SettingsSearchEntry } from './settings-search-index';
import type { SidebarGroup, SidebarItem } from './settings-sidebar-types';

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

interface SettingsDialogShellProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function SettingsDialogShell({ open, onOpenChange }: SettingsDialogShellProps) {
  const { t } = useLingui();
  const { collabUrl } = useDocumentContext();
  const { userBinding, userSynced, okignoreBinding, okignoreSynced, projectConfig, merged } =
    useConfigContext();
  const { desktopPresent } = useClaudeDesktopIntegration();

  // Always default to USER → Preferences on each fresh open. No
  // in-session memory of last-viewed section.
  const [activeId, setActiveId] = useState('preferences');
  const [searchQuery, setSearchQuery] = useState('');
  // Navigation tokens set by a search-result click. fieldFlash re-fires its
  // consuming effect via object identity alone (each click sets a fresh
  // object, same path or not). ruleQuery carries a nonce because its consumer
  // (the markdownlint browser) keys its re-seed effect on primitive values
  // threaded through props — identical query strings need the nonce to re-fire.
  const [fieldFlash, setFieldFlash] = useState<{ path: string } | null>(null);
  const [ruleQuery, setRuleQuery] = useState<{ query: string; nonce: number } | null>(null);
  const navNonceRef = useRef(0);
  const contentRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (open) {
      setActiveId('preferences');
      setSearchQuery('');
    }
  }, [open]);

  // Imperative scroll-to-flash for a field the search navigated to. The target
  // renders inside the lazily-loaded body and, for schema sections, only once
  // its config binding has synced — so it can appear well after this effect
  // fires. Rather than a fixed-frame retry (which can expire before the field
  // mounts), watch the content subtree with a capped MutationObserver and flash
  // the moment the `[data-field]` node appears. Uses a dedicated one-shot class
  // no field's React `className` owns, so a re-render can't strip it mid-flash.
  useEffect(() => {
    if (!fieldFlash) return;
    const container = contentRef.current;
    if (!container) return;
    const FLASH_CLASS = 'animate-settings-nav-flash';
    let flashed: HTMLElement | null = null;
    let removeTimer: ReturnType<typeof setTimeout> | null = null;
    let giveUpTimer: ReturnType<typeof setTimeout> | null = null;
    let observer: MutationObserver | null = null;

    const tryFlash = (): boolean => {
      const el = container.querySelector<HTMLElement>(`[data-field="${fieldFlash.path}"]`);
      if (!el) return false;
      el.scrollIntoView({ block: 'center' });
      el.classList.add(FLASH_CLASS);
      flashed = el;
      removeTimer = setTimeout(() => el.classList.remove(FLASH_CLASS), 750);
      return true;
    };

    if (!tryFlash()) {
      // Field not mounted yet — watch for it, capped so we never observe forever.
      observer = new MutationObserver(() => {
        if (tryFlash()) observer?.disconnect();
      });
      observer.observe(container, { childList: true, subtree: true });
      giveUpTimer = setTimeout(() => observer?.disconnect(), 4000);
    }

    return () => {
      observer?.disconnect();
      if (removeTimer) clearTimeout(removeTimer);
      if (giveUpTimer) clearTimeout(giveUpTimer);
      flashed?.classList.remove(FLASH_CLASS);
    };
  }, [fieldFlash]);

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

  // One sidebar item per ENABLED project-scope plugin. These populate the
  // "Project plugins" sidebar group; the manage page (which toggles membership)
  // lives under "This project".
  const enabledPluginItems: SidebarItem[] = LINT_PLUGIN_META.filter(
    (p) => projectConfig?.contentRules?.[p.id]?.enabled === true,
  ).map((p) => ({ id: `plugin:${p.id}`, label: p.label }));

  // The theme is a user-scope plugin, toggled on the Plugins-manage page
  // (`appearance.colorThemeEnabled`, default on). When off it drops out of the
  // "User plugins" sidebar group.
  const themeEnabled = merged?.appearance?.colorThemeEnabled !== false;

  // The packaged desktop renderer loads over file:// (desktop main's
  // loadFile), so its POST /api/link-preview requests carry Origin: null,
  // which the route's anti-proxy gate rejects by design (see
  // packages/server/src/link-preview/request-gate.ts). External link
  // previews can never render on that host, so hide the toggle instead of
  // promising a setting that cannot work. The DEV desktop renderer loads
  // from http://localhost (loopback Origin, gate passes) and keeps the
  // item. Remove this gate when a loopback-origin/desktop discriminator
  // ships.
  const isFileProtocolRenderer = isFileProtocolPage();

  const groups: SidebarGroup[] = [
    {
      id: 'user',
      label: t`User`,
      enabled: true,
      items: [
        { id: 'preferences', label: t`Preferences` },
        { id: 'hotkeys', label: t`Hotkeys` },
        { id: 'account', label: t`Account` },
        // User-scope plugin management (toggle personal plugins like Themes).
        { id: 'user-plugins-manage', label: t`Plugins` },
        // Machine-level OK footprint (per-editor MCP entries, Agent Skills,
        // the ok PATH command) — user-scoped, and desktop-only because the
        // install actors live in the Electron main process.
        ...(isOkDesktopHost ? [{ id: 'ai-tools', label: t`AI tools & CLI` }] : []),
      ],
    },
    {
      id: 'project',
      label: t`This project`,
      enabled: hasProject,
      items: [
        { id: 'sync', label: t`Sync` },
        { id: 'search', label: t`Search` },
        { id: 'plugins-manage', label: t`Plugins` },
        ...(isFileProtocolRenderer ? [] : [{ id: 'link-previews', label: t`Link previews` }]),
        ...(isOkDesktopHost ? [{ id: 'terminal', label: t`Terminal` }] : []),
        // Per-project MCP wiring + runtime skill — desktop-only because the
        // install actors live in the Electron main process (like Terminal).
        ...(isOkDesktopHost ? [{ id: 'project-ai-tools', label: t`AI tools` }] : []),
        { id: 'project-templates', label: t`Templates` },
        { id: 'skills', label: t`Skills` },
        { id: 'okignore', label: t`Ignore patterns` },
        { id: 'sharing', label: t`Config sharing` },
      ],
    },
    // Dedicated group listing every ENABLED plugin's own panel — project-scope
    // lint plugins (shown when a project is open) and the user-scope theme
    // plugin, side by side. Membership is toggled on the per-scope Plugins
    // manage pages (User → Plugins, This project → Plugins).
    {
      id: 'plugins',
      label: t`Plugins`,
      enabled: true,
      items: [
        ...(hasProject ? enabledPluginItems : []),
        ...(themeEnabled ? [{ id: 'plugin:theme', label: t`Themes` }] : []),
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

  // Deep search corpus, derived from `groups` so every enablement gate
  // (disabled THIS-PROJECT, absent/disabled plugins, desktop-only items) is
  // inherited — disabled-plugin rules never surface. `t` resolves the FieldDef
  // `MessageDescriptor` labels, the same call the body renders them with.
  const searchEntries = buildSettingsSearchIndex({ groups, translate: t });

  function handleNavigate(entry: SettingsSearchEntry) {
    navNonceRef.current += 1;
    const nonce = navNonceRef.current;
    setActiveId(entry.sectionId);
    if (entry.kind === 'field' && entry.targetField) {
      setFieldFlash({ path: entry.targetField });
    } else if (entry.kind === 'rule' && entry.ruleId) {
      setRuleQuery({ query: entry.ruleId, nonce });
    }
    // Clearing the query collapses the results and restores the plain group nav
    // on the now-active section.
    setSearchQuery('');
  }

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
        <SettingsSidebar
          groups={groups}
          activeId={activeId}
          onSelect={setActiveId}
          entries={searchEntries}
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
          onNavigate={handleNavigate}
        />
        <section
          ref={contentRef}
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
                markdownlintRuleQuery={ruleQuery}
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
  entries: SettingsSearchEntry[];
  searchQuery: string;
  onSearchChange: (value: string) => void;
  onNavigate: (entry: SettingsSearchEntry) => void;
}

function SettingsSidebar({
  groups,
  activeId,
  onSelect,
  entries,
  searchQuery,
  onSearchChange,
  onNavigate,
}: SettingsSidebarProps) {
  const { t } = useLingui();
  const query = searchQuery.trim();
  const results =
    query === ''
      ? []
      : entries.filter((entry) => matchesCommandQuery(entry.label, query, entry.keywords));
  const sectionResults = results.filter((entry) => entry.kind === 'section');
  const fieldResults = results.filter((entry) => entry.kind === 'field');
  const ruleResults = results.filter((entry) => entry.kind === 'rule');

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
      className="flex shrink-0 gap-x-3 overflow-x-auto overscroll-contain subtle-scrollbar scroll-fade-mask-x-max-sm border-b bg-muted/30 px-3 py-2 max-sm:pt-10 sm:h-full sm:min-h-0 sm:flex-col sm:gap-0 sm:overflow-x-visible sm:border-r sm:border-b-0 sm:py-4"
    >
      {/* cmdk surface wraps ONLY the search input + results — its roving focus
          never touches the plain-button group nav below (which keeps its
          aria-current + disabled-group semantics). The popover-styled base
          classes are reset so it sits flush as a plain sidebar search box. */}
      <Command
        shouldFilter={false}
        className="h-auto w-full shrink-0 rounded-md border bg-transparent sm:mb-3"
        data-testid="settings-search"
      >
        <CommandInput
          value={searchQuery}
          onValueChange={onSearchChange}
          placeholder={t`Search settings`}
          data-testid="settings-search-input"
        />
        {/* Polite result-count announcement — cmdk's listbox semantics don't
            tell SR users how many results a keystroke produced. Always mounted
            (empty when idle) so the live region exists before it updates. */}
        <span aria-live="polite" className="sr-only" data-testid="settings-search-result-count">
          {query !== '' ? <Plural value={results.length} one="# result" other="# results" /> : null}
        </span>
        {query !== '' ? (
          <CommandList data-testid="settings-search-results">
            <CommandEmpty data-testid="settings-search-empty">
              <Trans>No settings found</Trans>
            </CommandEmpty>
            {sectionResults.length > 0 ? (
              <CommandGroup heading={t`Sections`}>
                {sectionResults.map((entry) => (
                  <SettingsSearchResultItem
                    key={entry.id}
                    entry={entry}
                    query={query}
                    onNavigate={onNavigate}
                  />
                ))}
              </CommandGroup>
            ) : null}
            {fieldResults.length > 0 ? (
              <CommandGroup heading={t`Settings`}>
                {fieldResults.map((entry) => (
                  <SettingsSearchResultItem
                    key={entry.id}
                    entry={entry}
                    query={query}
                    onNavigate={onNavigate}
                  />
                ))}
              </CommandGroup>
            ) : null}
            {ruleResults.length > 0 ? (
              <CommandGroup heading={t`markdownlint rules`}>
                {ruleResults.map((entry) => (
                  <SettingsSearchResultItem
                    key={entry.id}
                    entry={entry}
                    query={query}
                    onNavigate={onNavigate}
                  />
                ))}
              </CommandGroup>
            ) : null}
          </CommandList>
        ) : null}
      </Command>

      {/* Scroll region — keeps the search box above pinned in view while the
          group list scrolls. `contents` on mobile leaves the group chips in the
          nav's horizontal row unchanged; sm+ it becomes the vertical scroller. */}
      <div className="contents subtle-scrollbar sm:flex sm:min-h-0 sm:flex-1 sm:flex-col sm:overflow-y-auto sm:overscroll-contain">
        {/* Plain group nav — the sole content when not searching. */}
        {query === ''
          ? groups.map((group) => (
              <SettingsSidebarGroup
                key={group.id}
                group={group}
                activeId={activeId}
                onSelect={onSelect}
              />
            ))
          : null}
        <SettingsSidebarVersion />
      </div>
    </nav>
  );
}

/**
 * One search result row. The label's matched substrings are emphasized via the
 * command-palette's `splitTextByQueryMatches` helper (reused, not reinvented).
 */
function SettingsSearchResultItem({
  entry,
  query,
  onNavigate,
}: {
  entry: SettingsSearchEntry;
  query: string;
  onNavigate: (entry: SettingsSearchEntry) => void;
}) {
  return (
    <CommandItem
      value={entry.id}
      onSelect={() => onNavigate(entry)}
      data-testid={`settings-search-result-${entry.id}`}
    >
      <span className="truncate">
        {splitTextByQueryMatches(entry.label, query).map((segment) =>
          segment.match ? (
            <span key={segment.start} className="font-semibold text-foreground">
              {segment.text}
            </span>
          ) : (
            <span key={segment.start}>{segment.text}</span>
          ),
        )}
      </span>
    </CommandItem>
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

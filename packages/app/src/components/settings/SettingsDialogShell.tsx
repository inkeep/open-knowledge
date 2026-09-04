// biome-ignore-all lint/plugin/no-raw-html-interactive-element: pre-rule backlog — file uses raw <button> awaiting shadcn Button migration; tracked at https://github.com/inkeep/open-knowledge/blob/main/biome-plugins/README.md#no-raw-html-interactive-elementgrit

// biome-ignore-all lint/plugin/no-physical-direction-utility: pre-rule backlog — physical margin/padding/inset utilities predate the rule; drain by swapping ml/mr → ms/me, pl/pr → ps/pe, left/right → start/end, then deleting this line. See https://github.com/inkeep/open-knowledge/blob/main/biome-plugins/README.md#no-physical-direction-utilitygrit

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
import { electronDragBandClearance } from '@/components/ui/electron-drag-strip';
import { Skeleton } from '@/components/ui/skeleton';
import { useDocumentContext } from '@/editor/DocumentContext';
import { useConfigContext } from '@/lib/config-provider';
import { isFileProtocolPage } from '@/lib/file-protocol-page';
import { useClaudeDesktopIntegration } from '@/lib/handoff/use-claude-desktop-integration';
import { subscribeToSettingsSection } from '@/lib/use-settings-route';
import { cn } from '@/lib/utils';
import { LINT_PLUGIN_META } from './lint-plugin-meta';
import {
  isOkDesktopHost as isOkDesktopHostGate,
  isTerminalSettingsAvailable,
} from './settings-host-gates';
import { buildSettingsSearchIndex, type SettingsSearchEntry } from './settings-search-index';
import type { SidebarGroup, SidebarItem, SidebarSubsection } from './settings-sidebar-types';

function releaseNotesUrl(version: string): string {
  return `https://github.com/inkeep/open-knowledge/releases/tag/v${encodeURIComponent(version)}`;
}

const LEGACY_SECTION_ALIASES: Record<string, { sectionId: string; anchor: string }> = {
  'content-rules': { sectionId: 'project-preferences', anchor: 'section:content-rules' },
  terminal: { sectionId: 'project-preferences', anchor: 'section:terminal' },
  sharing: { sectionId: 'sync', anchor: 'section:sharing' },
};

function resolveSectionTarget(sectionId: string): { sectionId: string; anchor: string | null } {
  const alias = LEGACY_SECTION_ALIASES[sectionId];
  return alias ? { sectionId: alias.sectionId, anchor: alias.anchor } : { sectionId, anchor: null };
}

function resolveSectionId(sectionId: string): string {
  return resolveSectionTarget(sectionId).sectionId;
}

interface SettingsDialogShellProps {
  open: boolean;
  initialSection?: string | null;
  onOpenChange: (open: boolean) => void;
}

export function SettingsDialogShell({
  open,
  initialSection = null,
  onOpenChange,
}: SettingsDialogShellProps) {
  const { t } = useLingui();
  const { collabUrl } = useDocumentContext();
  const { userBinding, userSynced, okignoreBinding, okignoreSynced, projectConfig, merged } =
    useConfigContext();
  const { desktopPresent } = useClaudeDesktopIntegration();

  const [activeId, setActiveId] = useState(resolveSectionId(initialSection ?? 'preferences'));
  const [searchQuery, setSearchQuery] = useState('');
  const [fieldFlash, setFieldFlash] = useState<{ path: string } | null>(null);
  const [ruleQuery, setRuleQuery] = useState<{ query: string; nonce: number } | null>(null);
  const navNonceRef = useRef(0);
  const contentRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (open) {
      const target = resolveSectionTarget(initialSection ?? 'preferences');
      setActiveId(target.sectionId);
      setFieldFlash(target.anchor ? { path: target.anchor } : null);
      setSearchQuery('');
    }
  }, [open, initialSection]);

  useEffect(
    () =>
      subscribeToSettingsSection((sectionId) => {
        const target = resolveSectionTarget(sectionId);
        setActiveId(target.sectionId);
        if (target.anchor) setFieldFlash({ path: target.anchor });
      }),
    [],
  );

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

  const hasProject = collabUrl !== null;

  const isOkDesktopHost = isOkDesktopHostGate();
  const terminalSettingsAvailable = isTerminalSettingsAvailable();

  const enabledPluginItems: SidebarItem[] = LINT_PLUGIN_META.filter(
    (p) => projectConfig?.contentRules?.[p.id]?.enabled === true,
  ).map((p) => ({ id: `plugin:${p.id}`, label: p.label }));

  const themeEnabled = merged?.appearance?.colorThemeEnabled !== false;

  const slidesEnabled = merged?.slides?.enabled === true;

  const isFileProtocolRenderer = isFileProtocolPage();

  const groups: SidebarGroup[] = [
    {
      id: 'user',
      label: t`User`,
      enabled: true,
      items: [
        { id: 'preferences', label: t`Preferences` },
        { id: 'configure-agents', label: t`Configure agents` },
        { id: 'hotkeys', label: t`Hotkeys` },
        { id: 'account', label: t`Account` },
        { id: 'user-plugins-manage', label: t`Plugins` },
        { id: 'user-skills', label: t`Skills Studio` },
        ...(isOkDesktopHost ? [{ id: 'ai-tools', label: t`AI tools & CLI` }] : []),
      ],
    },
    {
      id: 'project',
      label: t`This project`,
      enabled: hasProject,
      items: [
        {
          id: 'project-preferences',
          label: t`Preferences`,
          subsections: [
            { id: 'attachments', label: t`Attachments`, anchor: 'content.attachmentFolderPath' },
            { id: 'content-rules', label: t`Content rules`, anchor: 'section:content-rules' },
            ...(terminalSettingsAvailable
              ? [{ id: 'terminal', label: t`Terminal`, anchor: 'section:terminal' }]
              : []),
          ] satisfies SidebarSubsection[],
        },
        {
          id: 'sync',
          label: t`Sync & sharing`,
          subsections: [
            { id: 'sharing', label: t`Config sharing`, anchor: 'section:sharing' },
          ] satisfies SidebarSubsection[],
        },
        { id: 'search', label: t`Search` },
        { id: 'plugins-manage', label: t`Plugins` },
        ...(isFileProtocolRenderer ? [] : [{ id: 'link-previews', label: t`Link previews` }]),
        ...(isOkDesktopHost ? [{ id: 'project-ai-tools', label: t`AI tools` }] : []),
        ...(isOkDesktopHost ? [{ id: 'network-access', label: t`Remote control` }] : []),
        { id: 'project-templates', label: t`Templates` },
        { id: 'skills', label: t`Skills Studio` },
        { id: 'okignore', label: t`Ignore patterns` },
      ],
    },
    {
      id: 'plugins',
      label: t`Plugins`,
      enabled: true,
      items: [
        ...(hasProject ? enabledPluginItems : []),
        ...(themeEnabled ? [{ id: 'plugin:theme', label: t`Themes` }] : []),
        ...(slidesEnabled ? [{ id: 'plugin:slides', label: t`Slidev` }] : []),
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
    setSearchQuery('');
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={cn(
          'flex h-[700px] max-h-[calc(100dvh-4rem)] w-[900px] max-w-[calc(100%-2rem)] flex-col gap-0 overflow-hidden p-0 sm:grid sm:grid-cols-[220px_1fr] sm:max-w-[min(900px,calc(100%-2rem))]',
          electronDragBandClearance(),
        )}
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

  return (
    <nav
      aria-label={t`Settings sections`}
      className="flex shrink-0 gap-x-3 overflow-x-auto overscroll-contain subtle-scrollbar scroll-fade-mask-x-max-sm border-b bg-muted/30 px-3 py-2 max-sm:pt-10 sm:h-full sm:min-h-0 sm:flex-col sm:gap-0 sm:overflow-x-visible sm:border-r sm:border-b-0 sm:py-4"
    >
      {}
      <Command
        shouldFilter={false}
        className="h-auto w-full shrink-0 bg-transparent sm:mb-3 [&_[data-slot=command-input-wrapper]]:h-9 [&_[data-slot=command-input-wrapper]]:rounded-lg [&_[data-slot=command-input-wrapper]]:border [&_[data-slot=command-input-wrapper]]:border-input"
        data-testid="settings-search"
      >
        <CommandInput
          value={searchQuery}
          onValueChange={onSearchChange}
          placeholder={t`Search settings`}
          className="py-0"
          data-testid="settings-search-input"
        />
        {}
        <span aria-live="polite" className="sr-only" data-testid="settings-search-result-count">
          {query !== '' ? <Plural value={results.length} one="# result" other="# results" /> : null}
        </span>
        {query !== '' ? (
          <CommandList data-testid="settings-search-results" className="mt-1.5">
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

      {}
      <div className="contents subtle-scrollbar sm:flex sm:min-h-0 sm:flex-1 sm:flex-col sm:overflow-y-auto sm:overscroll-contain">
        {}
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
      {}
      <span className="min-w-0 truncate">
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
      {}
      {entry.context !== undefined ? (
        <span className="ms-auto shrink-0 truncate ps-3 text-1sm text-muted-foreground">
          {entry.context}
        </span>
      ) : null}
    </CommandItem>
  );
}

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
              aria-current={activeId === item.id ? 'page' : undefined}
              aria-disabled={group.enabled ? undefined : true}
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

function SettingsContentSkeleton() {
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

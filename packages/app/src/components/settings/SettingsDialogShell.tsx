// oxlint-disable ok/no-raw-html-interactive-element -- pre-rule backlog — file uses raw <button> awaiting shadcn Button migration; tracked at https://github.com/inkeep/open-knowledge/blob/main/lint-plugins/ok-rules/README.md#no-raw-html-interactive-element

// oxlint-disable ok/no-physical-direction-utility -- pre-rule backlog — physical margin/padding/inset utilities predate the rule; drain by swapping ml/mr → ms/me, pl/pr → ps/pe, left/right → start/end, then deleting this line. See https://github.com/inkeep/open-knowledge/blob/main/lint-plugins/ok-rules/README.md#no-physical-direction-utility

import { SHOW_INSTALL_SKILL } from '@inkeep/open-knowledge-core/constants/feature-flags';
import { Plural, Trans, useLingui } from '@lingui/react/macro';
import { Suspense, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { matchesCommandQuery, splitTextByQueryMatches } from '@/components/command-palette-search';
import { SettingsDialogBodyLazy } from '@/components/settings/SettingsDialogBodyLazy';
import { SettingsDialogErrorBoundary } from '@/components/settings/SettingsDialogErrorBoundary';
import { UPDATE_CHECKING_NOTICE_ID } from '@/components/UpdateNotices.shared';
import { Button } from '@/components/ui/button';
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
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { useDocumentContext } from '@/editor/DocumentContext';
import type { ConfigContextValue } from '@/lib/config-context';
import { useConfigContext } from '@/lib/config-provider';
import { isFileProtocolPage } from '@/lib/file-protocol-page';
import { useClaudeDesktopIntegration } from '@/lib/handoff/use-claude-desktop-integration';
import { getNoticesSnapshot, subscribeToNotices } from '@/lib/update-notices-store';
import { subscribeToSettingsSection } from '@/lib/use-settings-route';
import { cn } from '@/lib/utils';
import { LINT_PLUGIN_META } from './lint-plugin-meta';
import {
  isOkDesktopHost as isOkDesktopHostGate,
  isSpellcheckLanguageSelectionAvailable,
  isTerminalSettingsAvailable,
} from './settings-host-gates';
import {
  isSidebarItemSelectable,
  type SettingsHost,
  scopeSettingsGroupsForHost,
} from './settings-host-scope';
import { buildSettingsSearchIndex, type SettingsSearchEntry } from './settings-search-index';
import { AGENT_CONNECTIONS_SECTION_LABEL } from './settings-section-labels';
import type { SidebarGroup, SidebarItem, SidebarSubsection } from './settings-sidebar-types';

const LEGACY_SECTION_ALIASES: Record<string, { sectionId: string; anchor: string }> = {
  'ai-tools': { sectionId: 'agent-connections', anchor: 'section:agent-connections' },
  'project-ai-tools': { sectionId: 'agent-connections', anchor: 'section:agent-connections' },
  'configure-agents': { sectionId: 'agent-connections', anchor: 'section:agent-connections' },
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
  host?: SettingsHost;
}

export function SettingsDialogShell({ host = 'project', ...props }: SettingsDialogShellProps) {
  return host === 'navigator' ? (
    <NavigatorSettingsDialogShell {...props} />
  ) : (
    <ProjectSettingsDialogShell {...props} />
  );
}

type SettingsDialogHostProps = Omit<SettingsDialogShellProps, 'host'>;

function ProjectSettingsDialogShell(props: SettingsDialogHostProps) {
  const { collabUrl } = useDocumentContext();
  const config = useConfigContext();
  const { desktopPresent } = useClaudeDesktopIntegration();
  return (
    <SettingsDialogFrame
      {...props}
      host="project"
      hasProject={collabUrl !== null}
      config={config}
      desktopPresent={desktopPresent}
      integrationsMenuAvailable={false}
    />
  );
}

function NavigatorSettingsDialogShell(props: SettingsDialogHostProps) {
  const config = useConfigContext();
  const integrationsMenuAvailable = useIntegrationsMenuAvailable();
  return (
    <SettingsDialogFrame
      {...props}
      host="navigator"
      hasProject={false}
      config={config}
      desktopPresent={false}
      integrationsMenuAvailable={integrationsMenuAvailable}
    />
  );
}

function useIntegrationsMenuAvailable(): boolean {
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    const menu = window.okDesktop?.menu;
    if (!menu) return;
    let cancelled = false;
    menu
      .dispatch({ kind: 'query' })
      .then((snapshot) => {
        if (!cancelled) setAvailable(snapshot?.canReconfigureMcpWiring === true);
      })
      .catch((error: unknown) => {
        console.warn('[SettingsDialogShell] Could not read the desktop menu state', error);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return available;
}

interface SettingsDialogFrameProps extends SettingsDialogHostProps {
  host: SettingsHost;
  hasProject: boolean;
  config: ConfigContextValue;
  desktopPresent: boolean;
  integrationsMenuAvailable: boolean;
}

function SettingsDialogFrame({
  open,
  initialSection = null,
  onOpenChange,
  host,
  hasProject,
  config,
  desktopPresent,
  integrationsMenuAvailable,
}: SettingsDialogFrameProps) {
  const { t } = useLingui();
  const {
    userBinding,
    userSynced,
    userLoadFailed,
    okignoreBinding,
    okignoreSynced,
    projectConfig,
    merged,
  } = config;

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
      const closedDisclosure = el.closest('[data-slot="collapsible"][data-state="closed"]');
      if (closedDisclosure) {
        closedDisclosure
          .querySelector<HTMLButtonElement>('[data-slot="collapsible-trigger"]')
          ?.click();
        return false;
      }
      el.scrollIntoView({ block: 'center' });
      el.classList.add(FLASH_CLASS);
      flashed = el;
      removeTimer = setTimeout(() => el.classList.remove(FLASH_CLASS), 750);
      return true;
    };

    observer = new MutationObserver(() => {
      if (!tryFlash()) return;
      observer?.disconnect();
      if (giveUpTimer) {
        clearTimeout(giveUpTimer);
        giveUpTimer = null;
      }
    });
    observer.observe(container, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['data-state'],
    });
    if (tryFlash()) {
      observer.disconnect();
    } else {
      giveUpTimer = setTimeout(() => observer?.disconnect(), 15_000);
    }

    return () => {
      observer?.disconnect();
      if (removeTimer) clearTimeout(removeTimer);
      if (giveUpTimer) clearTimeout(giveUpTimer);
      flashed?.classList.remove(FLASH_CLASS);
    };
  }, [fieldFlash]);

  const isOkDesktopHost = isOkDesktopHostGate();
  const terminalSettingsAvailable = isTerminalSettingsAvailable();
  const spellcheckLanguagesAvailable = isSpellcheckLanguageSelectionAvailable();

  const enabledPluginItems: SidebarItem[] = LINT_PLUGIN_META.filter(
    (p) => projectConfig?.contentRules?.[p.id]?.enabled === true,
  ).map((p) => ({ id: `plugin:${p.id}`, label: p.label }));

  const themeEnabled = merged?.appearance?.colorThemeEnabled !== false;

  const slidesEnabled = merged?.slides?.enabled === true;

  const isFileProtocolRenderer = isFileProtocolPage();

  const declaredGroups: SidebarGroup[] = [
    {
      id: 'agents',
      label: t`Agents`,
      enabled: true,
      ...(integrationsMenuAvailable
        ? {
            disabledHint: t`To connect AI tools without a project, use File > Set up OpenKnowledge integrations…`,
          }
        : {}),
      items: [
        {
          id: 'agent-connections',
          label: t(AGENT_CONNECTIONS_SECTION_LABEL),
          keywords: [t`AI tools`, t`Configure agents`],
        },
      ],
    },
    {
      id: 'user',
      label: t`User`,
      enabled: true,
      items: [
        {
          id: 'preferences',
          label: t`Preferences`,
          userScope: true,
          subsections: [
            ...(isOkDesktopHost
              ? [
                  {
                    id: 'spellcheck',
                    label: t`Check spelling while typing`,
                    anchor: 'spellcheck.enabled',
                    keywords: [t({ message: 'spellcheck', context: 'settings search keyword' })],
                  },
                ]
              : []),
            ...(spellcheckLanguagesAvailable
              ? [
                  {
                    id: 'spellcheck-languages',
                    label: t`Spelling languages`,
                    anchor: 'spellcheck.languages',
                    keywords: [t({ message: 'spellcheck', context: 'settings search keyword' })],
                  },
                ]
              : []),
          ] satisfies SidebarSubsection[],
        },
        { id: 'hotkeys', label: t`Hotkeys`, userScope: true },
        {
          id: 'account',
          label: t`Git`,
          subsections: [
            {
              id: 'github-account',
              label: t`GitHub`,
              anchor: 'section:github-account',
              keywords: [
                t({ message: 'gh', context: 'settings search keyword' }),
                t({ message: 'GitHub CLI', context: 'settings search keyword' }),
              ],
            },
            {
              id: 'enterprise-hosts',
              label: t`GitHub Enterprise Server hosts`,
              anchor: 'section:enterprise-hosts',
              keywords: [
                t({ message: 'GHES', context: 'settings search keyword' }),
                t({ message: 'enterprise', context: 'settings search keyword' }),
                t({ message: 'git host', context: 'settings search keyword' }),
              ],
            },
            {
              id: 'host-tokens',
              label: t`Other Git hosts`,
              anchor: 'section:host-tokens',
              keywords: [
                t({ message: 'token', context: 'settings search keyword' }),
                t({ message: 'GitLab', context: 'settings search keyword' }),
                t({ message: 'Bitbucket', context: 'settings search keyword' }),
                t({ message: 'git host', context: 'settings search keyword' }),
              ],
            },
          ] satisfies SidebarSubsection[],
        },
        { id: 'user-plugins-manage', label: t`Plugins` },
        { id: 'user-skills', label: t`Skills Studio` },
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
        {
          id: 'search',
          label: t`Search`,
          subsections: [
            {
              id: 'performance',
              label: t`Embedding request settings`,
              anchor: 'search.semantic.maxBatchSize',
              keywords: [
                t({ message: 'batch', context: 'settings search keyword' }),
                t({ message: 'characters', context: 'settings search keyword' }),
                t({ message: 'timeout', context: 'settings search keyword' }),
                t({ message: 'embeddings', context: 'settings search keyword' }),
                t({ message: 'requests', context: 'settings search keyword' }),
                t({ message: 'performance', context: 'settings search keyword' }),
                'Ollama',
              ],
            },
          ] satisfies SidebarSubsection[],
        },
        { id: 'plugins-manage', label: t`Plugins` },
        ...(isFileProtocolRenderer ? [] : [{ id: 'link-previews', label: t`Link previews` }]),
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
      hideOutsideProject: true,
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
      hideOutsideProject: true,
      items:
        desktopPresent && SHOW_INSTALL_SKILL
          ? [{ id: 'claude-desktop', label: t`Claude Desktop` }]
          : [],
    },
    ...(isOkDesktopHost
      ? ([
          {
            id: 'app',
            label: t`App`,
            enabled: true,
            items: [
              {
                id: 'about',
                label: t`About & updates`,
                userScope: true,
                keywords: [
                  t({ message: 'update', context: 'settings search keyword' }),
                  t({ message: 'version', context: 'settings search keyword' }),
                  t({ message: 'about', context: 'settings search keyword' }),
                  t`Release notes`,
                  t`Check for updates`,
                ],
              },
            ],
          },
        ] satisfies SidebarGroup[])
      : []),
  ];

  const groups = scopeSettingsGroupsForHost(declaredGroups, host);
  const shownId =
    host === 'navigator' &&
    !groups.some((group) =>
      group.items.some((item) => item.id === activeId && isSidebarItemSelectable(group, item)),
    )
      ? 'preferences'
      : activeId;

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
        onEscapeKeyDown={(event) => {
          if (
            event.target instanceof Element &&
            event.target.closest('[data-slot="combobox-chip-input"][aria-expanded="true"]')
          ) {
            event.preventDefault();
          }
        }}
      >
        <DialogTitle className="sr-only">
          <Trans>Settings</Trans>
        </DialogTitle>
        <DialogDescription className="sr-only">
          <Trans>Configure user, project, and integration settings.</Trans>
        </DialogDescription>
        <SettingsSidebar
          groups={groups}
          activeId={shownId}
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
          <SettingsDialogErrorBoundary key={shownId}>
            <Suspense fallback={<SettingsContentSkeleton />}>
              <SettingsDialogBodyLazy
                activeId={shownId}
                userBinding={userSynced ? userBinding : null}
                userLoadFailed={userLoadFailed === true}
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
        <SettingsSidebarVersion onSelect={onSelect} />
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

function SettingsSidebarVersion({ onSelect }: { onSelect: (id: string) => void }) {
  const { t } = useLingui();
  const notices = useSyncExternalStore(subscribeToNotices, getNoticesSnapshot, getNoticesSnapshot);
  const version = typeof window !== 'undefined' ? window.okDesktop?.appVersion : undefined;
  if (!version) return null;
  const checkingForUpdates = notices.some((notice) => notice.id === UPDATE_CHECKING_NOTICE_ID);

  return (
    <div className="ml-auto shrink-0 px-2 sm:ml-0 sm:mt-auto sm:pt-3">
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="link"
              onClick={() => onSelect('about')}
              data-testid="settings-sidebar-version"
              className="h-auto whitespace-nowrap p-0 font-mono text-xs font-normal text-muted-foreground/70 hover:text-foreground"
            >
              v{version}{' '}
              <span className="sr-only">
                <Trans>About & updates</Trans>
              </span>
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            <Trans>About & updates</Trans>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <p
        role="status"
        className="whitespace-nowrap text-xs text-muted-foreground"
        data-testid="settings-sidebar-update-checking"
      >
        {checkingForUpdates ? t`Checking for updates…` : null}
      </p>
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
  const hintId = `${headerId}-hint`;
  const describedById = group.disabledHint ? `${captionId} ${hintId}` : captionId;
  const someItemsDisabled = group.enabled && group.items.some((item) => item.disabled === true);
  const caption = (
    <>
      <p id={captionId} className="px-2 text-xs italic text-muted-foreground sm:mb-1">
        <Trans>Open a project to edit.</Trans>
      </p>
      {group.disabledHint ? (
        <p id={hintId} className="px-2 text-xs text-muted-foreground sm:mb-1">
          {group.disabledHint}
        </p>
      ) : null}
    </>
  );
  return (
    <div className="flex shrink-0 items-center gap-2 sm:mb-4 sm:block">
      <h3
        id={headerId}
        aria-describedby={group.enabled ? undefined : describedById}
        className={cn(
          'shrink-0 whitespace-nowrap px-2 text-xs font-semibold uppercase tracking-wide font-mono sm:mb-1',
          group.enabled ? 'text-muted-foreground/80' : 'text-muted-foreground/50',
        )}
      >
        {group.label}
      </h3>
      {!group.enabled ? caption : null}
      <ul aria-labelledby={headerId} className="flex gap-1 sm:block sm:space-y-0.5">
        {group.items.map((item) => {
          const selectable = isSidebarItemSelectable(group, item);
          return (
            <li key={item.id}>
              <button
                type="button"
                aria-current={activeId === item.id ? 'page' : undefined}
                aria-disabled={selectable ? undefined : true}
                aria-describedby={selectable ? undefined : describedById}
                tabIndex={selectable ? 0 : -1}
                disabled={!selectable}
                onClick={() => selectable && onSelect(item.id)}
                data-testid={`settings-sidebar-item-${item.id}`}
                className={cn(
                  'w-auto whitespace-nowrap rounded px-2 py-1.5 text-left text-sm transition-colors sm:w-full',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  'disabled:cursor-not-allowed disabled:opacity-50',
                  activeId === item.id && selectable
                    ? 'bg-accent text-accent-foreground'
                    : 'hover:bg-accent/50',
                )}
              >
                {item.label}
              </button>
            </li>
          );
        })}
      </ul>
      {someItemsDisabled ? caption : null}
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

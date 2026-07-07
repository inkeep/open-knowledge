// biome-ignore-all lint/plugin/no-raw-html-interactive-element: pre-rule backlog — file uses raw <button>/<input>/<textarea> awaiting shadcn migration; tracked at https://github.com/inkeep/open-knowledge/blob/main/biome-plugins/README.md#no-raw-html-interactive-elementgrit
/**
 * CommandPalette — workspace omnibar opened by Cmd+K / Ctrl+K.
 *
 * The palette is available on both web and Electron hosts. Workspace
 * navigation (files, folders, create commands, graph, open-in-agent) is
 * shared across hosts; desktop project commands appear when the Electron
 * bridge is available.
 */

import { SHOW_INSTALL_SKILL, type WorktreeSelectorEntry } from '@inkeep/open-knowledge-core';
import { Plural, Trans, useLingui } from '@lingui/react/macro';
import {
  Download,
  FilePlus2,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  GitBranch,
  Hash,
  LayoutGrid,
  Loader2,
  Network,
  Package,
  Plus,
  Settings,
  Sparkles,
} from 'lucide-react';
import {
  type Dispatch,
  type KeyboardEvent as ReactKeyboardEvent,
  type SetStateAction,
  useDeferredValue,
  useEffect,
  useRef,
  useState,
} from 'react';
import { CreateProjectDialog } from '@/components/CreateProjectDialog';
import {
  filterOmnibarRecents,
  loadOmnibarRecents,
  makeOmnibarRecentKey,
  type OmnibarRecentEntry,
  rememberOmnibarRecent,
  saveOmnibarRecents,
} from '@/components/command-palette-recents';
import {
  buildWorkspaceEntries,
  classifyOmnibarSearchHint,
  fetchWorkspaceSearchEntries,
  matchesCommandQuery,
  SEMANTIC_RESULT_LIMIT,
  searchWorkspaceEntries,
  splitTextByQueryMatches,
  type WorkspaceEntry,
  type WorkspaceSearchEntry,
} from '@/components/command-palette-search';
import { computeSemanticModeView } from '@/components/command-palette-semantic';
import {
  fetchDocsForTag,
  fetchTagsList,
  filterTagList,
  parseTagPaletteQuery,
  TAG_QUERY_PREFIX,
  type TagDocEntry,
} from '@/components/command-palette-tag-search';
import { requestDocPanelTab } from '@/components/doc-panel-events';
import { FileEntryIcon } from '@/components/file-entry-icon';
import { defaultInitialDir } from '@/components/file-tree-utils';
import { NewItemDialog } from '@/components/NewItemDialog';
import { usePageList } from '@/components/PageListContext';
import { SeedDialog } from '@/components/SeedDialog';
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from '@/components/ui/command';
import { useDocumentContext } from '@/editor/DocumentContext';
import type { TagSummaryEntry } from '@/editor/extensions/tag-suggestion';
import { useIsEmbedded } from '@/hooks/use-is-embedded';
import { useSemanticSearchStatus } from '@/hooks/use-semantic-search-status';
import { useWorktrees } from '@/hooks/use-worktrees';
import type { OkDesktopBridge, RecentProjectEntry } from '@/lib/desktop-bridge-types';
import { hashFromDocName } from '@/lib/doc-hash';
import { runWithToast as runWithToastBase } from '@/lib/error-state';
import { VISIBLE_TARGETS } from '@/lib/handoff/targets';
import { formatShortcut, matchesKeyboardShortcut } from '@/lib/keyboard-shortcuts';
import { useSingleFileMode } from '@/lib/single-file-mode';
import { SETTINGS_OPEN_HASH } from '@/lib/use-settings-route';
import { useWorkspace } from '@/lib/use-workspace';
import { cn } from '@/lib/utils.ts';
import { refreshWorktrees } from '@/lib/worktree-store';
import { buildHandoffInput, useHandoffDispatch } from './handoff/useHandoffDispatch';
import { useInstalledAgents } from './handoff/useInstalledAgents';
import { basenameOf } from './project-switcher-recents';

const COMMAND_PALETTE_SEARCH_TIMEOUT_MS = 3000;
// Re-poll cadence while the server reports the search index is still warming
// (`ready:false`). Short, since a warming response returns immediately (the
// server does not block on the build) and the index builds in well under a
// second on typical workspaces.
const COMMAND_PALETTE_SEARCH_WARMING_POLL_MS = 600;
// Cap on warming re-polls so a wedged server can't poll forever. ~12s at the
// cadence above — far beyond a normal cold start, which flips ready in ~1s.
const COMMAND_PALETTE_SEARCH_MAX_WARMING_POLLS = 20;

/**
 * CommandPalette-scoped wrapper around the shared `runWithToast` helper. Same
 * surface ProjectSwitcher uses — consistent launcher UX (every rejection
 * surfaces as a sonner toast). Exported for unit-testing with a mockable
 * `toastApi` indirection; the default uses sonner's module-level `toast`.
 */
export const runWithToast = (
  fn: () => Promise<void>,
  fallback: string,
  toastApi?: { error(msg: string): void },
): Promise<void> => runWithToastBase(fn, fallback, toastApi, 'CommandPalette');

interface CommandPaletteProps {
  bridge?: OkDesktopBridge | null;
  open: boolean;
  onOpenChange: Dispatch<SetStateAction<boolean>>;
}

function navigateToDocHash(docName: string): void {
  window.location.assign(hashFromDocName(docName));
}

function resolveCreateInitialDir(
  activeTarget: ReturnType<typeof useDocumentContext>['activeTarget'],
  activeDocName: string | null,
): string {
  if (activeTarget?.kind === 'folder' || activeTarget?.kind === 'folder-index') {
    return activeTarget.folderPath;
  }
  return defaultInitialDir(activeDocName);
}

export function NavigationItem({
  entry,
  query = '',
  onSelect,
  disabled = false,
}: {
  entry: WorkspaceEntry | WorkspaceSearchEntry | OmnibarRecentEntry;
  query?: string;
  onSelect: () => void;
  /**
   * Inert + dimmed (cmdk skips it for selection, mouse clicks no-op via
   * `data-disabled:pointer-events-none`). Used for stale semantic results so a
   * highlighted-then-clicked stale row can't open while ↵ re-fires — keyboard
   * and pointer stay in agreement until the held set is current again.
   */
  disabled?: boolean;
}) {
  const title =
    'title' in entry && entry.title ? entry.title : (entry.path.split('/').pop() ?? entry.path);
  const snippet = 'snippet' in entry ? entry.snippet : undefined;
  const docExt = 'docExt' in entry ? entry.docExt : undefined;
  const bodyIndexed = 'bodyIndexed' in entry ? entry.bodyIndexed : undefined;

  return (
    <CommandItem
      value={`${entry.kind} ${entry.path}`}
      onSelect={onSelect}
      disabled={disabled}
      data-testid={`command-palette-nav-${entry.kind}-${entry.path}`}
      className="items-start"
    >
      <FileEntryIcon
        bodyIndexed={bodyIndexed}
        className="mt-0.5 size-4"
        docExt={docExt}
        kind={entry.kind}
        path={entry.path}
      />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="truncate font-medium">
          <HighlightedText query={query} text={title} />
        </span>
        <span className="truncate text-muted-foreground text-xs">
          <HighlightedText query={query} text={entry.path} />
        </span>
        {snippet ? (
          <span className="max-h-10 overflow-hidden text-muted-foreground text-xs leading-relaxed">
            <HighlightedText query={query} text={snippet} />
          </span>
        ) : null}
      </div>
    </CommandItem>
  );
}

/**
 * One-line search-hint affordance. Rendered at the bottom
 * of the palette's result region.
 *
 * - `mode === 'name-only'` — there are results, but every one is a name /
 *   path / folder match. The hint reminds the user the omnibar matches
 *   names + paths, not body text. Content search lives behind opening the
 *   file and using the in-page find (⌘F).
 * - `mode === 'truncated'` — corpus hit the configured cap; some files
 *   couldn't be indexed. The hint warns that a missing file may be a cap
 *   artifact, not a typo. Phrased for a non-technical persona — the
 *   underlying env-var name stays in the operator-facing warn log + the
 *   `ok.search.corpus_truncated_total` counter, not the UI string.
 * - `mode === 'empty'` — no results for a non-empty query. The hint notes
 *   that hidden / ignored files aren't reachable through search.
 * - `mode === 'content'` / `'idle'` — render nothing. Composing the
 *   hint-mode classifier inline with the affordance keeps "absent when
 *   content hits are present" (the invariant) auditable from one site.
 *
 * Suppressed entirely in exclusive modes (tag picker, semantic by-meaning)
 * — those modes have their own empty states + UX. Same for inside the
 * tag-list / tag-docs sub-modes of paletteMode.
 */
function SearchHint({
  mode,
  inExclusiveMode,
  paletteModeKind,
}: {
  mode: ReturnType<typeof classifyOmnibarSearchHint>;
  inExclusiveMode: boolean;
  paletteModeKind: 'normal' | 'tag-list' | 'tag-docs';
}) {
  if (inExclusiveMode) return null;
  if (paletteModeKind !== 'normal') return null;
  if (mode === 'idle' || mode === 'content') return null;
  // Rendered OUTSIDE `<CommandList>` by the caller — cmdk's CommandList
  // sets `role="listbox"`, whose ARIA contract restricts children to
  // `option` and `group`. A `role="note"` child there is out-of-spec and
  // makes screen-reader behavior on arrow-key navigation undefined. We
  // mark this region `aria-live="polite"` so the hint is announced when
  // it changes after results settle, not interleaved with option
  // navigation.
  return (
    <div
      aria-live="polite"
      data-testid={`command-palette-search-hint-${mode}`}
      className="border-t px-3 py-2 text-muted-foreground text-xs"
    >
      {mode === 'name-only' ? (
        <Trans>
          Search matches file names, paths, and folders. Open a file to search its body (⌘F).
        </Trans>
      ) : mode === 'truncated' ? (
        <Trans>
          Results capped — this workspace has more files than search can index. A missing file may
          be a cap artifact, not a typo.
        </Trans>
      ) : (
        <Trans>No matches. Some files are excluded from search (hidden or ignored files).</Trans>
      )}
    </div>
  );
}

function HighlightedText({ text, query }: { text: string; query: string }) {
  const segments = splitTextByQueryMatches(text, query);
  return (
    <>
      {segments.map((segment) => {
        const key = `${segment.start}:${segment.match ? 'match' : 'plain'}`;
        return segment.match ? (
          <mark key={key} className="rounded-sm bg-primary/10 px-0.5 font-semibold text-primary">
            {segment.text}
          </mark>
        ) : (
          <span key={key}>{segment.text}</span>
        );
      })}
    </>
  );
}

/**
 * Pure decision for which population to render in the search results
 * slot of the open command palette. Factored out so the stale-while-
 * revalidate contract is unit-pinnable independent of the React tree.
 *
 * Contract:
 *   - Prior `searchResults` stay visible whenever non-empty, regardless
 *     of `searchStatus`. Load-bearing — without it the visible list
 *     flashes through the local-corpus fallback on every keystroke.
 *   - When the API resolved with zero matches (`status === 'success'`),
 *     show empty. The local title corpus uses a different algorithm
 *     than `/api/search`, so routing through it would mislead.
 *   - Otherwise (empty + non-success: first keystroke before any API
 *     answer has landed, or recovery after error / tag-mode exit),
 *     surface the local-corpus fallback so the user sees something.
 */
export function computeVisibleSearchResults({
  searchResults,
  fallbackSearchResults,
  searchStatus,
}: {
  searchResults: readonly WorkspaceSearchEntry[];
  fallbackSearchResults: readonly WorkspaceEntry[];
  searchStatus: 'idle' | 'loading' | 'success' | 'error';
}): readonly (WorkspaceEntry | WorkspaceSearchEntry)[] {
  if (searchResults.length > 0) return searchResults;
  if (searchStatus === 'success') return [];
  return fallbackSearchResults;
}

export function CommandPalette({ bridge = null, open, onOpenChange }: CommandPaletteProps) {
  const { t } = useLingui();
  // No-project single-file session: hide project-scoped commands (Settings,
  // Switch Project) that have no meaning without a project.
  const singleFile = useSingleFileMode();
  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query);
  const trimmedDeferredQuery = deferredQuery.trim();
  const [searchResults, setSearchResults] = useState<WorkspaceSearchEntry[]>([]);
  const [searchStatus, setSearchStatus] = useState<'idle' | 'loading' | 'success' | 'error'>(
    'idle',
  );
  // Mirrors the server's `truncated` flag on the most recent /api/search build.
  // Drives the `'truncated'` hint mode so a user sees the cap signal when the
  // name-only file tier hit `OK_SEARCH_MAX_ENTRIES`.
  const [searchTruncated, setSearchTruncated] = useState(false);
  // Server cold-start: `/api/search` answered `ready:false` (index still
  // building). Drives the same "Preparing search" status as the page-list
  // cold-load gate, and the poll below re-fires until the index is ready. This
  // covers the post-page-list corpus-build window (and is defense-in-depth for
  // the seed window the `pagesLoading` gate already handles).
  const [searchIndexWarming, setSearchIndexWarming] = useState(false);
  // Semantic ("by meaning") mode — a deliberate-submit search, exclusive of the
  // lexical palette. `isSemanticMode` mirrors the tag-mode short-circuit but is
  // component state, not a query prefix (the raw query text is what gets
  // embedded, so a prefix would poison the vector query). Results are sticky
  // across edits (decision logic in `command-palette-semantic`); `semanticStatus`
  // drives the spinner / retry affordance.
  const [isSemanticMode, setIsSemanticMode] = useState(false);
  const [semanticResults, setSemanticResults] = useState<WorkspaceSearchEntry[]>([]);
  const [semanticFiredQuery, setSemanticFiredQuery] = useState<string | null>(null);
  const [semanticStatus, setSemanticStatus] = useState<'idle' | 'loading' | 'success' | 'error'>(
    'idle',
  );
  const [projectRecents, setProjectRecents] = useState<RecentProjectEntry[]>([]);
  const [recentNavigation, setRecentNavigation] = useState<OmnibarRecentEntry[]>([]);
  const [createDialogKind, setCreateDialogKind] = useState<'file' | 'folder' | null>(null);
  const [seedDialogOpen, setSeedDialogOpen] = useState(false);
  const [createProjectOpen, setCreateProjectOpen] = useState(false);
  // Tag-mode state. Loaded lazily on first `tag:` keystroke; cached for
  // the lifetime of the palette session (cleared on close in the open-
  // toggle effect). Loading flag drives the `tag-list` placeholder UI;
  // `tagListStatus` tracks failure so we can show a recovery hint.
  const [tagsList, setTagsList] = useState<TagSummaryEntry[]>([]);
  const [tagsListStatus, setTagsListStatus] = useState<'idle' | 'loading' | 'success' | 'error'>(
    'idle',
  );
  const [tagDocs, setTagDocs] = useState<TagDocEntry[]>([]);
  const [tagDocsStatus, setTagDocsStatus] = useState<'idle' | 'loading' | 'success' | 'error'>(
    'idle',
  );
  // Single-fetch-per-session gate for the tags list. Lives in a ref
  // (not state) so it doesn't trigger re-renders and therefore doesn't
  // belong in the fetch effect's dep array — avoiding a
  // cleanup-cancels-fetch race that leaves "Loading tags…" hanging
  // forever. Reset on palette close in the open-toggle effect so a
  // fresh open re-fetches.
  const tagsListFetchedRef = useRef(false);
  const listRef = useRef<HTMLDivElement>(null);
  // Input ref so filter-pill clicks can restore focus to the search
  // input — without it, clicking a pill moves focus to the button and
  // the user has to click back into the input before typing the tag
  // name. Same UX expectation users have from Slack's filter pills.
  const inputRef = useRef<HTMLInputElement>(null);
  // In-flight semantic fire: abort + timeout handles so a re-fire (or a close)
  // cancels the prior request cleanly without clobbering newer state.
  const semanticAbortRef = useRef<AbortController | null>(null);
  const semanticTimerRef = useRef<number | null>(null);
  const { activeDocName, activeTarget } = useDocumentContext();
  const {
    pages,
    pageTitles,
    pageMeta,
    folderPaths,
    filePaths,
    loading: pagesLoading,
  } = usePageList();
  const workspace = useWorkspace();
  const { states: installStates, refresh: refreshInstallStates } = useInstalledAgents();
  const { dispatch: dispatchHandoff } = useHandoffDispatch();
  // Capability gate for the "By meaning" pill: only when the project has semantic
  // search enabled AND an API key is resolvable. Probed only while the palette is
  // open. When unavailable the pill is absent and the palette is byte-identical
  // to its pre-semantic shape.
  const { status: semanticCapability, refresh: refreshSemanticStatus } = useSemanticSearchStatus({
    enabled: open,
  });
  const semanticCapable =
    (semanticCapability?.enabled ?? false) && (semanticCapability?.keyPresent ?? false);
  // Coverage: pages with at least one cached chunk vector. The first "by meaning"
  // search lazily kicks off the background embed pass, so the corpus can be
  // partially (or not yet) indexed — surfaced so the user knows results may be
  // incomplete. `embedded < total` (with pages present) = not fully indexed.
  const semanticIndexedCount = semanticCapability?.embedded ?? 0;
  const semanticTotalCount = semanticCapability?.total ?? 0;
  const semanticIndexing =
    semanticCapable && semanticTotalCount > 0 && semanticIndexedCount < semanticTotalCount;
  // While indexing is incomplete in semantic mode, poll coverage so the banner
  // ticks up live: the first by-meaning search kicks off the background embed,
  // and no `files` push fires as it progresses (the hook's only other trigger).
  // Bounded — stops the moment indexing completes or the palette/mode closes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshSemanticStatus is behaviorally stable; re-arm only on the gating booleans.
  useEffect(() => {
    if (!open || !isSemanticMode || !semanticIndexing) return;
    const id = window.setInterval(() => refreshSemanticStatus(), 2500);
    return () => window.clearInterval(id);
  }, [open, isSemanticMode, semanticIndexing]);
  // Shared input construction — identical shape across the three surfaces so
  // the single-dispatch contract holds. `null` when no active doc or when
  // workspace metadata has not resolved yet (web host only — Electron
  // resolves synchronously via `window.okDesktop`).
  const handoffInput = buildHandoffInput({ docName: activeDocName, workspace });

  const workspaceEntries = buildWorkspaceEntries(
    pages,
    folderPaths,
    pageTitles,
    pageMeta,
    filePaths,
  );
  const validRecentKeys = new Set(
    workspaceEntries.map((entry) => makeOmnibarRecentKey(entry.kind, entry.path)),
  );
  const visibleRecents = filterOmnibarRecents(recentNavigation, validRecentKeys);
  const currentPath = bridge?.config.projectPath ?? null;
  const switchableProjects = bridge ? projectRecents.filter((row) => row.path !== currentPath) : [];
  // Cached worktree model for the current project (shared with ProjectSwitcher,
  // one git spawn total). Excludes the current window's own worktree — no value
  // in switching to yourself. `null` off-desktop / until the first fetch lands.
  const worktreeModel = useWorktrees();
  const switchableWorktrees =
    bridge && worktreeModel
      ? worktreeModel.entries.filter((entry) => entry.branch !== null && !entry.isCurrent)
      : [];
  const initialCreateDir = resolveCreateInitialDir(activeTarget, activeDocName);
  const fallbackSearchResults =
    trimmedDeferredQuery === ''
      ? []
      : searchWorkspaceEntries(workspaceEntries, trimmedDeferredQuery, 8);

  // Cmd+K / Ctrl+K global opener. Attached once per bridge instance; React
  // Compiler handles the no-stale-closure-on-re-render concern via reactivity.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const isTrigger = matchesKeyboardShortcut(e, 'command-palette');
      if (!isTrigger) return;
      e.preventDefault();
      onOpenChange(!open);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onOpenChange, open]);

  useEffect(() => {
    if (open) {
      setRecentNavigation(loadOmnibarRecents());
      void refreshInstallStates();
      if (bridge) {
        let cancelled = false;
        void runWithToast(async () => {
          const result = await bridge.project.listRecent();
          if (!cancelled) setProjectRecents(result);
        }, t`Failed to load recent projects.`);
        return () => {
          cancelled = true;
        };
      }
      return;
    }
    setQuery('');
    // Clear tag caches when the palette closes — tag list mutates on
    // every save (every doc edit can add/remove tags), so a stale list
    // surviving across opens would offer dead suggestions.
    setTagsList([]);
    setTagsListStatus('idle');
    tagsListFetchedRef.current = false;
    setTagDocs([]);
    setTagDocsStatus('idle');
    // Exit semantic mode + drop the sticky result set on close so a fresh open
    // starts lexical; abort any in-flight fire.
    setIsSemanticMode(false);
    semanticAbortRef.current?.abort();
    semanticAbortRef.current = null;
    if (semanticTimerRef.current !== null) {
      window.clearTimeout(semanticTimerRef.current);
      semanticTimerRef.current = null;
    }
    setSemanticResults([]);
    setSemanticFiredQuery(null);
    setSemanticStatus('idle');
  }, [open, bridge, refreshInstallStates, t]);

  // Reset scroll on every query change. Stale-while-revalidate keeps the
  // prior list mounted across the fetch, so without this the CommandList
  // would retain its scrollTop into the next query — confusing when the
  // top matches are now below the viewport. `void query` signals the
  // dependency to the linter; the actual trigger is the value change.
  useEffect(() => {
    void query;
    if (listRef.current) listRef.current.scrollTop = 0;
  }, [query]);

  // Compute tag-palette mode from the current query. Pure derivation —
  // re-runs on every render (cheap; no setState). The known-tag-name
  // set drives the discriminator between `tag-list` (unknown / partial
  // tag) and `tag-docs` (exact known tag).
  const knownTagNames = new Set(tagsList.map((tag) => tag.name));
  // Semantic mode bypasses tag parsing: it is exclusive and NOT a query prefix,
  // so a `tag:` the user happens to type stays part of the semantic query rather
  // than flipping the palette into tag-mode.
  const paletteMode = isSemanticMode
    ? ({ kind: 'normal', query: deferredQuery } as const)
    : parseTagPaletteQuery(deferredQuery, knownTagNames);
  const isTagMode = paletteMode.kind !== 'normal';
  // Either exclusive mode (tag or semantic) suppresses the normal lexical palette
  // — recents, command rows, and the per-keystroke full-text search list.
  const inExclusiveMode = isTagMode || isSemanticMode;
  // Named locals for the tag-mode `<Trans>` / `t` placeholders — Lingui
  // can't derive a name from a member expression.
  const tagListQuery = paletteMode.kind === 'tag-list' ? paletteMode.query : '';
  const tagDocsName = paletteMode.kind === 'tag-docs' ? paletteMode.tagName : '';
  // Semantic mode render + Enter-action decision (pure; see
  // `command-palette-semantic`). Uses the LIVE query, not the debounced one — the
  // mode never auto-searches, so there is no debounce to respect and the submit
  // row should track typing.
  const semanticQueryText = query.trim();
  const semanticView = isSemanticMode
    ? computeSemanticModeView({
        query: semanticQueryText,
        firedQuery: semanticFiredQuery,
        status: semanticStatus,
        resultCount: semanticResults.length,
      })
    : null;
  // Named locals for the Lingui placeholders below — Lingui can't derive a name
  // from a member expression.
  const semanticSubmitQuery = semanticView?.submit?.query ?? '';
  const semanticResultsLabel = semanticView?.results.forQuery ?? '';

  // Fetch tag list lazily on first `tag:` keystroke. Cached for the
  // session via `tagsListFetchedRef` (a ref, not state — the gate
  // doesn't drive the UI, only `tagsListStatus` does). Including
  // `tagsListStatus` in the dep array would cause a cleanup-cancels-
  // fetch race: `setTagsListStatus('loading')` re-renders, the dep
  // change re-runs the effect, the cleanup sets `cancelled = true`,
  // the in-flight promise resolves but bails on the cancelled flag,
  // state never updates → "Loading tags…" hangs forever. The ref-
  // based gate keeps the fetch single-shot per session without
  // triggering that race.
  useEffect(() => {
    if (!open || !isTagMode) return;
    if (tagsListFetchedRef.current) return;
    tagsListFetchedRef.current = true;
    setTagsListStatus('loading');
    let cancelled = false;
    void fetchTagsList()
      .then((tags) => {
        if (cancelled) return;
        setTagsList(tags);
        setTagsListStatus('success');
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        console.error('[command-palette-tag] fetch tags failed', err);
        setTagsList([]);
        setTagsListStatus('error');
      });
    return () => {
      cancelled = true;
    };
  }, [open, isTagMode]);

  // Fetch tag-doc membership when an exact tag name is recognised.
  // Re-runs on tag-name change; previous results clear immediately so
  // stale docs don't briefly flash from the prior tag.
  //
  // Same dep-array discipline as the tags-list effect: `tagDocsStatus`
  // is INTENTIONALLY excluded to avoid the cleanup-cancels-fetch race.
  // The early-clear path (`if (!open || tagDocsTarget === null)`)
  // calls the setters unconditionally — they're no-ops if already at
  // the target value, and skipping them entirely would leave stale
  // docs visible after exiting tag mode.
  const tagDocsTarget = paletteMode.kind === 'tag-docs' ? paletteMode.tagName : null;
  useEffect(() => {
    if (!open || tagDocsTarget === null) {
      setTagDocs([]);
      setTagDocsStatus('idle');
      return;
    }
    setTagDocsStatus('loading');
    setTagDocs([]);
    let cancelled = false;
    void fetchDocsForTag(tagDocsTarget)
      .then((docs) => {
        if (cancelled) return;
        setTagDocs(docs);
        setTagDocsStatus('success');
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        console.error('[command-palette-tag] fetch tag docs failed', err);
        setTagDocs([]);
        setTagDocsStatus('error');
      });
    return () => {
      cancelled = true;
    };
  }, [open, tagDocsTarget]);

  useEffect(() => {
    // Tag and semantic modes short-circuit the per-keystroke workspace-search
    // fetch — tag mode reads `/api/tags*`; semantic mode fires only on submit.
    //
    // `pagesLoading` gates the body fetch during cold start: before the page
    // list has landed, `/api/search` can lose the race with the client timeout
    // below and the palette falsely shows "Search failed." `loading` is a
    // cold-load-only signal (not re-raised on background refetch), so once it
    // flips false this effect re-runs and the fetch fires for the live query.
    if (!open || !trimmedDeferredQuery || inExclusiveMode || pagesLoading) {
      setSearchResults([]);
      setSearchStatus('idle');
      setSearchTruncated(false);
      setSearchIndexWarming(false);
      return;
    }

    let cancelled = false;
    let everWarming = false;
    let warmingPolls = 0;
    let activeController: AbortController | null = null;
    let timeoutTimer: number | undefined;
    let retryTimer: number | undefined;
    setSearchStatus('loading');

    // Bounded so a wedged server can't poll forever. Returns false at the cap so
    // the caller settles instead of scheduling another attempt.
    const scheduleWarmingRetry = (): boolean => {
      if (cancelled || warmingPolls >= COMMAND_PALETTE_SEARCH_MAX_WARMING_POLLS) return false;
      warmingPolls += 1;
      retryTimer = window.setTimeout(run, COMMAND_PALETTE_SEARCH_WARMING_POLL_MS);
      return true;
    };

    // A timeout or transient error WHILE warming keeps polling — the index is
    // known to be coming, so falling to "Search failed." would re-introduce the
    // exact false failure this fix removes. Outside warming (a genuine slow or
    // failed query) it settles to the error state as before.
    const settleErrorOrRetry = () => {
      if (cancelled) return;
      if (everWarming && scheduleWarmingRetry()) return;
      setSearchResults([]);
      setSearchStatus('error');
      setSearchTruncated(false);
      setSearchIndexWarming(false);
    };

    // One fetch attempt, with its own AbortController so a retry after a
    // timeout-driven abort starts from a fresh signal. On `ready:false` (server
    // index still warming) the empty result is not authoritative, so we re-poll
    // (recursion, not a dep-driven re-run, keeps the deps array exactly the
    // inputs the effect reads). Stale-while-revalidate holds: prior
    // `searchResults` stay visible across the fetch; only a terminal state clears.
    function run() {
      const controller = new AbortController();
      activeController = controller;
      timeoutTimer = window.setTimeout(() => {
        controller.abort();
        settleErrorOrRetry();
      }, COMMAND_PALETTE_SEARCH_TIMEOUT_MS);

      void fetchWorkspaceSearchEntries(trimmedDeferredQuery, { signal: controller.signal })
        .then(({ entries, truncated, ready }) => {
          window.clearTimeout(timeoutTimer);
          if (cancelled) return;
          if (!ready) {
            // Surface "Preparing search" once, then re-poll. Guard the writes so
            // a steady warming poll does not re-render every cycle.
            if (!everWarming) {
              everWarming = true;
              setSearchResults([]);
              setSearchTruncated(false);
              setSearchIndexWarming(true);
              setSearchStatus('success');
            }
            // Cap reached: stop polling and drop the warming UI so the user can
            // retype to retry rather than spin forever on a wedged server.
            if (!scheduleWarmingRetry()) setSearchIndexWarming(false);
            return;
          }
          setSearchResults(entries);
          setSearchTruncated(truncated);
          setSearchIndexWarming(false);
          setSearchStatus('success');
        })
        .catch((error: unknown) => {
          window.clearTimeout(timeoutTimer);
          if (cancelled) return;
          // Skip ALL aborts: a cleanup abort is caught by `cancelled` above, and
          // a timeout abort was already handled by the timeout callback (which
          // called settleErrorOrRetry). Re-handling here would double-schedule
          // the retry — orphaning a timer and double-counting warmingPolls.
          if (error instanceof Error && error.name === 'AbortError') return;
          settleErrorOrRetry();
        });
    }
    run();

    return () => {
      cancelled = true;
      window.clearTimeout(timeoutTimer);
      window.clearTimeout(retryTimer);
      activeController?.abort();
    };
  }, [open, trimmedDeferredQuery, inExclusiveMode, pagesLoading]);

  const runAction = (fn: () => Promise<void> | void, fallback = t`Command failed.`) => {
    onOpenChange(false);
    // Normalize `fn` to `() => Promise<void>` so the shared helper's
    // signature lines up; sync callbacks get wrapped into a resolved promise.
    void runWithToast(async () => {
      await fn();
    }, fallback);
  };

  // Open a worktree from the palette. An existing
  // worktree opens its window directly; a branch without one is created on
  // demand, then opened — mirroring the ProjectSwitcher submenu. `refresh` after
  // a create so the topology (this new worktree) shows up next time.
  const openWorktreeEntry = (entry: WorktreeSelectorEntry) => {
    if (!bridge) return;
    const existingPath = entry.worktreePath;
    if (existingPath !== null) {
      runAction(
        () =>
          bridge.project.open({ path: existingPath, target: 'new-window', entryPoint: 'worktree' }),
        t`Failed to open worktree.`,
      );
      return;
    }
    const branch = entry.branch;
    if (branch === null) return;
    runAction(async () => {
      const result = await bridge.worktree.create({ branch, createBranch: false });
      if (!result.ok) throw new Error(result.reason);
      refreshWorktrees();
      await bridge.project.open({
        path: result.path,
        target: 'new-window',
        entryPoint: 'worktree',
      });
    }, t`Failed to open worktree.`);
  };

  function rememberNavigation(entry: WorkspaceEntry | OmnibarRecentEntry) {
    const nextEntry = {
      kind: entry.kind,
      path: entry.path,
      lastOpenedAt: new Date().toISOString(),
    } satisfies OmnibarRecentEntry;
    const nextRecents = rememberOmnibarRecent(loadOmnibarRecents(), nextEntry);
    saveOmnibarRecents(nextRecents);
    setRecentNavigation(nextRecents);
  }

  function navigateToEntry(entry: WorkspaceEntry | OmnibarRecentEntry) {
    onOpenChange(false);
    rememberNavigation(entry);
    navigateToDocHash(entry.path);
  }

  // Tag mode replaces the entire palette body — normal commands /
  // search / recents hide while the user is filtering by tag. The
  // dropdown switches to either a tag picker (when the suffix is
  // unknown / empty) or a doc list (when the suffix is an exact
  // known tag).
  const showRecentNavigation =
    !inExclusiveMode && trimmedDeferredQuery === '' && visibleRecents.length > 0;
  const visibleSearchResults = computeVisibleSearchResults({
    searchResults,
    fallbackSearchResults,
    searchStatus,
  });
  const showNavigation = !inExclusiveMode && visibleSearchResults.length > 0;
  // Cold start: the page list is still loading (`pagesLoading`) or the server
  // reported its search index is still warming (`searchIndexWarming`). Show a
  // distinct "preparing" status instead of the misleading "Search failed." /
  // "No matching commands." empty state, and let the poll re-fire.
  const showSearchPreparing =
    !inExclusiveMode &&
    trimmedDeferredQuery !== '' &&
    (pagesLoading || searchIndexWarming) &&
    !showNavigation;
  // Exclude the warming case so a warming re-poll shows only "Preparing search",
  // not a flash of "Searching" between poll cycles.
  const showSearchLoading =
    !inExclusiveMode &&
    trimmedDeferredQuery !== '' &&
    searchStatus === 'loading' &&
    !showNavigation &&
    !showSearchPreparing;
  const showCreateFile =
    !inExclusiveMode && matchesCommandQuery(t`New file`, deferredQuery, ['create file']);
  const showCreateFolder =
    !inExclusiveMode && matchesCommandQuery(t`New folder`, deferredQuery, ['create folder']);
  const showGraphCommand =
    !inExclusiveMode &&
    activeDocName !== null &&
    matchesCommandQuery(t`Open graph`, deferredQuery, ['graph panel network']);
  const showInitializeStarterPack =
    !inExclusiveMode &&
    matchesCommandQuery(t`Initialize starter pack`, deferredQuery, [
      'scaffold',
      'seed',
      'pack',
      'starter',
    ]);
  // Desktop-only — opens the same CreateProjectDialog the File → Create New
  // Project… menu action and the ProjectSwitcher dropdown reach. Gated on
  // `bridge !== null` so the web host never surfaces it.
  const showCreateProject =
    !inExclusiveMode &&
    bridge !== null &&
    matchesCommandQuery(t`New project`, deferredQuery, ['create new project scaffold']);
  const showProjectOpenFolder =
    !inExclusiveMode &&
    bridge !== null &&
    matchesCommandQuery(t`Open folder on disk`, deferredQuery, ['project']);
  const showProjectSwitch =
    !inExclusiveMode &&
    !singleFile &&
    bridge !== null &&
    matchesCommandQuery(t`Switch project`, deferredQuery, ['switch project navigator projects']);
  const showSettings =
    !inExclusiveMode &&
    !singleFile &&
    matchesCommandQuery(t`Settings`, deferredQuery, ['preferences config']);
  const showInstallClaudeDesktop =
    SHOW_INSTALL_SKILL &&
    !inExclusiveMode &&
    matchesCommandQuery(t`Install for Claude Chat & Cowork (Desktop App)`, deferredQuery, [
      'claude desktop install cowork',
    ]);
  const showProjectRecents =
    !inExclusiveMode &&
    bridge !== null &&
    switchableProjects.length > 0 &&
    (trimmedDeferredQuery === '' ||
      switchableProjects.some((row) =>
        matchesCommandQuery(`${row.name} ${row.path}`, deferredQuery, ['open recent project']),
      ));
  const matchedWorktrees = switchableWorktrees.filter(
    (entry) =>
      trimmedDeferredQuery === '' ||
      matchesCommandQuery(entry.branch ?? '', deferredQuery, ['worktree branch']),
  );
  const showWorktrees = !inExclusiveMode && bridge !== null && matchedWorktrees.length > 0;
  const isEmbedded = useIsEmbedded();
  const showAgentGroup =
    !inExclusiveMode &&
    !isEmbedded &&
    handoffInput !== null &&
    (trimmedDeferredQuery === '' ||
      VISIBLE_TARGETS.some((target) => {
        const displayName = target.displayName;
        return matchesCommandQuery(t`Open with AI ${displayName}`, deferredQuery, [
          target.id,
          'agent handoff',
          'open in',
        ]);
      }));
  const tagListItems =
    paletteMode.kind === 'tag-list' ? filterTagList(tagsList, paletteMode.query) : [];
  const showTagListEmpty =
    paletteMode.kind === 'tag-list' && tagsListStatus !== 'loading' && tagListItems.length === 0;
  const showTagDocsEmpty =
    paletteMode.kind === 'tag-docs' && tagDocsStatus === 'success' && tagDocs.length === 0;

  const hasAnyResults =
    inExclusiveMode ||
    showRecentNavigation ||
    showNavigation ||
    showSearchLoading ||
    showSearchPreparing ||
    showCreateFile ||
    showCreateFolder ||
    showGraphCommand ||
    showInitializeStarterPack ||
    showCreateProject ||
    showProjectOpenFolder ||
    showProjectSwitch ||
    showSettings ||
    showInstallClaudeDesktop ||
    showProjectRecents ||
    showAgentGroup;

  function navigateToTagDocs(tagName: string) {
    setQuery(`${TAG_QUERY_PREFIX}${tagName}`);
  }

  function resetSemanticState() {
    semanticAbortRef.current?.abort();
    semanticAbortRef.current = null;
    if (semanticTimerRef.current !== null) {
      window.clearTimeout(semanticTimerRef.current);
      semanticTimerRef.current = null;
    }
    setSemanticResults([]);
    setSemanticFiredQuery(null);
    setSemanticStatus('idle');
  }

  function enterSemanticMode() {
    setIsSemanticMode(true);
    // Carry whatever the user already typed into the embed input — a query typed
    // before clicking the pill should search, not vanish. Only a 'tag:' prefix is
    // dropped (that filter syntax isn't meaningful to embed). Focus so they can
    // keep typing.
    if (query.startsWith(TAG_QUERY_PREFIX)) setQuery(query.slice(TAG_QUERY_PREFIX.length));
    resetSemanticState();
    inputRef.current?.focus();
  }

  function exitSemanticMode() {
    setIsSemanticMode(false);
    setQuery('');
    resetSemanticState();
    inputRef.current?.focus();
  }

  // Fire ONE semantic search for `raw` — deliberate-submit only, never per
  // keystroke. Sticky: a timeout/failure or a superseding re-fire keeps the prior
  // results; only a success replaces them. Mirrors the lexical effect's timeout +
  // abort discipline.
  function fireSemanticSearch(raw: string) {
    const q = raw.trim();
    if (!q) return;
    // Same cold-load gate as the lexical effect: while the page list is still
    // loading, a deliberate submit would race the timeout below into a false
    // failure. The submit affordance stays, so ↵ runs the search once ready.
    if (pagesLoading) return;
    semanticAbortRef.current?.abort();
    if (semanticTimerRef.current !== null) window.clearTimeout(semanticTimerRef.current);
    const controller = new AbortController();
    semanticAbortRef.current = controller;
    setSemanticStatus('loading');
    let timedOut = false;
    const timeout = window.setTimeout(() => {
      timedOut = true;
      controller.abort();
      // Keep any prior sticky results; surface the retry affordance.
      setSemanticStatus('error');
    }, COMMAND_PALETTE_SEARCH_TIMEOUT_MS);
    semanticTimerRef.current = timeout;
    void fetchWorkspaceSearchEntries(q, {
      signal: controller.signal,
      semantic: true,
      limit: SEMANTIC_RESULT_LIMIT,
    })
      .then(({ entries }) => {
        clearThisFire(timeout, controller);
        setSemanticResults(entries);
        setSemanticFiredQuery(q);
        setSemanticStatus('success');
      })
      .catch((error: unknown) => {
        clearThisFire(timeout, controller);
        // A newer fire (or a mode exit) aborted this one — let newer state win.
        if (error instanceof Error && error.name === 'AbortError' && !timedOut) return;
        // Debug-level: a timeout or network failure on a non-critical search.
        // The UI surfaces the retry row; this is for diagnosis without alarming.
        console.debug('[semantic-search] fire failed', { timedOut, error });
        setSemanticStatus('error');
      });
  }

  // Clear this fire's timer and release the in-flight refs — but only if they
  // still point at THIS fire, so a newer fire that already replaced them isn't
  // clobbered. Keeps the refs' "non-null = a search is in flight" invariant true,
  // which resetSemanticState() and the open-toggle effect both rely on.
  function clearThisFire(timeout: number, controller: AbortController) {
    window.clearTimeout(timeout);
    if (semanticTimerRef.current === timeout) semanticTimerRef.current = null;
    if (semanticAbortRef.current === controller) semanticAbortRef.current = null;
  }

  // Enter in semantic mode is deterministic: while a deliberate fire is the
  // action (a dirty query or a retry) it fires and never opens a row; once the
  // held results are current (no submit row) it falls through to cmdk, which
  // opens the highlighted hit. Handled at the input so it preempts cmdk's own
  // Enter (events bubble input → cmdk root).
  function onSemanticInputKeyDown(e: ReactKeyboardEvent<HTMLInputElement>) {
    if (!isSemanticMode || e.key !== 'Enter') return;
    if (semanticView?.submit) {
      e.preventDefault();
      e.stopPropagation();
      fireSemanticSearch(semanticView.submit.query);
    } else if (semanticStatus === 'loading') {
      // Don't navigate away on a stray Enter while a search is in flight.
      e.preventDefault();
      e.stopPropagation();
    }
  }

  // Escape exits semantic mode first (restoring the lexical palette), protecting
  // the sticky result set from an accidental close; a second Escape — now
  // lexical — is not intercepted and closes the dialog. Diverges from tag-mode,
  // which closes on the first Escape.
  function onPaletteEscapeKeyDown(e: KeyboardEvent) {
    if (!isSemanticMode) return;
    e.preventDefault();
    exitSemanticMode();
  }

  return (
    <>
      <CommandDialog
        open={open}
        onOpenChange={onOpenChange}
        title={t`Workspace Command Palette`}
        description={t`Search files, folders, and commands for the current workspace.`}
        className="sm:max-w-2xl"
        commandProps={{
          shouldFilter: false,
          className:
            '[&_[cmdk-input-wrapper]_svg]:h-4 [&_[cmdk-input-wrapper]_svg]:w-4 [&_[cmdk-item]_svg]:h-4 [&_[cmdk-item]_svg]:w-4',
        }}
        onEscapeKeyDown={onPaletteEscapeKeyDown}
      >
        <CommandInput
          ref={inputRef}
          value={query}
          onValueChange={setQuery}
          onKeyDown={onSemanticInputKeyDown}
          placeholder={
            isSemanticMode ? t`Search by meaning` : t`Search files, folders, or commands`
          }
        />
        {/* Filter-pills row — Slack-style. Always visible so the
            available filters are discoverable without typing a magic
            prefix. Active pills highlight when their filter is in
            effect; clicking a highlighted pill exits the filter. */}
        <div className="flex flex-wrap gap-1.5 border-b px-3 py-2">
          <button
            type="button"
            onClick={() => {
              // Leaving semantic mode for tag mode: drop the sticky set first.
              if (isSemanticMode) {
                setIsSemanticMode(false);
                resetSemanticState();
              }
              setQuery(isTagMode ? '' : TAG_QUERY_PREFIX);
              // Restore focus to the input so the user can keep
              // typing after toggling the filter — clicking the
              // button steals focus, and Slack's pills snap focus
              // back so this matches the same muscle memory.
              inputRef.current?.focus();
            }}
            data-testid="command-palette-filter-tag"
            data-active={isTagMode}
            aria-pressed={isTagMode}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors',
              isTagMode
                ? 'border-primary/30 bg-primary/10 text-primary'
                : 'border-border bg-transparent text-muted-foreground hover:bg-accent hover:text-accent-foreground',
            )}
          >
            <Hash className="size-3.5" />
            <span>
              <Trans>By tag</Trans>
            </span>
          </button>
          {/* Shown only when semantic search is set up for this project (enabled
              + key). Enters an exclusive "by meaning" mode — a deliberate-submit
              vector search, distinct from the per-keystroke lexical filters. */}
          {semanticCapable ? (
            <button
              type="button"
              onClick={() => (isSemanticMode ? exitSemanticMode() : enterSemanticMode())}
              data-testid="command-palette-filter-semantic"
              data-active={isSemanticMode}
              aria-pressed={isSemanticMode}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors',
                isSemanticMode
                  ? 'border-primary/30 bg-primary/10 text-primary'
                  : 'border-border bg-transparent text-muted-foreground hover:bg-accent hover:text-accent-foreground',
              )}
            >
              <Sparkles className="size-3.5" />
              <span>
                <Trans>By meaning</Trans>
              </span>
            </button>
          ) : null}
        </div>
        <CommandList ref={listRef} className="subtle-scrollbar">
          {isSemanticMode && semanticView ? (
            <>
              {/* Coverage banner — the first by-meaning search lazily kicks off the
                  background embed, so the corpus may be partly (or not yet) indexed.
                  Surface it so the user knows results may be incomplete; the count
                  ticks up via the poll above. */}
              {semanticIndexing ? (
                <div
                  className="flex items-center gap-2 px-3 py-2 text-muted-foreground text-xs"
                  role="status"
                  aria-live="polite"
                  data-testid="command-palette-semantic-indexing"
                >
                  <Loader2 className="size-3.5 animate-spin" />
                  <Trans>
                    Indexing your pages — {semanticIndexedCount} of {semanticTotalCount} ready.
                    Results may be incomplete.
                  </Trans>
                </div>
              ) : null}

              {/* Submit / retry row — the action ↵ performs while the query is
                  dirty or after an error. Rendered first so it is the default
                  highlight; the input's keydown makes ↵ deterministic regardless. */}
              {semanticView.submit ? (
                <CommandGroup>
                  <CommandItem
                    value="semantic-submit"
                    onSelect={() => fireSemanticSearch(semanticSubmitQuery)}
                    data-testid="command-palette-semantic-submit"
                  >
                    {semanticView.submit.kind === 'retry' ? (
                      <span className="flex items-center gap-2 text-amber-700 dark:text-amber-400">
                        <Sparkles />
                        <Trans>Couldn't reach the embeddings provider — press ↵ to retry</Trans>
                      </span>
                    ) : (
                      <>
                        <Sparkles />
                        <span className="min-w-0 flex-1 truncate">
                          <Trans>Search "{semanticSubmitQuery}" by meaning</Trans>
                        </span>
                        <CommandShortcut>↵</CommandShortcut>
                      </>
                    )}
                  </CommandItem>
                </CommandGroup>
              ) : null}

              {semanticView.notice === 'empty' ? (
                <CommandEmpty data-testid="command-palette-semantic-empty">
                  <Trans>Type a query, then press ↵ to search your pages by meaning.</Trans>
                </CommandEmpty>
              ) : null}
              {semanticView.notice === 'searching' ? (
                <div
                  className="flex items-center justify-center gap-2 py-6 text-muted-foreground text-sm"
                  role="status"
                  aria-live="polite"
                  data-testid="command-palette-semantic-searching"
                >
                  <Loader2 className="size-4 animate-spin" />
                  <Trans>Searching by meaning</Trans>
                </div>
              ) : null}
              {semanticView.notice === 'no-results' ? (
                <CommandEmpty data-testid="command-palette-semantic-no-results">
                  <Trans>No pages matched "{semanticQueryText}" by meaning.</Trans>
                </CommandEmpty>
              ) : null}

              {/* Held (sticky) results in the server's fusion order — no omnibar
                  fuzzy/recency re-ranking. Dimmed + labeled with the query they
                  were fetched for while the typed query has moved past them. */}
              {semanticView.results.show ? (
                <CommandGroup
                  heading={
                    semanticView.results.dimmed
                      ? t`Showing results for "${semanticResultsLabel}"`
                      : t`By meaning`
                  }
                >
                  <div
                    data-testid="command-palette-semantic-results"
                    data-dimmed={semanticView.results.dimmed}
                  >
                    {semanticResults.map((entry) => (
                      <NavigationItem
                        key={makeOmnibarRecentKey(entry.kind, entry.path)}
                        entry={entry}
                        disabled={semanticView.results.dimmed}
                        onSelect={() => navigateToEntry(entry)}
                      />
                    ))}
                  </div>
                </CommandGroup>
              ) : null}
            </>
          ) : null}
          {showSearchPreparing ? (
            <div
              className="flex items-center justify-center gap-2 py-6 text-muted-foreground text-sm"
              role="status"
              aria-live="polite"
              data-testid="command-palette-search-preparing"
            >
              <Loader2 className="size-4 animate-spin" />
              <Trans>Preparing search</Trans>
            </div>
          ) : null}
          {showSearchLoading && !showNavigation ? (
            <CommandEmpty>
              <Trans>Searching</Trans>
            </CommandEmpty>
          ) : null}
          {!hasAnyResults ? (
            <CommandEmpty>
              {searchStatus === 'error' ? (
                <Trans>Search failed.</Trans>
              ) : (
                <Trans>No matching commands.</Trans>
              )}
            </CommandEmpty>
          ) : null}

          {paletteMode.kind === 'tag-list' ? (
            <CommandGroup
              heading={paletteMode.query ? t`Tags matching "${tagListQuery}"` : t`All tags`}
            >
              {tagsListStatus === 'loading' ? (
                <CommandEmpty>
                  <Trans>Loading tags</Trans>
                </CommandEmpty>
              ) : null}
              {tagsListStatus === 'error' ? (
                <CommandEmpty>
                  <Trans>Failed to load tags. Press Escape and re-open to retry.</Trans>
                </CommandEmpty>
              ) : null}
              {showTagListEmpty ? (
                <CommandEmpty>
                  {paletteMode.query
                    ? t`No tags match "${tagListQuery}".`
                    : t`No tags yet — author \`#tagname\` in any doc to populate the index.`}
                </CommandEmpty>
              ) : null}
              {tagListItems.map((tag) => (
                <CommandItem
                  key={`tag:${tag.name}`}
                  value={`tag ${tag.name}`}
                  onSelect={() => navigateToTagDocs(tag.name)}
                  data-testid={`command-palette-tag-${tag.name}`}
                >
                  <Hash />
                  <span className="min-w-0 flex-1 truncate font-medium">{tag.name}</span>
                  <span className="ml-auto shrink-0 text-[11px] text-muted-foreground tabular-nums">
                    <Plural value={tag.count} one="# doc" other="# docs" />
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          ) : null}

          {paletteMode.kind === 'tag-docs' ? (
            <CommandGroup heading={t`Docs tagged #${tagDocsName}`}>
              {tagDocsStatus === 'loading' ? (
                <CommandEmpty>
                  <Trans>Loading docs</Trans>
                </CommandEmpty>
              ) : null}
              {tagDocsStatus === 'error' ? (
                <CommandEmpty>
                  <Trans>Failed to load docs. Press Escape and re-open to retry.</Trans>
                </CommandEmpty>
              ) : null}
              {showTagDocsEmpty ? (
                <CommandEmpty>{t`No docs registered under #${tagDocsName}.`}</CommandEmpty>
              ) : null}
              {tagDocs.map((doc) => {
                const title = doc.title || doc.docName.split('/').pop() || doc.docName;
                // Child tags under the queried prefix (rollup hits) — bound to
                // a local so the `<Trans>` placeholder extracts as `{viaTags}`.
                const viaTags = doc.matchingTags
                  .filter((tag) => tag !== paletteMode.tagName)
                  .map((tag) => `#${tag}`)
                  .join(', ');
                return (
                  <CommandItem
                    key={`tag-doc:${doc.docName}`}
                    value={`tag-doc ${doc.docName}`}
                    onSelect={() => {
                      onOpenChange(false);
                      navigateToDocHash(doc.docName);
                    }}
                    data-testid={`command-palette-tag-doc-${doc.docName}`}
                    className="items-start"
                  >
                    <FileText className="mt-0.5" />
                    <div className="flex min-w-0 flex-1 flex-col gap-1">
                      <span className="truncate font-medium">{title}</span>
                      <span className="truncate text-muted-foreground text-xs">{doc.docName}</span>
                      {doc.matchingTags.length > 0 &&
                      // Only show the tag chip when the matching tag
                      // is a child of the queried prefix (rollup hit) —
                      // not when it's literally the queried tag itself.
                      doc.matchingTags.some((tag) => tag !== paletteMode.tagName) ? (
                        <span className="truncate text-muted-foreground text-[11px]">
                          <Trans>via {viaTags}</Trans>
                        </span>
                      ) : null}
                    </div>
                  </CommandItem>
                );
              })}
            </CommandGroup>
          ) : null}

          {showRecentNavigation ? (
            <CommandGroup heading={t`Recently opened`}>
              {visibleRecents.map((entry) => (
                <NavigationItem
                  key={makeOmnibarRecentKey(entry.kind, entry.path)}
                  entry={entry}
                  onSelect={() => navigateToEntry(entry)}
                />
              ))}
            </CommandGroup>
          ) : null}

          {showCreateFile || showCreateFolder || showGraphCommand || showInitializeStarterPack ? (
            <CommandGroup heading={t`Commands`}>
              {showCreateFile ? (
                <CommandItem
                  value="new file create file"
                  onSelect={() => {
                    onOpenChange(false);
                    setCreateDialogKind('file');
                  }}
                  data-testid="command-palette-new-file"
                >
                  <FilePlus2 />
                  <span>
                    <Trans>New file</Trans>
                  </span>
                  <CommandShortcut>{formatShortcut('new-item')}</CommandShortcut>
                </CommandItem>
              ) : null}
              {showCreateFolder ? (
                <CommandItem
                  value="new folder create folder"
                  onSelect={() => {
                    onOpenChange(false);
                    setCreateDialogKind('folder');
                  }}
                  data-testid="command-palette-new-folder"
                >
                  <FolderPlus />
                  <span>
                    <Trans>New folder</Trans>
                  </span>
                  {bridge ? (
                    <CommandShortcut>{formatShortcut('new-folder')}</CommandShortcut>
                  ) : null}
                </CommandItem>
              ) : null}
              {showGraphCommand ? (
                <CommandItem
                  value="open graph graph panel network"
                  onSelect={() => {
                    if (!activeDocName) return;
                    onOpenChange(false);
                    requestDocPanelTab('graph');
                  }}
                  data-testid="command-palette-open-graph"
                >
                  <Network />
                  <span>
                    <Trans>Open graph</Trans>
                  </span>
                </CommandItem>
              ) : null}
              {showInitializeStarterPack ? (
                <CommandItem
                  value="initialize starter pack scaffold seed"
                  onSelect={() => {
                    onOpenChange(false);
                    setSeedDialogOpen(true);
                  }}
                  data-testid="command-palette-initialize-starter-pack"
                >
                  <Package />
                  <span>
                    <Trans>Initialize starter pack</Trans>
                  </span>
                </CommandItem>
              ) : null}
            </CommandGroup>
          ) : null}

          {showAgentGroup ? (
            <CommandGroup heading={t`Open with AI`}>
              {VISIBLE_TARGETS.filter((target) => {
                const displayName = target.displayName;
                return matchesCommandQuery(t`Open with AI ${displayName}`, deferredQuery, [
                  target.id,
                  'agent handoff',
                  'open in',
                ]);
              }).map((target) => {
                const installState = installStates[target.id];
                const enabled = installState.installed === true && handoffInput !== null;
                const displayName = target.displayName;
                // The Command palette has no tooltip affordance on disabled
                // rows; the dropdown surface (EditorHeader) carries the full
                // tooltip UX with install affordances. Here we surface
                // install/detection status only; no-active-doc rows are hidden
                // before this group renders.
                const hint =
                  installState.installed === null
                    ? t`Detecting`
                    : installState.installed === false
                      ? t`Not installed`
                      : null;
                // Status hint for disabled rows is rendered as a plain <span>
                // rather than <CommandShortcut>. CommandShortcut is cmdk's
                // right-aligned affordance semantically reserved for keyboard
                // shortcuts (Open Folder / Switch Project). Overloading it with status copy
                // ("Not installed", "Desktop only") conflated the shortcut
                // affordance with disabled-state messaging; the plain span is
                // the same visual placement without the semantic overload.
                // `aria-label` composes the hint into the accessible name so
                // AT users hear "Open with AI Codex, Not installed" rather than
                // the bare "Open with AI Codex" that matches an enabled row.
                const accessibleLabel = hint
                  ? t`Open with AI ${displayName}, ${hint}`
                  : t`Open with AI ${displayName}`;

                return (
                  <CommandItem
                    key={target.id}
                    value={`send to ai ${target.displayName} ${target.id} agent open in`}
                    disabled={!enabled}
                    onSelect={() => {
                      if (!enabled || !handoffInput) return;
                      onOpenChange(false);
                      void dispatchHandoff(target.id, handoffInput);
                    }}
                    data-testid={`command-palette-open-in-${target.id}`}
                    aria-label={accessibleLabel}
                  >
                    <span className="flex-1">
                      <Trans>Open with AI {displayName}</Trans>
                    </span>
                    {hint ? (
                      <span aria-hidden="true" className="ml-auto text-muted-foreground text-xs">
                        {hint}
                      </span>
                    ) : null}
                  </CommandItem>
                );
              })}
            </CommandGroup>
          ) : null}

          {showCreateProject ||
          showProjectOpenFolder ||
          showProjectSwitch ||
          showSettings ||
          showInstallClaudeDesktop ? (
            <CommandGroup heading={t`Project`}>
              {showCreateProject && bridge ? (
                <CommandItem
                  value="new project create scaffold"
                  onSelect={() => {
                    onOpenChange(false);
                    setCreateProjectOpen(true);
                  }}
                  data-testid="command-palette-new-project"
                >
                  <Plus />
                  <span>
                    <Trans>New project</Trans>
                  </span>
                </CommandItem>
              ) : null}
              {showProjectOpenFolder && bridge ? (
                <CommandItem
                  value="open folder on disk project"
                  onSelect={() =>
                    runAction(async () => {
                      const path = await bridge.dialog.openFolder();
                      if (!path) return;
                      await bridge.project.open({
                        path,
                        target: 'new-window',
                        entryPoint: 'pick-existing',
                      });
                    })
                  }
                  data-testid="command-palette-open-folder"
                >
                  <FolderOpen />
                  <span>
                    <Trans>Open folder on disk</Trans>
                  </span>
                  <CommandShortcut>{formatShortcut('open-folder')}</CommandShortcut>
                </CommandItem>
              ) : null}
              {showProjectSwitch && bridge ? (
                <CommandItem
                  value="switch-project navigator projects"
                  onSelect={() =>
                    runAction(() => bridge.navigator.open(), t`Failed to open Project Navigator.`)
                  }
                  data-testid="command-palette-switch-project"
                >
                  <LayoutGrid />
                  <span>
                    <Trans>Switch project</Trans>
                  </span>
                  <CommandShortcut>{formatShortcut('switch-project')}</CommandShortcut>
                </CommandItem>
              ) : null}
              {showSettings ? (
                <CommandItem
                  value="settings preferences config"
                  onSelect={() => {
                    onOpenChange(false);
                    if (window.location.hash !== SETTINGS_OPEN_HASH) {
                      window.location.hash = SETTINGS_OPEN_HASH;
                    }
                  }}
                  data-testid="command-palette-settings"
                >
                  <Settings />
                  <span>
                    <Trans>Settings</Trans>
                  </span>
                  <CommandShortcut>{formatShortcut('settings')}</CommandShortcut>
                </CommandItem>
              ) : null}
              {showInstallClaudeDesktop ? (
                <CommandItem
                  value="install claude desktop cowork app"
                  onSelect={() => {
                    onOpenChange(false);
                    window.location.hash = '#install-claude-desktop';
                  }}
                  data-testid="command-palette-install-claude-desktop"
                >
                  <Download />
                  <span>
                    <Trans>Install for Claude Chat & Cowork (Desktop App)</Trans>
                  </span>
                </CommandItem>
              ) : null}
            </CommandGroup>
          ) : null}

          {showProjectRecents && bridge ? (
            <CommandGroup heading={t`Open recent project`}>
              {switchableProjects
                .filter((row) =>
                  matchesCommandQuery(`${row.name} ${row.path}`, deferredQuery, [
                    'open recent project',
                  ]),
                )
                .slice(0, 10)
                .map((row) => {
                  const isWorktree = row.isLinkedWorktree === true;
                  // Match RecentProjectsMenu's icon scheme: a worktree reads as
                  // a branch; every project uses the same plain folder. The
                  // base-project note names the repo a worktree belongs to
                  // (e.g. "worktree of pnw-fishing").
                  const RowIcon = isWorktree ? GitBranch : Folder;
                  const worktreeOf =
                    isWorktree && row.mainRoot !== undefined ? basenameOf(row.mainRoot) : null;
                  return (
                    <CommandItem
                      key={row.path}
                      value={`${row.name} ${row.path} recent project`}
                      disabled={row.missing}
                      onSelect={() =>
                        runAction(
                          () =>
                            bridge.project.open({
                              path: row.path,
                              target: 'new-window',
                              entryPoint: 'recents',
                            }),
                          t`Failed to open project.`,
                        )
                      }
                      data-testid={`command-palette-recent-${row.path}`}
                      className="items-start"
                    >
                      <RowIcon className="mt-0.5" />
                      <div className="flex min-w-0 flex-col gap-1">
                        <span className="truncate font-medium">{row.name}</span>
                        {worktreeOf !== null ? (
                          <span className="truncate text-muted-foreground text-xs">
                            <Trans>worktree of {worktreeOf}</Trans>
                          </span>
                        ) : null}
                        <span className="truncate text-muted-foreground text-xs">
                          {row.path}
                          {row.missing ? (
                            <>
                              {'  '}
                              <Trans>(missing)</Trans>
                            </>
                          ) : null}
                        </span>
                      </div>
                    </CommandItem>
                  );
                })}
            </CommandGroup>
          ) : null}

          {showWorktrees && bridge ? (
            <CommandGroup heading={t`Worktrees`}>
              {matchedWorktrees.slice(0, 10).map((entry) => (
                <CommandItem
                  key={entry.branch}
                  value={`${entry.branch} worktree branch`}
                  onSelect={() => openWorktreeEntry(entry)}
                  data-testid={`command-palette-worktree-${entry.branch}`}
                  className="items-start"
                >
                  <GitBranch className="mt-0.5" />
                  <div className="flex min-w-0 flex-col gap-1">
                    <span className="truncate font-medium">{entry.branch}</span>
                    <span className="truncate text-muted-foreground text-xs">
                      {entry.worktreePath ?? t`Create worktree`}
                    </span>
                  </div>
                </CommandItem>
              ))}
            </CommandGroup>
          ) : null}

          {showNavigation ? (
            <CommandGroup heading={t`Search`}>
              {visibleSearchResults.map((entry) => (
                <NavigationItem
                  key={makeOmnibarRecentKey(entry.kind, entry.path)}
                  entry={entry}
                  query={trimmedDeferredQuery}
                  onSelect={() => navigateToEntry(entry)}
                />
              ))}
            </CommandGroup>
          ) : null}
        </CommandList>

        {/* Search-hint affordance, rendered OUTSIDE `<CommandList>` (which
            cmdk gives `role="listbox"`; only option/group children are
            valid there) but still INSIDE `CommandDialog` so it shares the
            dialog's framing. Absent when at least one server hit carries a
            body snippet. The empty-query branch (`'idle'`) renders nothing
            so the Recents view is unaffected. */}
        <SearchHint
          mode={classifyOmnibarSearchHint(trimmedDeferredQuery, visibleSearchResults, {
            truncated: searchTruncated,
          })}
          inExclusiveMode={inExclusiveMode}
          paletteModeKind={paletteMode.kind}
        />
      </CommandDialog>

      <NewItemDialog
        open={createDialogKind === 'file'}
        onOpenChange={(next) => {
          if (!next) setCreateDialogKind(null);
        }}
        kind="file"
        initialDir={initialCreateDir}
      />
      <NewItemDialog
        open={createDialogKind === 'folder'}
        onOpenChange={(next) => {
          if (!next) setCreateDialogKind(null);
        }}
        kind="folder"
        initialDir={initialCreateDir}
      />
      <SeedDialog open={seedDialogOpen} onOpenChange={setSeedDialogOpen} />
      {/* Desktop-only — `showCreateProject` gates the launching command on
          `bridge !== null`, so the dialog only mounts when the bridge exists. */}
      {bridge ? (
        <CreateProjectDialog
          open={createProjectOpen}
          onOpenChange={setCreateProjectOpen}
          bridge={bridge}
        />
      ) : null}
    </>
  );
}

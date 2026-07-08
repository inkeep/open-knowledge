// biome-ignore-all lint/plugin/no-raw-html-interactive-element: pre-rule backlog — file uses raw <button>/<input>/<textarea> awaiting shadcn migration; tracked at https://github.com/inkeep/open-knowledge/blob/main/biome-plugins/README.md#no-raw-html-interactive-elementgrit

import {
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  arrayMove,
  horizontalListSortingStrategy,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
} from '@dnd-kit/sortable';
import { RenamePathSuccessSchema } from '@inkeep/open-knowledge-core';
import { Trans, useLingui } from '@lingui/react/macro';
import { AlertTriangle, PinIcon, PlusIcon, XIcon } from 'lucide-react';
import {
  type HTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
  useEffect,
  useRef,
  useState,
  type WheelEvent,
} from 'react';
import { toast } from 'sonner';
import {
  buildRenamedNodePath,
  isValidNodeName,
  normalizeRenameValue,
  planRenameCleanupCalls,
  remapActiveDocName,
} from '@/components/file-tree-operations';
import { Button } from '@/components/ui/button';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  InputGroupText,
} from '@/components/ui/input-group';
import { Kbd } from '@/components/ui/kbd';
import { useDocumentContext } from '@/editor/DocumentContext';
import { captureRenameSnapshots } from '@/editor/editor-cache';
import {
  docTabId,
  filterClosableTabIds,
  parseEditorTabId,
  tabIdForNavigationTarget,
  tabParts,
} from '@/editor/editor-tabs';
import { useLifecycleStatus } from '@/hooks/use-lifecycle-status';
import { hashFromDocName } from '@/lib/doc-hash';
import { emitDocumentsChanged } from '@/lib/documents-events';
import { matchesKeyboardShortcut } from '@/lib/keyboard-shortcuts';
import { parseServerResponse, parseSuccessOrWarn } from '@/lib/parse-server-response';
import { cn } from '@/lib/utils';
import {
  createTabReorderModifier,
  getSortableTabClassName,
  getSortableTabKeyDownAction,
  getSortableTabStyle,
  getTabCloseButtonClass,
  getTabCloseButtonTabIndex,
  measureTabReorderBounds,
  TAB_KEYBOARD_DRAG_CODES,
  TAB_REORDER_AUTO_SCROLL,
  type TabReorderBounds,
  tabRunCollisionDetection,
} from './editor-tabs-chrome';
import { usePageList } from './PageListContext';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';

const TAB_RENAME_EXTENSIONS = ['.md', '.mdx'] as const;
const TAB_BASE_CLASS =
  'group relative -mb-px flex h-10 min-w-28 max-w-64 shrink-0 cursor-pointer items-center overflow-hidden border border-transparent font-medium transition-colors';
const TAB_ACTIVE_CLASS =
  'z-10 rounded-t-lg rounded-b-none border-border border-b-0 bg-background text-foreground';
const TAB_INACTIVE_CLASS = cn(
  TAB_ACTIVE_CLASS,
  'bg-transparent hover:bg-muted focus-visible:bg-muted border-transparent hover:border-border focus-visible:border-border',
);
const TAB_BUTTON_CLASS =
  'flex h-full min-w-0 flex-1 cursor-pointer items-center overflow-hidden px-3 text-left text-[13px]';

function tabDomIdPart(docName: string): string {
  return docName.replace(/[^A-Za-z0-9_-]/g, '-');
}

function navigateToDoc(docName: string) {
  const nextHash = hashFromDocName(docName);
  if (window.location.hash !== nextHash) {
    window.location.hash = nextHash;
  }
}

function scrollTabListOnWheel(event: WheelEvent<HTMLDivElement>) {
  if (Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return;
  if (event.currentTarget.scrollWidth <= event.currentTarget.clientWidth) return;
  event.preventDefault();
  event.currentTarget.scrollLeft += event.deltaY;
}

function stripRenameExtensionSuffix(value: string, docExt: string): string {
  const extensions = [docExt, ...TAB_RENAME_EXTENSIONS].filter(
    (ext, index, all) => ext && all.indexOf(ext) === index,
  );
  const lowerValue = value.toLowerCase();
  const extension = extensions.find(
    (ext) => value.length > ext.length && lowerValue.endsWith(ext.toLowerCase()),
  );
  return extension ? value.slice(0, -extension.length) : value;
}

function hasTabShortcutModifier(event: globalThis.KeyboardEvent): boolean {
  return event.metaKey || event.ctrlKey;
}

const TAB_SHORTCUT_HINT_DELAY_MS = 1000;

function shortcutDigitForIndex(index: number, tabCount: number): string | null {
  if (index < 0 || index >= tabCount) return null;
  if (index < 8) return String(index + 1);
  return index === tabCount - 1 ? '9' : null;
}

function tabShortcutHintForIndex(index: number, tabCount: number): string | null {
  return shortcutDigitForIndex(index, tabCount);
}

function tabAriaKeyShortcutsForIndex(index: number, tabCount: number): string | undefined {
  const shortcutDigit = shortcutDigitForIndex(index, tabCount);
  if (!shortcutDigit) return undefined;
  return [`Meta+${shortcutDigit}`, `Control+${shortcutDigit}`].join(' ');
}

function jumpTabIndexFromShortcut(
  event: globalThis.KeyboardEvent,
  tabCount: number,
): number | null {
  if (!hasTabShortcutModifier(event) || event.altKey || event.shiftKey) return null;
  if (!/^[1-9]$/.test(event.key)) return null;
  const digit = Number(event.key);
  if (digit === 9) return tabCount > 0 ? tabCount - 1 : null;
  const index = digit - 1;
  return index < Math.min(8, tabCount) ? index : null;
}

function TabShortcutHint({ value }: { value: string }) {
  return (
    <span
      aria-hidden="true"
      data-testid="editor-tab-shortcut-hint"
      className={cn(
        getTabCloseButtonClass(true),
        'font-mono tabular-nums hover:bg-transparent animate-in fade-in-0 zoom-in-95 duration-150 motion-reduce:animate-none motion-reduce:duration-0',
      )}
    >
      <Kbd className="text-[10px]">{`⌘${value}`}</Kbd>
    </span>
  );
}

/**
 * Sortable wrapper for one tab div, bound to `@dnd-kit/sortable`'s
 * `useSortable` so the whole tab (not a separate drag handle) is draggable.
 * Activation is gated by the outer DndContext's PointerSensor `distance: 8`
 * so plain clicks still activate / close the tab. While renaming, `disabled`
 * short-circuits the sortable bindings — the inline input keeps full
 * pointer/keyboard affordance and the tab stays in place.
 *
 * Callers should not pass a `role` prop. `useSortable`'s `attributes` inject
 * `role="button"` + `aria-roledescription="sortable"` so screen readers can
 * discover and announce reorder. `{...attributes}` is spread AFTER `{...rest}`
 * (see the render JSX below) so dnd-kit's bindings structurally win over any
 * caller-supplied `role`. Keep the convention anyway — the spread-order
 * guarantee is one refactor away from being lost. The outer sortable tab is
 * the keyboard focus target; inner activation buttons stay out of the tab
 * order so each tab is one stop.
 */
function SortableTab({
  activateFromKeyboard,
  className,
  tabId,
  disabled,
  onKeyDown,
  ref: outerRef,
  style: outerStyle,
  ...rest
}: {
  activateFromKeyboard?: () => void;
  tabId: string;
  disabled?: boolean;
  ref?: Ref<HTMLDivElement>;
} & HTMLAttributes<HTMLDivElement>) {
  const { attributes, listeners, rect, setNodeRef, transform, transition, isDragging } =
    useSortable({
      id: tabId,
      disabled,
    });
  const style = getSortableTabStyle({
    activeWidth: rect.current?.width,
    isDragging,
    outerStyle,
    transform,
    transition,
  });
  function composedRef(node: HTMLDivElement | null) {
    setNodeRef(node);
    if (typeof outerRef === 'function') outerRef(node);
    else if (outerRef && 'current' in outerRef) {
      // React 19's RefObject<T> is { current: T } — mutable, no cast needed.
      outerRef.current = node;
    }
  }
  const sortableKeyDown = listeners?.onKeyDown;
  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    onKeyDown?.(event);
    const action = getSortableTabKeyDownAction({
      event,
      hasKeyboardActivation: Boolean(activateFromKeyboard),
      isDragging,
    });
    if (action === 'ignore') return;
    if (action === 'activate-tab' && activateFromKeyboard) {
      event.preventDefault();
      activateFromKeyboard();
      return;
    }
    sortableKeyDown?.(event);
  }
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: dnd-kit attributes inject role and tabIndex; this composes the sortable key listener.
    <div
      ref={composedRef}
      data-editor-tab-sortable=""
      className={getSortableTabClassName({ className, isDragging })}
      style={style}
      {...rest}
      {...attributes}
      {...listeners}
      onKeyDown={handleKeyDown}
    />
  );
}

function EditorTabContextMenu({
  children,
  closeTab,
  closeTabs,
  canPin = true,
  disabled = false,
  openTabs,
  pinTab,
  pinnedTabIds,
  tabId,
  unpinTab,
}: {
  children: ReactNode;
  canPin?: boolean;
  closeTab: (tabId: string) => void;
  closeTabs: (tabIds: readonly string[]) => void;
  disabled?: boolean;
  openTabs: readonly string[];
  pinTab: (tabId: string) => void;
  pinnedTabIds: readonly string[];
  tabId: string;
  unpinTab: (tabId: string) => void;
}) {
  if (disabled) return children;

  const isPinned = canPin && pinnedTabIds.includes(tabId);
  const otherTabIds = filterClosableTabIds(
    openTabs.filter((openTabId) => openTabId !== tabId),
    pinnedTabIds,
  );
  const closableTabIds = filterClosableTabIds(openTabs, pinnedTabIds);

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className="min-w-40">
        <ContextMenuItem disabled={isPinned} onSelect={() => closeTab(tabId)}>
          <Trans>Close</Trans>
        </ContextMenuItem>
        <ContextMenuItem
          disabled={otherTabIds.length === 0}
          onSelect={() => {
            closeTabs(otherTabIds);
          }}
        >
          <Trans>Close others</Trans>
        </ContextMenuItem>
        <ContextMenuItem
          disabled={closableTabIds.length === 0}
          data-testid="editor-tab-context-close-all"
          onSelect={() => {
            closeTabs(closableTabIds);
          }}
        >
          {pinnedTabIds.length ? <Trans>Close all unpinned</Trans> : <Trans>Close all</Trans>}
        </ContextMenuItem>
        {canPin && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem
              data-testid="editor-tab-context-pin-toggle"
              onSelect={() => (isPinned ? unpinTab(tabId) : pinTab(tabId))}
            >
              {isPinned ? <Trans>Unpin tab</Trans> : <Trans>Pin tab</Trans>}
            </ContextMenuItem>
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}

function TabPinOrCloseButton({
  accessibleLabel,
  closeTab,
  forceCloseVisible = false,
  isActive,
  isPinned,
  shortcutHint = null,
  tabId,
  unpinTab,
}: {
  accessibleLabel: string;
  closeTab: (tabId: string) => void;
  forceCloseVisible?: boolean;
  isActive: boolean;
  isPinned: boolean;
  shortcutHint?: string | null;
  tabId: string;
  unpinTab: (tabId: string) => void;
}) {
  const { t } = useLingui();
  if (shortcutHint) {
    return <TabShortcutHint value={shortcutHint} />;
  }

  if (isPinned) {
    return (
      <Button
        variant="ghost"
        size="icon-xs"
        type="button"
        aria-label={t`Unpin ${accessibleLabel}`}
        data-testid="editor-tab-unpin-button"
        className="mr-1.5 text-primary! hover:bg-primary/10!"
        onClick={(event) => {
          event.stopPropagation();
          unpinTab(tabId);
        }}
      >
        <PinIcon aria-hidden="true" />
      </Button>
    );
  }

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      aria-label={t`Close ${accessibleLabel}`}
      data-testid="editor-tab-close-button"
      className={getTabCloseButtonClass(forceCloseVisible || isActive)}
      tabIndex={getTabCloseButtonTabIndex(isActive)}
      onClick={(event) => {
        event.stopPropagation();
        closeTab(tabId);
      }}
    >
      <XIcon aria-hidden="true" />
    </Button>
  );
}

// The parent tab button owns the accessible conflict label; this icon is visual.
function TabConflictBadge({ hasConflict }: { hasConflict: boolean }) {
  if (!hasConflict) return null;
  return (
    <AlertTriangle
      aria-hidden="true"
      data-testid="editor-tab-conflict-badge"
      className="mr-1 size-3.5 shrink-0 text-amber-500"
    />
  );
}

function DocumentTabButton({
  accessibleLabel,
  activateTab,
  baseName,
  docName,
  enterRenameMode,
  extension,
  hideDocExtension,
  tabId,
}: {
  accessibleLabel: string;
  activateTab: (tabId: string) => void;
  baseName: string;
  docName: string;
  enterRenameMode: (tabId: string, docName: string) => void;
  extension: string;
  hideDocExtension: boolean;
  tabId: string;
}) {
  const { t } = useLingui();
  const lifecycleStatus = useLifecycleStatus(docName);
  const hasConflict = lifecycleStatus === 'conflict';
  const buttonAccessibleLabel = hasConflict ? t`${accessibleLabel} (conflict)` : accessibleLabel;

  return (
    <button
      type="button"
      aria-label={buttonAccessibleLabel}
      title={buttonAccessibleLabel}
      className={TAB_BUTTON_CLASS}
      onClick={() => {
        activateTab(tabId);
      }}
      onDoubleClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        enterRenameMode(tabId, docName);
      }}
      tabIndex={-1}
    >
      <TabConflictBadge hasConflict={hasConflict} />
      <span className="flex min-w-0 flex-1 items-center">
        <span className="min-w-0 truncate">{baseName}</span>
        {!hideDocExtension && <span className="shrink-0">{extension}</span>}
      </span>
    </button>
  );
}

export function EditorTabs() {
  const {
    activeDocName,
    activeTabId: activeContextTabId,
    activeNewTabId,
    activeTarget,
    activateTab,
    activateNewTab,
    closeAndClearForRename,
    closeNewTab,
    closeTab,
    closeTabs,
    getPoolActiveDocName,
    poolHas,
    isNewTabActive,
    newTabIds,
    openNewTab,
    openTabs,
    pinTab,
    pinnedTabIds,
    reopenClosedTab,
    remapTabsForRename,
    reorderTabs,
    unpinTab,
    visibleTabIds,
  } = useDocumentContext();
  const { t } = useLingui();
  const { pageMeta } = usePageList();
  const tabListRef = useRef<HTMLDivElement>(null);
  const [tabReorderBounds, setTabReorderBounds] = useState<TabReorderBounds | null>(null);
  const [renamingTab, setRenamingTab] = useState<{ docName: string; tabId: string } | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [renameError, setRenameError] = useState<string | null>(null);
  const [isRenameLoading, setIsRenameLoading] = useState(false);
  const [showTabShortcutHints, setShowTabShortcutHints] = useState(false);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const commitInProgressRef = useRef(false);
  const cancelRequestedRef = useRef(false);
  const lastFailedValueRef = useRef<string | null>(null);
  const activeDocNameRef = useRef(activeDocName);
  const tabShortcutHintTimerRef = useRef<number | null>(null);
  const isTabShortcutModifierHeldRef = useRef(false);
  const showTabShortcutHintsRef = useRef(false);
  const activeTabId =
    activeContextTabId ??
    (activeTarget
      ? tabIdForNavigationTarget(activeTarget)
      : activeDocName
        ? docTabId(activeDocName)
        : null);
  const activeTabScrollKey = isNewTabActive
    ? `${activeNewTabId ?? '__new-tab__'}\u0000${openTabs.join('\u0000')}\u0000${newTabIds.join('\u0000')}`
    : activeTabId
      ? `${activeTabId}\u0000${openTabs.join('\u0000')}`
      : '';

  useEffect(() => {
    activeDocNameRef.current = activeDocName;
  }, [activeDocName]);

  useEffect(() => {
    return () => {
      if (tabShortcutHintTimerRef.current === null) return;
      window.clearTimeout(tabShortcutHintTimerRef.current);
      tabShortcutHintTimerRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!activeTabScrollKey) return;
    const activeTab = tabListRef.current?.querySelector<HTMLElement>('[data-active-tab="true"]');
    activeTab?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [activeTabScrollKey]);

  useEffect(() => {
    if (!renamingTab) return;
    renameInputRef.current?.focus();
    renameInputRef.current?.select();
  }, [renamingTab]);

  useEffect(() => {
    if (!renamingTab || openTabs.includes(renamingTab.tabId)) return;
    cancelRequestedRef.current = true;
    lastFailedValueRef.current = null;
    setRenamingTab(null);
    setRenameValue('');
    setRenameError(null);
    setIsRenameLoading(false);
  }, [openTabs, renamingTab]);

  function enterRenameMode(tabId: string, docName: string) {
    const segments = docName.split('/');
    cancelRequestedRef.current = false;
    lastFailedValueRef.current = null;
    setRenamingTab({ docName, tabId });
    setRenameValue(segments[segments.length - 1]);
    setRenameError(null);
  }

  function cancelRename() {
    cancelRequestedRef.current = true;
    lastFailedValueRef.current = null;
    setRenamingTab(null);
    setRenameValue('');
    setRenameError(null);
    setIsRenameLoading(false);
  }

  async function commitRename() {
    if (cancelRequestedRef.current) {
      cancelRequestedRef.current = false;
      return;
    }
    if (commitInProgressRef.current) return;

    const docName = renamingTab?.docName;
    if (!docName) {
      cancelRename();
      return;
    }

    const docExt = pageMeta.get(docName)?.docExt ?? '.md';
    const normalized = normalizeRenameValue(
      'file',
      stripRenameExtensionSuffix(renameValue, docExt),
    );
    const segments = docName.split('/');
    const currentName = segments[segments.length - 1];

    if (normalized === currentName) {
      cancelRename();
      return;
    }
    if (normalized === lastFailedValueRef.current) {
      renameInputRef.current?.focus();
      return;
    }

    if (!isValidNodeName(normalized)) {
      setRenameError(t`Name can’t be empty, ".", "..", or contain / or \\`);
      renameInputRef.current?.focus();
      return;
    }

    const newDocName = buildRenamedNodePath(
      { kind: 'file', path: docName, name: currentName },
      normalized,
    );

    commitInProgressRef.current = true;
    setIsRenameLoading(true);
    setRenameError(null);

    try {
      const res = await fetch('/api/rename-path', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'file', fromPath: docName, toPath: newDocName }),
      });

      if (cancelRequestedRef.current) {
        setIsRenameLoading(false);
        commitInProgressRef.current = false;
        return;
      }

      const parsed = await parseServerResponse(res, `Server error (HTTP ${res.status})`);

      if (!parsed.ok) {
        setRenameError(parsed.title);
        setIsRenameLoading(false);
        commitInProgressRef.current = false;
        lastFailedValueRef.current = normalized;
        renameInputRef.current?.focus();
        return;
      }

      const success = parseSuccessOrWarn(RenamePathSuccessSchema, parsed.body, 'rename-path:tab', {
        renamed: [],
        renamedAssets: [],
      });
      const renamed = success.renamed;
      const currentActiveDocName = activeDocNameRef.current;
      const nextActiveDocName = remapActiveDocName(currentActiveDocName, renamed);

      // Split try/catch: server-side rename already committed
      // (`parsed.ok === true`). A failure inside the post-commit work
      // (IDB clear via closeAndClearForRename, tab remap, event dispatch)
      // is a client-side reconciliation failure, NOT a network error.
      // Labeling it "Network error — please try again" would misdirect
      // the user toward a retry that POSTs against a now-nonexistent
      // source path and fails differently. The correct recovery is to
      // refresh and resync with disk truth.
      captureRenameSnapshots(renamed);
      let reconcileOk = true;
      try {
        // Same gate as FileTree.applyRenamedDocuments — rationale documented
        // at `planRenameCleanupCalls` in file-tree-operations.ts.
        const cleanupDocNames = planRenameCleanupCalls(renamed, getPoolActiveDocName(), poolHas);
        await Promise.all(cleanupDocNames.map((name) => closeAndClearForRename(name)));
        remapTabsForRename(renamed);
        emitDocumentsChanged(['files', 'backlinks', 'graph']);
      } catch (reconcileErr) {
        reconcileOk = false;
        console.warn('[EditorTabs] post-rename reconciliation failed', {
          err: reconcileErr,
          docName,
          newDocName,
          normalized,
        });
        toast.error(t`Rename succeeded but the tabstrip may be out of date — refresh to resync`);
      }

      cancelRequestedRef.current = true;
      setRenamingTab(null);
      setRenameValue('');
      setRenameError(null);
      setIsRenameLoading(false);
      commitInProgressRef.current = false;
      lastFailedValueRef.current = null;

      // Skip navigation when reconciliation failed: remapTabsForRename never
      // ran, so no tab is keyed to nextActiveDocName. Calling navigateToDoc
      // would silently open a new tab and contradict the "refresh to resync"
      // toast. Refresh recovers consistent state.
      if (reconcileOk && nextActiveDocName && nextActiveDocName !== currentActiveDocName) {
        navigateToDoc(nextActiveDocName);
      }
    } catch (err) {
      console.warn('[EditorTabs] rename failed', { err, docName, newDocName, normalized });
      setRenameError(t`Network error — please try again`);
      setIsRenameLoading(false);
      commitInProgressRef.current = false;
      lastFailedValueRef.current = normalized;
      renameInputRef.current?.focus();
    }
  }

  // Electron-host gate. Two regions, split by geometry:
  //
  //   • The strip ROOT stays a window-drag region (`-webkit-app-region: drag`).
  //     The strip is h-12 (48px) and `items-end`, so the empty 8px band ABOVE
  //     the h-10 (40px) tabs — plus all trailing space after the last tab when
  //     the strip isn't full — is the root showing through, and stays draggable.
  //   • An inner wrapper that hugs the tabs + add-button (content width, 40px
  //     tall, bottom-aligned) declares `no-drag`. That covers the tabs AND the
  //     4px gaps between them, so they stay interactive.
  //
  // Why the split: macOS hijacks pointer/wheel events in drag regions at the OS
  // chrome level (the DOM never sees them; see the `[data-electron-drag]`
  // neutralization rule in globals.css). A draggable inter-tab gap therefore
  // killed wheel-scroll whenever the cursor sat between two tabs. Scoping
  // `no-drag` to the content-hugging wrapper keeps wheel-scroll alive over the
  // tabs and gaps while preserving the drag affordance on the genuinely-empty
  // top band and trailing space. Web mode (no `window.okDesktop`) is unchanged.
  const isElectronHost = typeof window !== 'undefined' && window.okDesktop != null;
  const newTabIdSet = new Set(newTabIds);
  const tabReorderModifiers = [createTabReorderModifier(tabReorderBounds)];

  function closeVisibleTabs(tabIds: readonly string[]) {
    const documentTabIds: string[] = [];
    const emptyTabIds: string[] = [];

    for (const tabId of tabIds) {
      if (newTabIdSet.has(tabId)) {
        emptyTabIds.push(tabId);
      } else {
        documentTabIds.push(tabId);
      }
    }

    if (documentTabIds.length > 0) closeTabs(documentTabIds);
    for (const tabId of emptyTabIds) closeNewTab(tabId);
  }

  useEffect(() => {
    const currentNewTabIds = new Set(newTabIds);

    function clearTabShortcutHintTimer() {
      if (tabShortcutHintTimerRef.current === null) return;
      window.clearTimeout(tabShortcutHintTimerRef.current);
      tabShortcutHintTimerRef.current = null;
    }

    function setTabShortcutModifierHeld(nextValue: boolean) {
      if (isTabShortcutModifierHeldRef.current === nextValue) return;
      isTabShortcutModifierHeldRef.current = nextValue;
    }

    function setTabShortcutHintsVisible(nextValue: boolean) {
      if (showTabShortcutHintsRef.current === nextValue) return;
      showTabShortcutHintsRef.current = nextValue;
      setShowTabShortcutHints(nextValue);
    }

    function scheduleTabShortcutHintReveal() {
      setTabShortcutModifierHeld(true);
      if (showTabShortcutHintsRef.current || tabShortcutHintTimerRef.current !== null) return;
      tabShortcutHintTimerRef.current = window.setTimeout(() => {
        tabShortcutHintTimerRef.current = null;
        if (!isTabShortcutModifierHeldRef.current) return;
        setTabShortcutHintsVisible(true);
      }, TAB_SHORTCUT_HINT_DELAY_MS);
    }

    function clearShortcutHints() {
      clearTabShortcutHintTimer();
      setTabShortcutModifierHeld(false);
      setTabShortcutHintsVisible(false);
    }

    function activateVisibleTab(tabId: string) {
      if (currentNewTabIds.has(tabId)) {
        activateNewTab(tabId);
      } else {
        activateTab(tabId);
      }
    }

    function activateTabByOffset(offset: number) {
      if (visibleTabIds.length === 0) return;
      const activeVisibleTabId = isNewTabActive ? activeNewTabId : activeTabId;
      const activeIndex = activeVisibleTabId ? visibleTabIds.indexOf(activeVisibleTabId) : -1;
      const baseIndex = activeIndex >= 0 ? activeIndex : 0;
      const nextIndex = (baseIndex + offset + visibleTabIds.length) % visibleTabIds.length;
      activateVisibleTab(visibleTabIds[nextIndex]);
    }

    function onKeyDown(event: globalThis.KeyboardEvent) {
      if (hasTabShortcutModifier(event)) scheduleTabShortcutHintReveal();

      if (matchesKeyboardShortcut(event, 'tab-new')) {
        event.preventDefault();
        openNewTab();
        return;
      }
      if (matchesKeyboardShortcut(event, 'tab-reopen-closed')) {
        event.preventDefault();
        reopenClosedTab();
        return;
      }
      if (matchesKeyboardShortcut(event, 'tab-next')) {
        event.preventDefault();
        activateTabByOffset(1);
        return;
      }
      if (matchesKeyboardShortcut(event, 'tab-previous')) {
        event.preventDefault();
        activateTabByOffset(-1);
        return;
      }

      const jumpIndex = jumpTabIndexFromShortcut(event, visibleTabIds.length);
      if (jumpIndex === null) return;
      event.preventDefault();
      activateVisibleTab(visibleTabIds[jumpIndex]);
    }

    function onKeyUp(event: globalThis.KeyboardEvent) {
      if (!event.metaKey && !event.ctrlKey) clearShortcutHints();
    }

    window.addEventListener('keydown', onKeyDown, { capture: true });
    window.addEventListener('keyup', onKeyUp, { capture: true });
    window.addEventListener('blur', clearShortcutHints);
    document.addEventListener('visibilitychange', clearShortcutHints);
    return () => {
      window.removeEventListener('keydown', onKeyDown, { capture: true });
      window.removeEventListener('keyup', onKeyUp, { capture: true });
      window.removeEventListener('blur', clearShortcutHints);
      document.removeEventListener('visibilitychange', clearShortcutHints);
    };
  }, [
    activeNewTabId,
    activeTabId,
    activateNewTab,
    activateTab,
    isNewTabActive,
    newTabIds,
    openNewTab,
    reopenClosedTab,
    visibleTabIds,
  ]);

  // Tab drag-reorder. PointerSensor `distance: 8` keeps plain clicks from
  // initiating a drag (tabs differ from the PropertyPanel drag-handle pattern,
  // where the handle is a dedicated child — here the entire tab is the drag
  // source, so the activation threshold has to be looser than the panel's 4px).
  // KeyboardSensor + sortableKeyboardCoordinates makes keyboard reorder work.
  // Space starts drag so Enter can stay available for one-stop tab activation
  // on the outer sortable tab while inner activation buttons remain tabIndex=-1.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
      keyboardCodes: TAB_KEYBOARD_DRAG_CODES,
    }),
  );
  const forceTabCloseVisible = showTabShortcutHints;

  function handleDragStart() {
    setTabReorderBounds(measureTabReorderBounds(tabListRef.current, '[data-editor-tab-sortable]'));
  }

  function clearTabReorderBounds() {
    setTabReorderBounds(null);
  }

  function handleDragEnd(event: DragEndEvent) {
    clearTabReorderBounds();
    const activeId = String(event.active.id);
    const overId = event.over ? String(event.over.id) : null;
    if (!overId || activeId === overId) return;
    const fromIndex = visibleTabIds.indexOf(activeId);
    const toIndex = visibleTabIds.indexOf(overId);
    if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return;
    reorderTabs(arrayMove([...visibleTabIds], fromIndex, toIndex), activeId);
  }

  return (
    <div
      ref={tabListRef}
      data-electron-drag={isElectronHost ? '' : undefined}
      className={cn(
        'pl-2 flex h-12 min-w-0 touch-manipulation flex-1 items-end overflow-x-auto overflow-y-hidden overscroll-x-contain scroll-fade-mask-x [scrollbar-width:none]',
        isElectronHost && '[-webkit-app-region:drag]',
      )}
      onWheel={scrollTabListOnWheel}
    >
      <div
        className={cn(
          // Content-hugging, bottom-aligned no-drag wrapper. Hugs the tabs +
          // add-button (no flex-1) so the root's empty space stays draggable;
          // `no-drag` here keeps the tabs and inter-tab gaps wheel-scrollable.
          'flex items-end gap-1',
          isElectronHost && '[-webkit-app-region:no-drag]',
        )}
      >
        <DndContext
          sensors={sensors}
          autoScroll={TAB_REORDER_AUTO_SCROLL}
          collisionDetection={tabRunCollisionDetection}
          modifiers={tabReorderModifiers}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
          onDragCancel={clearTabReorderBounds}
          accessibility={{
            // Portal @dnd-kit's `DndDescribedBy` + `DndLiveRegion` SR helpers
            // out of the strip's flex container — without this they land as
            // siblings of the SortableTab list and the `+` button, occupying
            // the `:first-child` slot in the parent flex flow. That breaks
            // the `+` Button's `first:mb-3 mb-1.5` Tailwind variant when the
            // tabs list is empty, leaving the `+` button 6px below where it
            // should sit (cy=37 instead of cy=32). SSR/test-safe: only pass
            // `document.body` when `document` exists in the runtime.
            container: typeof document !== 'undefined' ? document.body : undefined,
          }}
        >
          <SortableContext items={[...visibleTabIds]} strategy={horizontalListSortingStrategy}>
            {visibleTabIds.map((tabId, tabIndex) => {
              const shortcutHint = showTabShortcutHints
                ? tabShortcutHintForIndex(tabIndex, visibleTabIds.length)
                : null;
              const ariaKeyShortcuts = tabAriaKeyShortcutsForIndex(tabIndex, visibleTabIds.length);
              if (newTabIdSet.has(tabId)) {
                const isActive = tabId === activeNewTabId;
                return (
                  <EditorTabContextMenu
                    key={tabId}
                    tabId={tabId}
                    canPin={false}
                    openTabs={visibleTabIds}
                    closeTab={closeNewTab}
                    closeTabs={closeVisibleTabs}
                    pinTab={pinTab}
                    pinnedTabIds={pinnedTabIds}
                    unpinTab={unpinTab}
                  >
                    <SortableTab
                      tabId={tabId}
                      activateFromKeyboard={() => activateNewTab(tabId)}
                      aria-current={isActive ? 'page' : undefined}
                      aria-keyshortcuts={ariaKeyShortcuts}
                      data-active-tab={isActive ? 'true' : undefined}
                      className={cn(
                        TAB_BASE_CLASS,
                        isActive ? TAB_ACTIVE_CLASS : TAB_INACTIVE_CLASS,
                      )}
                      onAuxClick={(event) => {
                        if (event.button !== 1) return;
                        event.preventDefault();
                        closeNewTab(tabId);
                      }}
                      onClick={(event) => {
                        if (event.target !== event.currentTarget) return;
                        activateNewTab(tabId);
                      }}
                    >
                      <button
                        type="button"
                        aria-label={t`Activate new tab`}
                        data-testid="editor-new-tab-placeholder-button"
                        className={TAB_BUTTON_CLASS}
                        onClick={() => activateNewTab(tabId)}
                        tabIndex={-1}
                      >
                        <span className="min-w-0 truncate">
                          <Trans>New tab</Trans>
                        </span>
                      </button>
                      {shortcutHint ? (
                        <TabShortcutHint value={shortcutHint} />
                      ) : (
                        <button
                          type="button"
                          aria-label={t`Close new tab`}
                          data-testid="editor-new-tab-placeholder-close"
                          className={getTabCloseButtonClass(forceTabCloseVisible || isActive)}
                          tabIndex={getTabCloseButtonTabIndex(isActive)}
                          onClick={(event) => {
                            event.stopPropagation();
                            closeNewTab(tabId);
                          }}
                        >
                          <XIcon aria-hidden="true" className="size-3.5" />
                        </button>
                      )}
                    </SortableTab>
                  </EditorTabContextMenu>
                );
              }

              const tab = parseEditorTabId(tabId);
              const isActive = tabId === activeTabId;
              const isPinned = pinnedTabIds.includes(tabId);
              if (tab.kind === 'folder') {
                const { baseName, label, prefix } = tabParts(tab.folderPath, '/');
                const accessibleLabel = `${prefix}${label}`;
                return (
                  <EditorTabContextMenu
                    key={tabId}
                    tabId={tabId}
                    openTabs={visibleTabIds}
                    closeTab={closeTab}
                    closeTabs={closeVisibleTabs}
                    pinTab={pinTab}
                    pinnedTabIds={pinnedTabIds}
                    unpinTab={unpinTab}
                  >
                    <SortableTab
                      tabId={tabId}
                      activateFromKeyboard={() => activateTab(tabId)}
                      aria-current={isActive ? 'page' : undefined}
                      aria-keyshortcuts={ariaKeyShortcuts}
                      data-active-tab={isActive ? 'true' : undefined}
                      className={cn(
                        TAB_BASE_CLASS,
                        isActive ? TAB_ACTIVE_CLASS : TAB_INACTIVE_CLASS,
                      )}
                      onAuxClick={(event) => {
                        if (event.button !== 1) return;
                        event.preventDefault();
                        if (isPinned) return;
                        closeTab(tabId);
                      }}
                      onClick={(event) => {
                        if (event.target !== event.currentTarget) return;
                        activateTab(tabId);
                      }}
                    >
                      <button
                        type="button"
                        aria-label={accessibleLabel}
                        title={accessibleLabel}
                        className={TAB_BUTTON_CLASS}
                        onClick={() => {
                          activateTab(tabId);
                        }}
                        tabIndex={-1}
                      >
                        {prefix && (
                          <span
                            className={cn(
                              'min-w-0 flex-1 truncate',
                              isActive && 'text-muted-foreground',
                            )}
                          >
                            {prefix}
                          </span>
                        )}
                        <span
                          className={cn(
                            'flex min-w-0 items-center',
                            prefix ? 'max-w-[70%] shrink-0' : 'flex-1',
                          )}
                        >
                          <span className="min-w-0 truncate">{baseName}</span>
                          <span className="shrink-0">/</span>
                        </span>
                      </button>
                      <TabPinOrCloseButton
                        accessibleLabel={accessibleLabel}
                        closeTab={closeTab}
                        forceCloseVisible={forceTabCloseVisible}
                        isActive={isActive}
                        isPinned={isPinned}
                        shortcutHint={shortcutHint}
                        tabId={tabId}
                        unpinTab={unpinTab}
                      />
                    </SortableTab>
                  </EditorTabContextMenu>
                );
              }

              if (tab.kind === 'asset' || tab.kind === 'skill-file') {
                // Skill bundle files share the asset tab's read-only chrome.
                // Label off the skill-relative path (`references/x.md`) for the
                // skill-file case, the asset path otherwise.
                const labelPath = tab.kind === 'asset' ? tab.assetPath : tab.path;
                const { baseName, label, prefix } = tabParts(labelPath, '');
                const accessibleLabel = `${prefix}${label}`;
                return (
                  <EditorTabContextMenu
                    key={tabId}
                    tabId={tabId}
                    openTabs={visibleTabIds}
                    closeTab={closeTab}
                    closeTabs={closeVisibleTabs}
                    pinTab={pinTab}
                    pinnedTabIds={pinnedTabIds}
                    unpinTab={unpinTab}
                  >
                    <SortableTab
                      tabId={tabId}
                      activateFromKeyboard={() => activateTab(tabId)}
                      aria-current={isActive ? 'page' : undefined}
                      aria-keyshortcuts={ariaKeyShortcuts}
                      data-active-tab={isActive ? 'true' : undefined}
                      className={cn(
                        TAB_BASE_CLASS,
                        isActive ? TAB_ACTIVE_CLASS : TAB_INACTIVE_CLASS,
                      )}
                      onAuxClick={(event) => {
                        if (event.button !== 1) return;
                        event.preventDefault();
                        if (isPinned) return;
                        closeTab(tabId);
                      }}
                      onClick={(event) => {
                        if (event.target !== event.currentTarget) return;
                        activateTab(tabId);
                      }}
                    >
                      <button
                        type="button"
                        aria-label={accessibleLabel}
                        className={TAB_BUTTON_CLASS}
                        onClick={() => {
                          activateTab(tabId);
                        }}
                        tabIndex={-1}
                      >
                        {prefix ? (
                          <span
                            className={cn(
                              'min-w-0 flex-1 truncate text-muted-foreground/60',
                              isActive && 'text-muted-foreground',
                            )}
                          >
                            {prefix}
                          </span>
                        ) : null}
                        <span
                          className={cn(
                            'min-w-0 truncate',
                            prefix ? 'max-w-[70%] shrink-0' : 'flex-1',
                          )}
                        >
                          {baseName}
                        </span>
                      </button>
                      <TabPinOrCloseButton
                        accessibleLabel={accessibleLabel}
                        closeTab={closeTab}
                        forceCloseVisible={forceTabCloseVisible}
                        isActive={isActive}
                        isPinned={isPinned}
                        shortcutHint={shortcutHint}
                        tabId={tabId}
                        unpinTab={unpinTab}
                      />
                    </SortableTab>
                  </EditorTabContextMenu>
                );
              }

              const docName = tab.docName;
              const docExt = pageMeta.get(docName)?.docExt ?? '.md';
              const { baseName, extension, label, prefix } = tabParts(docName, docExt);
              const accessibleLabel = `${prefix}${label}`;
              const hideDocExtension = docExt === '.md' || docExt === '.mdx';
              const isRenaming = renamingTab?.tabId === tabId;
              const renameErrorId = `editor-tab-rename-error-${tabDomIdPart(docName)}`;
              return (
                <EditorTabContextMenu
                  key={tabId}
                  disabled={isRenaming}
                  tabId={tabId}
                  openTabs={visibleTabIds}
                  closeTab={closeTab}
                  closeTabs={closeVisibleTabs}
                  pinTab={pinTab}
                  pinnedTabIds={pinnedTabIds}
                  unpinTab={unpinTab}
                >
                  <SortableTab
                    tabId={tabId}
                    activateFromKeyboard={() => activateTab(tabId)}
                    disabled={isRenaming}
                    aria-current={isActive ? 'page' : undefined}
                    aria-keyshortcuts={ariaKeyShortcuts}
                    data-active-tab={isActive ? 'true' : undefined}
                    className={cn(
                      TAB_BASE_CLASS,
                      isActive ? TAB_ACTIVE_CLASS : TAB_INACTIVE_CLASS,
                      isRenaming && renameError && 'border-destructive',
                    )}
                    onAuxClick={(event) => {
                      if (event.button !== 1) return;
                      event.preventDefault();
                      if (isPinned) return;
                      closeTab(tabId);
                    }}
                    onClick={(event) => {
                      if (event.target !== event.currentTarget) return;
                      activateTab(tabId);
                    }}
                  >
                    {isRenaming ? (
                      <>
                        <InputGroup className="h-full min-w-0 flex-1 rounded-none border-0 bg-transparent dark:bg-transparent">
                          <InputGroupInput
                            ref={renameInputRef}
                            value={renameValue}
                            disabled={isRenameLoading}
                            aria-label={t`Rename ${label}`}
                            data-testid="editor-tab-rename-input"
                            aria-invalid={renameError ? true : undefined}
                            aria-describedby={renameError ? renameErrorId : undefined}
                            aria-busy={isRenameLoading || undefined}
                            title={renameError ?? docName}
                            className="h-full min-w-0 px-2 py-0 font-medium text-foreground text-xs selection:bg-primary selection:text-primary-foreground"
                            onChange={(event) => {
                              setRenameValue(
                                stripRenameExtensionSuffix(event.target.value, docExt),
                              );
                              setRenameError(null);
                              lastFailedValueRef.current = null;
                            }}
                            onKeyDown={(event) => {
                              if (event.key === 'Enter') {
                                event.preventDefault();
                                void commitRename();
                              } else if (event.key === 'Escape') {
                                event.preventDefault();
                                cancelRename();
                              }
                            }}
                            onBlur={commitRename}
                          />
                          <InputGroupAddon
                            align="inline-end"
                            aria-hidden="true"
                            className="pr-2 text-xs"
                          >
                            <InputGroupText className="text-muted-foreground/60 text-xs">
                              {docExt}
                            </InputGroupText>
                          </InputGroupAddon>
                        </InputGroup>
                        {renameError ? (
                          <span id={renameErrorId} role="alert" className="sr-only">
                            {renameError}
                          </span>
                        ) : null}
                      </>
                    ) : (
                      <>
                        <DocumentTabButton
                          accessibleLabel={accessibleLabel}
                          activateTab={activateTab}
                          baseName={baseName}
                          docName={docName}
                          enterRenameMode={enterRenameMode}
                          extension={extension}
                          hideDocExtension={hideDocExtension}
                          tabId={tabId}
                        />
                        <TabPinOrCloseButton
                          accessibleLabel={accessibleLabel}
                          closeTab={closeTab}
                          forceCloseVisible={forceTabCloseVisible}
                          isActive={isActive}
                          isPinned={isPinned}
                          shortcutHint={shortcutHint}
                          tabId={tabId}
                          unpinTab={unpinTab}
                        />
                      </>
                    )}
                  </SortableTab>
                </EditorTabContextMenu>
              );
            })}
          </SortableContext>
        </DndContext>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              aria-label={t`New tab`}
              data-testid="editor-new-tab-button"
              className="first:mb-3 mb-1.5"
              onClick={openNewTab}
            >
              <PlusIcon aria-hidden="true" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            <Trans>New tab</Trans>
          </TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}

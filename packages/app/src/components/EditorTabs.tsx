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
  isActive,
  isPinned,
  tabId,
  unpinTab,
}: {
  accessibleLabel: string;
  closeTab: (tabId: string) => void;
  isActive: boolean;
  isPinned: boolean;
  tabId: string;
  unpinTab: (tabId: string) => void;
}) {
  const { t } = useLingui();
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
      className={getTabCloseButtonClass(isActive)}
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

function TabConflictBadge({ docName }: { docName: string }) {
  const status = useLifecycleStatus(docName);
  if (status !== 'conflict') return null;
  return (
    <AlertTriangle
      aria-label="Conflict"
      data-testid="editor-tab-conflict-badge"
      className="mr-1 size-3.5 shrink-0 text-amber-500"
    />
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
  const renameInputRef = useRef<HTMLInputElement>(null);
  const commitInProgressRef = useRef(false);
  const cancelRequestedRef = useRef(false);
  const lastFailedValueRef = useRef<string | null>(null);
  const activeDocNameRef = useRef(activeDocName);
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

      captureRenameSnapshots(renamed);
      let reconcileOk = true;
      try {
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

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
      keyboardCodes: TAB_KEYBOARD_DRAG_CODES,
    }),
  );

  function handleDragStart() {
    setTabReorderBounds(measureTabReorderBounds(tabListRef.current));
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
      <div className={cn('flex items-end gap-1', isElectronHost && '[-webkit-app-region:no-drag]')}>
        <DndContext
          sensors={sensors}
          autoScroll={TAB_REORDER_AUTO_SCROLL}
          collisionDetection={tabRunCollisionDetection}
          modifiers={tabReorderModifiers}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
          onDragCancel={clearTabReorderBounds}
          accessibility={{
            container: typeof document !== 'undefined' ? document.body : undefined,
          }}
        >
          <SortableContext items={[...visibleTabIds]} strategy={horizontalListSortingStrategy}>
            {visibleTabIds.map((tabId) => {
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
                      <button
                        type="button"
                        aria-label={t`Close new tab`}
                        data-testid="editor-new-tab-placeholder-close"
                        className={getTabCloseButtonClass(isActive)}
                        tabIndex={getTabCloseButtonTabIndex(isActive)}
                        onClick={(event) => {
                          event.stopPropagation();
                          closeNewTab(tabId);
                        }}
                      >
                        <XIcon aria-hidden="true" className="size-3.5" />
                      </button>
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
                        isActive={isActive}
                        isPinned={isPinned}
                        tabId={tabId}
                        unpinTab={unpinTab}
                      />
                    </SortableTab>
                  </EditorTabContextMenu>
                );
              }

              if (tab.kind === 'asset' || tab.kind === 'skill-file') {
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
                        isActive={isActive}
                        isPinned={isPinned}
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
                        <button
                          type="button"
                          aria-label={accessibleLabel}
                          title={accessibleLabel}
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
                          <TabConflictBadge docName={docName} />
                          <span className="flex min-w-0 flex-1 items-center">
                            <span className="min-w-0 truncate">{baseName}</span>
                            {!hideDocExtension && <span className="shrink-0">{extension}</span>}
                          </span>
                        </button>
                        <TabPinOrCloseButton
                          accessibleLabel={accessibleLabel}
                          closeTab={closeTab}
                          isActive={isActive}
                          isPinned={isPinned}
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

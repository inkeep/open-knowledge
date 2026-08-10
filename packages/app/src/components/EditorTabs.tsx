// biome-ignore-all lint/plugin/no-raw-html-interactive-element: pre-rule backlog — file uses raw <button>/<input>/<textarea> awaiting shadcn migration; tracked at https://github.com/inkeep/open-knowledge/blob/main/biome-plugins/README.md#no-raw-html-interactive-elementgrit

// biome-ignore-all lint/plugin/no-physical-direction-utility: pre-rule backlog — physical margin/padding/inset utilities predate the rule; drain by swapping ml/mr → ms/me, pl/pr → ps/pe, left/right → start/end, then deleting this line. See https://github.com/inkeep/open-knowledge/blob/main/biome-plugins/README.md#no-physical-direction-utilitygrit

import { useDndContext } from '@dnd-kit/core';
import { horizontalListSortingStrategy, SortableContext, useSortable } from '@dnd-kit/sortable';
import { Trans, useLingui } from '@lingui/react/macro';
import {
  AlertTriangle,
  CopyX,
  PanelLeft,
  PanelRight,
  PinIcon,
  PlusIcon,
  Trash2,
  XIcon,
} from 'lucide-react';
import {
  type HTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import {
  type EditorTabFileTarget,
  EditorTabTargetMenuItems,
} from '@/components/EditorTabTargetMenuItems';
import { FileTargetRenameDialog } from '@/components/FileTargetRenameDialog';
import {
  SkillContextMenuItems,
  SkillFileContextMenuItems,
  useSkillActions,
} from '@/components/skill-actions';
import { Button } from '@/components/ui/button';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { Kbd } from '@/components/ui/kbd';
import { isBlobRunnerNewTabId, useDocumentContext } from '@/editor/DocumentContext';
import {
  filterClosableTabIds,
  isSkillBundleShapedPath,
  isSkillDocName,
  parseEditorTabId,
  tabIdForNavigationTarget,
  tabParts,
} from '@/editor/editor-tabs';
import { useLifecycleStatus } from '@/hooks/use-lifecycle-status';
import { skillFileForDocName } from '@/hooks/use-reconcile-skill-tabs';
import { useSkills } from '@/hooks/use-skills';
import { emitFileTreeMenuActionRename } from '@/lib/file-tree-menu-action-events';
import { matchesKeyboardShortcut } from '@/lib/keyboard-shortcuts';
import { skillEntryLiveDocName } from '@/lib/managed-artifact-doc-name';
import { isOverlayLayerOpen } from '@/lib/overlay-layers';
import { cn } from '@/lib/utils';
import {
  type EditorTabDragData,
  findEditorTabElement,
  getSortableTabClassName,
  getSortableTabKeyDownAction,
  getSortableTabStyle,
  getTabCloseButtonClass,
  getTabCloseButtonTabIndex,
  shouldOpenTabContextMenu,
} from './editor-tabs-chrome';
import { usePageList } from './PageListContext';
import { scrollTabStripOnWheel } from './tab-strip-wheel';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';

const TAB_BASE_CLASS =
  'group @container/tab relative -mb-px flex h-10 min-w-32 max-w-48 grow-0 basis-36 shrink cursor-grab items-center overflow-hidden border border-transparent font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset active:cursor-grabbing';
const TAB_ACTIVE_CLASS =
  'z-10 rounded-t-lg rounded-b-none border-border border-b-0 bg-background text-foreground';
const TAB_INACTIVE_CLASS =
  'rounded-t-md text-muted-foreground hover:border-border/70 hover:bg-muted/60 hover:text-foreground focus-visible:border-border focus-visible:bg-muted focus-visible:text-foreground';
const TAB_BUTTON_CLASS =
  'flex h-full min-w-0 flex-1 cursor-pointer items-center overflow-hidden pl-3 pr-1.5 text-left text-[13px] outline-none @max-[5rem]/tab:pl-2';

function tabTitleClassName(isFocusedActive: boolean, isPreview: boolean): string {
  return cn(TAB_BUTTON_CLASS, isFocusedActive && 'font-semibold', isPreview && 'italic');
}

function tabTitleOverflowClassName(isActive: boolean): string {
  return isActive
    ? 'overflow-hidden whitespace-nowrap mask-r-from-[calc(100%-1.5rem)] mask-r-to-[100%]'
    : 'truncate group-hover:text-clip group-hover:mask-r-from-[calc(100%-3rem)] group-hover:mask-r-to-[calc(100%-1.5rem)]';
}

function syncTabOverflowIndicators(scrollContainer: HTMLElement): void {
  const overflowRoot = scrollContainer.closest<HTMLElement>('[data-editor-tab-overflow-root]');
  if (!overflowRoot) return;
  const maxScrollLeft = Math.max(0, scrollContainer.scrollWidth - scrollContainer.clientWidth);
  overflowRoot.toggleAttribute('data-overflow-left', scrollContainer.scrollLeft > 1);
  overflowRoot.toggleAttribute(
    'data-overflow-right',
    scrollContainer.scrollLeft < maxScrollLeft - 1,
  );
}

function hasTabShortcutModifier(event: globalThis.KeyboardEvent): boolean {
  return event.metaKey || event.ctrlKey;
}

const TAB_SHORTCUT_HINT_DELAY_MS = 1000;
const EMPTY_SKILL_NAME_SET: ReadonlySet<string> = new Set();

function shortcutDigitForIndex(index: number, tabCount: number): string | null {
  if (index < 0 || index >= tabCount) return null;
  if (index < 8) return String(index + 1);
  return index === tabCount - 1 ? '9' : null;
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
      className="mr-1 flex h-5 w-fit shrink-0 items-center justify-center font-mono tabular-nums @max-[5rem]/tab:hidden"
    >
      <Kbd className="px-0.5 text-[10px]">{`⌘${value}`}</Kbd>
    </span>
  );
}

/**
 * Sortable wrapper for one tab div, bound to `@dnd-kit/sortable`'s
 * `useSortable` so the whole tab (not a separate drag handle) is draggable.
 * Activation is gated by the outer DndContext's PointerSensor `distance: 8`
 * so plain clicks still activate / close the tab.
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
  children,
  className,
  dropIndicatorSide,
  label,
  paneId,
  splittable,
  tabId,
  onKeyDown,
  ref: outerRef,
  style: outerStyle,
  ...rest
}: {
  activateFromKeyboard?: () => void;
  dropIndicatorSide?: 'before' | 'after';
  label: string;
  paneId: string;
  splittable: boolean;
  tabId: string;
  ref?: Ref<HTMLDivElement>;
} & HTMLAttributes<HTMLDivElement>) {
  const { attributes, listeners, rect, setNodeRef, transform, transition, isDragging } =
    useSortable({
      animateLayoutChanges: () => false,
      id: tabId,
      data: {
        kind: 'editor-tab',
        paneId,
        tabId,
        splittable,
        label,
      } satisfies EditorTabDragData,
      transition: null,
    });
  const style = getSortableTabStyle({
    activeWidth: rect.current?.width,
    disableMovement: true,
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
    if (!event.defaultPrevented && shouldOpenTabContextMenu(event)) {
      event.preventDefault();
      const rect = event.currentTarget.getBoundingClientRect();
      event.currentTarget.dispatchEvent(
        new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: rect.left + Math.min(rect.width / 2, 16),
          clientY: rect.top + rect.height / 2,
          view: window,
        }),
      );
      return;
    }
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
      data-editor-pane-id={paneId}
      data-editor-tab-id={tabId}
      className={getSortableTabClassName({ className, isDragging })}
      style={style}
      {...rest}
      {...attributes}
      {...listeners}
      onKeyDown={handleKeyDown}
    >
      {children}
      {dropIndicatorSide ? (
        <span
          aria-hidden="true"
          data-editor-tab-drop-indicator={dropIndicatorSide}
          className={cn(
            'pointer-events-none absolute inset-y-1 z-30 w-0.5 rounded-full bg-primary',
            dropIndicatorSide === 'before' ? 'left-0' : 'right-0',
          )}
        />
      ) : null}
    </div>
  );
}

function EditorTabContextMenu({
  canSplit = true,
  children,
  closeTab,
  closeTabs,
  canPin = true,
  docExt,
  isPreview = false,
  openTabs,
  pinTab,
  pinnedTabIds,
  promoteTab,
  splitTab,
  skillMenuItems,
  tabLabel,
  tabId,
  target,
  renameName,
  unpinTab,
}: {
  children: ReactNode;
  canPin?: boolean;
  canSplit?: boolean;
  docExt?: string;
  closeTab: (tabId: string) => void;
  closeTabs: (tabIds: readonly string[]) => void;
  isPreview?: boolean;
  openTabs: readonly string[];
  pinTab: (tabId: string) => void;
  pinnedTabIds: readonly string[];
  promoteTab: (tabId: string) => void;
  splitTab: (tabId: string, side: 'left' | 'right', label: string) => void;
  skillMenuItems?: ReactNode;
  tabLabel: string;
  tabId: string;
  target?: EditorTabFileTarget;
  renameName?: string;
  unpinTab: (tabId: string) => void;
}) {
  const [renameOpen, setRenameOpen] = useState(false);
  const isPinned = canPin && pinnedTabIds.includes(tabId);
  const otherTabIds = filterClosableTabIds(
    openTabs.filter((openTabId) => openTabId !== tabId),
    pinnedTabIds,
  );
  const closableTabIds = filterClosableTabIds(openTabs, pinnedTabIds);
  const canMoveToNewPane = canSplit && openTabs.length > 1;

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
        <ContextMenuContent className="min-w-56">
          <ContextMenuGroup>
            <ContextMenuItem disabled={isPinned} onSelect={() => closeTab(tabId)}>
              <XIcon aria-hidden="true" />
              <Trans>Close</Trans>
            </ContextMenuItem>
            <ContextMenuItem
              disabled={otherTabIds.length === 0}
              onSelect={() => {
                closeTabs(otherTabIds);
              }}
            >
              <CopyX aria-hidden="true" />
              <Trans>Close others</Trans>
            </ContextMenuItem>
            <ContextMenuItem
              disabled={closableTabIds.length === 0}
              data-testid="editor-tab-context-close-all"
              onSelect={() => {
                closeTabs(closableTabIds);
              }}
            >
              <Trash2 aria-hidden="true" />
              {pinnedTabIds.length ? <Trans>Close all unpinned</Trans> : <Trans>Close all</Trans>}
            </ContextMenuItem>
          </ContextMenuGroup>
          {target || skillMenuItems ? (
            <>
              <ContextMenuSeparator />
              {target ? (
                <EditorTabTargetMenuItems
                  docExt={docExt}
                  target={target}
                  onRename={() => setRenameOpen(true)}
                />
              ) : null}
              {skillMenuItems}
            </>
          ) : null}
          {isPreview && (
            <>
              <ContextMenuSeparator />
              <ContextMenuItem
                data-testid="editor-tab-context-keep-open"
                onSelect={() => promoteTab(tabId)}
              >
                <PinIcon aria-hidden="true" />
                <Trans>Keep open</Trans>
              </ContextMenuItem>
            </>
          )}
          {canPin && (
            <>
              <ContextMenuSeparator />
              <ContextMenuItem
                data-testid="editor-tab-context-pin-toggle"
                onSelect={() => (isPinned ? unpinTab(tabId) : pinTab(tabId))}
              >
                <PinIcon aria-hidden="true" />
                {isPinned ? <Trans>Unpin tab</Trans> : <Trans>Pin tab</Trans>}
              </ContextMenuItem>
            </>
          )}
          <ContextMenuSeparator />
          <ContextMenuGroup>
            <ContextMenuItem
              disabled={!canMoveToNewPane}
              data-testid="editor-tab-context-split-left"
              onSelect={() => splitTab(tabId, 'left', tabLabel)}
            >
              <PanelLeft aria-hidden="true" />
              <Trans>Move to new pane left</Trans>
            </ContextMenuItem>
            <ContextMenuItem
              disabled={!canMoveToNewPane}
              data-testid="editor-tab-context-split-right"
              onSelect={() => splitTab(tabId, 'right', tabLabel)}
            >
              <PanelRight aria-hidden="true" />
              <Trans>Move to new pane right</Trans>
            </ContextMenuItem>
          </ContextMenuGroup>
        </ContextMenuContent>
      </ContextMenu>
      {renameOpen && target && renameName ? (
        <FileTargetRenameDialog
          currentName={renameName}
          open
          onOpenChange={setRenameOpen}
          onSave={(nextName) => emitFileTreeMenuActionRename(target, nextName)}
        />
      ) : null}
    </>
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

/**
 * Full-path hover disclosure for labels that may be visually truncated.
 * Anchoring to the inner button avoids dnd-kit's sortable listeners replacing
 * the tooltip trigger's pointer handlers on the outer tab.
 */
function TabPathTooltip({ children, path }: { children: ReactNode; path: string }) {
  // A reorder drag keeps firing pointermove over the trigger, which re-opens
  // the tooltip mid-drag still anchored to the tab's original slot. Radix
  // closes on pointerdown but has no notion of an in-flight drag, so the
  // active-drag check has to come from dnd-kit.
  const { active } = useDndContext();
  if (active) return children;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={8} className="max-w-xs break-all">
        {path}
      </TooltipContent>
    </Tooltip>
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
  extension,
  hideDocExtension,
  isActive,
  isFocusedPane,
  isPreview,
  promoteTab,
  tabId,
}: {
  accessibleLabel: string;
  activateTab: (tabId: string) => void;
  baseName: string;
  docName: string;
  extension: string;
  hideDocExtension: boolean;
  isActive: boolean;
  isFocusedPane: boolean;
  isPreview: boolean;
  promoteTab: (tabId: string) => void;
  tabId: string;
}) {
  const { t } = useLingui();
  const lifecycleStatus = useLifecycleStatus(docName);
  const hasConflict = lifecycleStatus === 'conflict';
  const buttonAccessibleLabel = hasConflict ? t`${accessibleLabel} (conflict)` : accessibleLabel;

  return (
    <TabPathTooltip path={buttonAccessibleLabel}>
      <button
        type="button"
        aria-label={buttonAccessibleLabel}
        // The label is the user's own file path, so its direction comes from the
        // path rather than from the interface language (see `UserText`). Applied
        // to the button because the path is split across sibling spans for
        // truncation — one isolate around all of them keeps the fragments in the
        // order the name was written, instead of letting the chrome reorder them.
        dir="auto"
        className={tabTitleClassName(isActive && isFocusedPane, isPreview)}
        onClick={() => {
          activateTab(tabId);
        }}
        onDoubleClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          promoteTab(tabId);
        }}
        tabIndex={-1}
      >
        <TabConflictBadge hasConflict={hasConflict} />
        <span className="flex min-w-0 flex-1 items-center">
          <span
            data-editor-tab-title-overflow={isActive ? 'fade' : 'ellipsis'}
            className={cn('min-w-0 flex-1', tabTitleOverflowClassName(isActive))}
          >
            {baseName}
          </span>
          {!hideDocExtension && <span className="shrink-0">{extension}</span>}
        </span>
      </button>
    </TabPathTooltip>
  );
}

interface EditorTabFrameProps {
  accessibleLabel: string;
  activateTab: (tabId: string) => void;
  ariaKeyShortcuts?: string;
  children: ReactNode;
  closeTab: (tabId: string) => void;
  closeTabs: (tabIds: readonly string[]) => void;
  docExt?: string;
  dropIndicatorSide?: 'before' | 'after';
  forceCloseVisible: boolean;
  isActive: boolean;
  isPinned: boolean;
  isPreview: boolean;
  openTabs: readonly string[];
  paneId: string;
  pinTab: (tabId: string) => void;
  pinnedTabIds: readonly string[];
  promoteTab: (tabId: string) => void;
  renameName?: string;
  shortcutHint: string | null;
  splitTab: (tabId: string, side: 'left' | 'right', label: string) => void;
  skillMenuItems?: ReactNode;
  tabId: string;
  target?: EditorTabFileTarget;
  unpinTab: (tabId: string) => void;
}

function EditorTabFrame({
  accessibleLabel,
  activateTab,
  ariaKeyShortcuts,
  children,
  closeTab,
  closeTabs,
  docExt,
  dropIndicatorSide,
  forceCloseVisible,
  isActive,
  isPinned,
  isPreview,
  openTabs,
  paneId,
  pinTab,
  pinnedTabIds,
  promoteTab,
  renameName,
  shortcutHint,
  splitTab,
  skillMenuItems,
  tabId,
  target,
  unpinTab,
}: EditorTabFrameProps) {
  return (
    <EditorTabContextMenu
      tabId={tabId}
      docExt={docExt}
      target={target}
      renameName={renameName}
      openTabs={openTabs}
      closeTab={closeTab}
      closeTabs={closeTabs}
      isPreview={isPreview}
      pinTab={pinTab}
      pinnedTabIds={pinnedTabIds}
      promoteTab={promoteTab}
      splitTab={splitTab}
      skillMenuItems={skillMenuItems}
      tabLabel={accessibleLabel}
      unpinTab={unpinTab}
    >
      <SortableTab
        dropIndicatorSide={dropIndicatorSide}
        label={accessibleLabel}
        paneId={paneId}
        splittable
        tabId={tabId}
        activateFromKeyboard={() => activateTab(tabId)}
        aria-current={isActive ? 'page' : undefined}
        aria-keyshortcuts={ariaKeyShortcuts}
        data-active-tab={isActive ? 'true' : undefined}
        data-preview-tab={isPreview ? 'true' : undefined}
        className={cn(TAB_BASE_CLASS, isActive ? TAB_ACTIVE_CLASS : TAB_INACTIVE_CLASS)}
        onAuxClick={(event) => {
          if (event.button !== 1) return;
          event.preventDefault();
          if (!isPinned) closeTab(tabId);
        }}
        onClick={(event) => {
          if (event.target === event.currentTarget) activateTab(tabId);
        }}
      >
        {children}
        <TabPinOrCloseButton
          accessibleLabel={accessibleLabel}
          closeTab={closeTab}
          forceCloseVisible={forceCloseVisible}
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

interface EditorTabsProps {
  dropIndicatorIndex?: number | null;
  paneId: string;
  onSplitComplete?: (paneId: string, tabId: string) => void;
  reserveLeadingChrome?: boolean;
  reserveTrailingChrome?: boolean;
}

export function EditorTabs({
  dropIndicatorIndex = null,
  paneId,
  onSplitComplete,
  reserveLeadingChrome = false,
  reserveTrailingChrome = false,
}: EditorTabsProps) {
  const { t } = useLingui();
  const context = useDocumentContext();
  const { reopenClosedTab } = context;
  const pane = context.panes.find((candidate) => candidate.id === paneId) ?? context.panes[0];
  const resolvedPaneId = pane?.id ?? paneId;
  const openTabs = pane?.openTabs ?? [];
  const pinnedTabIds = pane?.pinnedTabIds ?? [];
  const previewTabId = pane?.previewTabId ?? null;
  const newTabIds = pane?.newTabIds ?? [];
  const visibleTabIds = context.visibleTabIdsByPane.get(resolvedPaneId) ?? [
    ...openTabs,
    ...newTabIds,
  ];
  const activeTarget = pane?.activeTarget ?? null;
  const activeContextTabId = pane?.activeTabId ?? null;
  const activeNewTabId = pane?.activeNewTabId ?? null;
  const isNewTabActive = activeNewTabId !== null;
  const isFocusedPane = context.focusedPaneId === resolvedPaneId;
  const hasSkillTab = visibleTabIds.some((tabId) => {
    const tab = parseEditorTabId(tabId);
    return tab.kind === 'skill-file' || (tab.kind === 'doc' && isSkillDocName(tab.docName));
  });
  const skillsState = useSkills({ enabled: hasSkillTab });
  const skillActions = useSkillActions();
  const editableSkills =
    skillsState.status === 'ready' ? skillsState.data.filter((skill) => !skill.managed) : [];
  const editableSkillsByTabId = new Map(
    editableSkills.map((skill) => [skillEntryLiveDocName(skill), skill] as const),
  );
  const skillNamesByScope = new Map(
    (['project', 'global'] as const).map((scope) => [
      scope,
      new Set(
        skillsState.status === 'ready'
          ? skillsState.data.filter((skill) => skill.scope === scope).map((skill) => skill.name)
          : [],
      ),
    ]),
  );
  const activateTab = (tabId: string) => context.activateTabInPane(resolvedPaneId, tabId);
  const activateNewTab = (tabId: string) => context.activateNewTabInPane(resolvedPaneId, tabId);
  const closeTab = (tabId: string) => context.closeTabInPane(resolvedPaneId, tabId);
  const closeTabs = (tabIds: readonly string[]) => context.closeTabsInPane(resolvedPaneId, tabIds);
  const closeNewTab = (tabId: string) => context.closeNewTabInPane(resolvedPaneId, tabId);
  const openNewTab = () => context.openNewTabInPane(resolvedPaneId);
  const pinTab = (tabId: string) => context.pinTabInPane(resolvedPaneId, tabId);
  const unpinTab = (tabId: string) => context.unpinTabInPane(resolvedPaneId, tabId);
  const promoteTab = (tabId: string) => context.promoteTabInPane(resolvedPaneId, tabId);
  const [splitAnnouncement, setSplitAnnouncement] = useState({ id: 0, text: '' });
  function splitTab(tabId: string, side: 'left' | 'right', label: string) {
    const nextPaneId = context.moveTabToNewPane(tabId, side);
    if (!nextPaneId) return;
    const text =
      side === 'left'
        ? t`Moved ${label} to a new pane on the left.`
        : t`Moved ${label} to a new pane on the right.`;
    setSplitAnnouncement((current) => ({ id: current.id + 1, text }));
    onSplitComplete?.(nextPaneId, tabId);
  }
  const { pageMeta } = usePageList();
  const [showTabShortcutHints, setShowTabShortcutHints] = useState(false);
  const tabScrollRef = useRef<HTMLDivElement>(null);
  const tabShortcutHintTimerRef = useRef<number | null>(null);
  const isTabShortcutModifierHeldRef = useRef(false);
  const showTabShortcutHintsRef = useRef(false);
  const activeTabId =
    activeContextTabId ?? (activeTarget ? tabIdForNavigationTarget(activeTarget) : null);

  function dropIndicatorSideForTab(tabIndex: number): 'before' | 'after' | undefined {
    if (dropIndicatorIndex === tabIndex) return 'before';
    if (dropIndicatorIndex === visibleTabIds.length && tabIndex === visibleTabIds.length - 1) {
      return 'after';
    }
    return undefined;
  }

  useEffect(() => {
    return () => {
      if (tabShortcutHintTimerRef.current === null) return;
      window.clearTimeout(tabShortcutHintTimerRef.current);
      tabShortcutHintTimerRef.current = null;
    };
  }, []);

  // Make the tab canvas draggable, then carve out the scroll viewport and New
  // tab button below. EditorHeader paints its foreground controls after this
  // canvas so their no-drag regions remain clickable.
  const isElectronHost = typeof window !== 'undefined' && window.okDesktop != null;
  const newTabIdSet = new Set(newTabIds);

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
    if (!isFocusedPane) return;
    const currentNewTabIds = new Set(newTabIds);
    const currentVisibleTabIds = [...openTabs, ...newTabIds];

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
        context.activateNewTabInPane(resolvedPaneId, tabId);
      } else {
        context.activateTabInPane(resolvedPaneId, tabId);
      }
    }

    function activateTabByOffset(offset: number) {
      if (currentVisibleTabIds.length === 0) return;
      const activeVisibleTabId = isNewTabActive ? activeNewTabId : activeTabId;
      const activeIndex = activeVisibleTabId
        ? currentVisibleTabIds.indexOf(activeVisibleTabId)
        : -1;
      const baseIndex = activeIndex >= 0 ? activeIndex : 0;
      const nextIndex =
        (baseIndex + offset + currentVisibleTabIds.length) % currentVisibleTabIds.length;
      activateVisibleTab(currentVisibleTabIds[nextIndex]);
    }

    function onKeyDown(event: globalThis.KeyboardEvent) {
      // Every branch below needs the modifier, so bail on it first — this runs on
      // every keystroke in the app, and the overlay probe queries the DOM.
      if (!hasTabShortcutModifier(event)) return;
      // Capture phase on `window` outruns anything an overlay installs, so an
      // open palette / dialog / menu cannot stop these chords from underneath.
      if (isOverlayLayerOpen()) return;
      scheduleTabShortcutHintReveal();

      if (matchesKeyboardShortcut(event, 'tab-new')) {
        event.preventDefault();
        context.openNewTabInPane(resolvedPaneId);
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

      const jumpIndex = jumpTabIndexFromShortcut(event, currentVisibleTabIds.length);
      if (jumpIndex === null) return;
      event.preventDefault();
      activateVisibleTab(currentVisibleTabIds[jumpIndex]);
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
    context.activateNewTabInPane,
    context.activateTabInPane,
    context.openNewTabInPane,
    isFocusedPane,
    isNewTabActive,
    newTabIds,
    openTabs,
    reopenClosedTab,
    resolvedPaneId,
  ]);
  const forceTabCloseVisible = showTabShortcutHints;
  const selectedTabId = isNewTabActive ? activeNewTabId : activeTabId;
  const previousSelectedTabIdRef = useRef(selectedTabId);

  useLayoutEffect(() => {
    const scrollContainer = tabScrollRef.current;
    if (!scrollContainer) return;
    syncTabOverflowIndicators(scrollContainer);
  });

  useLayoutEffect(() => {
    const scrollContainer = tabScrollRef.current;
    if (!scrollContainer || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => syncTabOverflowIndicators(scrollContainer));
    observer.observe(scrollContainer);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const previousSelectedTabId = previousSelectedTabIdRef.current;
    previousSelectedTabIdRef.current = selectedTabId;
    if (selectedTabId === null || selectedTabId === previousSelectedTabId) return;

    const scrollContainer = tabScrollRef.current;
    if (!scrollContainer) return;
    findEditorTabElement(scrollContainer, resolvedPaneId, selectedTabId)?.scrollIntoView({
      block: 'nearest',
      inline: 'nearest',
    });
  }, [resolvedPaneId, selectedTabId]);

  return (
    <div
      data-editor-pane-tabs={resolvedPaneId}
      data-electron-drag={isElectronHost ? '' : undefined}
      className={cn(
        'flex h-12 w-full min-w-0 touch-manipulation items-end overflow-hidden',
        reserveLeadingChrome
          ? 'pl-[calc(var(--editor-header-leading-offset,0px)+var(--editor-header-leading-width,0px)+0.5rem)]'
          : 'pl-2',
        reserveTrailingChrome && 'pr-[var(--editor-header-trailing-width,0px)]',
        isElectronHost && '[-webkit-app-region:drag]',
      )}
    >
      <div
        data-editor-tab-overflow-root=""
        data-electron-drag={isElectronHost ? '' : undefined}
        className={cn(
          'group/tab-overflow relative flex min-w-0 flex-1 self-stretch items-end gap-px overflow-hidden',
          isElectronHost && '[-webkit-app-region:drag]',
        )}
      >
        <span
          aria-atomic="true"
          aria-live="polite"
          data-testid="editor-tab-split-announcement"
          className="sr-only"
        >
          <span key={splitAnnouncement.id}>{splitAnnouncement.text}</span>
        </span>
        <SortableContext items={[...visibleTabIds]} strategy={horizontalListSortingStrategy}>
          <div
            className={cn(
              'relative h-10 w-fit max-w-[calc(100%-1.75rem)] min-w-0 flex-none self-end',
              isElectronHost && '[-webkit-app-region:no-drag]',
            )}
          >
            <div
              ref={tabScrollRef}
              data-editor-tab-scroll=""
              className="scrollbar-none flex h-10 w-fit max-w-full min-w-0 items-end gap-px overflow-x-auto overflow-y-hidden overscroll-x-contain group-data-[overflow-left]/tab-overflow:mask-l-from-[calc(100%-4rem)] group-data-[overflow-right]/tab-overflow:mask-r-from-[calc(100%-4rem)]"
              onScroll={(event) => syncTabOverflowIndicators(event.currentTarget)}
              onWheel={(event) => {
                scrollTabStripOnWheel(event);
                syncTabOverflowIndicators(event.currentTarget);
              }}
            >
              {visibleTabIds.length === 0 && dropIndicatorIndex === 0 ? (
                <span
                  aria-hidden="true"
                  data-editor-tab-drop-indicator="before"
                  className="pointer-events-none absolute inset-y-1 left-0 z-30 w-0.5 rounded-full bg-primary"
                />
              ) : null}
              {visibleTabIds.map((tabId, tabIndex) => {
                const shortcutHint = showTabShortcutHints
                  ? shortcutDigitForIndex(tabIndex, visibleTabIds.length)
                  : null;
                const ariaKeyShortcuts = isFocusedPane
                  ? tabAriaKeyShortcutsForIndex(tabIndex, visibleTabIds.length)
                  : undefined;
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
                      promoteTab={promoteTab}
                      splitTab={splitTab}
                      tabLabel={t`New tab`}
                      unpinTab={unpinTab}
                    >
                      <SortableTab
                        dropIndicatorSide={dropIndicatorSideForTab(tabIndex)}
                        label={t`New tab`}
                        paneId={resolvedPaneId}
                        splittable
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
                          className={tabTitleClassName(isActive && isFocusedPane, false)}
                          onClick={() => activateNewTab(tabId)}
                          tabIndex={-1}
                        >
                          <span
                            data-editor-tab-title-overflow="ellipsis"
                            className="min-w-0 truncate"
                          >
                            {isBlobRunnerNewTabId(tabId) ? (
                              <Trans>Blob Run</Trans>
                            ) : (
                              <Trans>New tab</Trans>
                            )}
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
                const isPreview = tabId === previewTabId;
                if (tab.kind === 'folder') {
                  const { baseName, label, prefix } = tabParts(tab.folderPath, '/');
                  const accessibleLabel = `${prefix}${label}`;
                  return (
                    <EditorTabFrame
                      key={tabId}
                      accessibleLabel={accessibleLabel}
                      activateTab={activateTab}
                      ariaKeyShortcuts={ariaKeyShortcuts}
                      dropIndicatorSide={dropIndicatorSideForTab(tabIndex)}
                      tabId={tabId}
                      paneId={resolvedPaneId}
                      target={{
                        kind: 'folder',
                        target: tab.folderPath,
                        folderPath: tab.folderPath,
                      }}
                      renameName={baseName}
                      openTabs={visibleTabIds}
                      closeTab={closeTab}
                      closeTabs={closeVisibleTabs}
                      forceCloseVisible={forceTabCloseVisible}
                      isActive={isActive}
                      isPinned={isPinned}
                      isPreview={isPreview}
                      pinTab={pinTab}
                      pinnedTabIds={pinnedTabIds}
                      promoteTab={promoteTab}
                      shortcutHint={shortcutHint}
                      splitTab={splitTab}
                      unpinTab={unpinTab}
                    >
                      <TabPathTooltip path={accessibleLabel}>
                        <button
                          type="button"
                          aria-label={accessibleLabel}
                          // The label is the user's own file path, so its direction comes
                          // from the path rather than the interface language (see
                          // `UserText`). On the button because the path is split across
                          // sibling spans for truncation — one isolate around all of them
                          // keeps the fragments in the order the name was written.
                          dir="auto"
                          className={tabTitleClassName(isActive && isFocusedPane, isPreview)}
                          onClick={() => activateTab(tabId)}
                          onDoubleClick={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            promoteTab(tabId);
                          }}
                          tabIndex={-1}
                        >
                          <span
                            data-editor-tab-title-overflow={isActive ? 'fade' : 'ellipsis'}
                            className={cn('min-w-0 flex-1', tabTitleOverflowClassName(isActive))}
                          >
                            {prefix && (
                              <span
                                className={cn(
                                  '@max-[5rem]/tab:hidden',
                                  isActive && 'text-muted-foreground',
                                )}
                              >
                                {prefix}
                              </span>
                            )}
                            <span>{baseName}/</span>
                          </span>
                        </button>
                      </TabPathTooltip>
                    </EditorTabFrame>
                  );
                }

                if (
                  tab.kind === 'asset' ||
                  tab.kind === 'skill-file' ||
                  tab.kind === 'skill-preview'
                ) {
                  // Skill bundle files and marketplace previews share the asset
                  // tab's read-only chrome.
                  let labelPath: string;
                  switch (tab.kind) {
                    case 'asset':
                      labelPath = tab.assetPath;
                      break;
                    case 'skill-file':
                      labelPath = tab.path;
                      break;
                    case 'skill-preview':
                      labelPath = tab.name;
                      break;
                  }
                  const { baseName, label, prefix } = tabParts(labelPath, '');
                  const accessibleLabel = `${prefix}${label}`;
                  const skillFileCandidates =
                    tab.kind === 'skill-file'
                      ? editableSkills.filter(
                          (skill) => skill.scope === tab.scope && skill.name === tab.name,
                        )
                      : [];
                  const skillFileOwner =
                    tab.kind === 'skill-file'
                      ? tab.host
                        ? skillFileCandidates.find((skill) => skill.hosts[0] === tab.host)
                        : skillFileCandidates.length === 1
                          ? skillFileCandidates[0]
                          : undefined
                      : undefined;
                  return (
                    <EditorTabFrame
                      key={tabId}
                      accessibleLabel={accessibleLabel}
                      activateTab={activateTab}
                      ariaKeyShortcuts={ariaKeyShortcuts}
                      dropIndicatorSide={dropIndicatorSideForTab(tabIndex)}
                      tabId={tabId}
                      paneId={resolvedPaneId}
                      target={
                        tab.kind === 'asset'
                          ? {
                              kind: 'asset',
                              target: tab.assetPath,
                              assetPath: tab.assetPath,
                              mediaKind: null,
                            }
                          : undefined
                      }
                      renameName={tab.kind === 'asset' ? baseName : undefined}
                      openTabs={visibleTabIds}
                      closeTab={closeTab}
                      closeTabs={closeVisibleTabs}
                      forceCloseVisible={forceTabCloseVisible}
                      isActive={isActive}
                      isPinned={isPinned}
                      isPreview={isPreview}
                      pinTab={pinTab}
                      pinnedTabIds={pinnedTabIds}
                      promoteTab={promoteTab}
                      shortcutHint={shortcutHint}
                      splitTab={splitTab}
                      skillMenuItems={
                        tab.kind === 'skill-file' && skillFileOwner ? (
                          <SkillFileContextMenuItems
                            actions={skillActions}
                            filePath={tab.path}
                            menuKind="context"
                            skill={skillFileOwner}
                          />
                        ) : undefined
                      }
                      unpinTab={unpinTab}
                    >
                      <TabPathTooltip path={accessibleLabel}>
                        <button
                          type="button"
                          aria-label={accessibleLabel}
                          // The label is the user's own file path, so its direction comes
                          // from the path rather than the interface language (see
                          // `UserText`). On the button because the path is split across
                          // sibling spans for truncation — one isolate around all of them
                          // keeps the fragments in the order the name was written.
                          dir="auto"
                          className={tabTitleClassName(isActive && isFocusedPane, isPreview)}
                          onClick={() => activateTab(tabId)}
                          onDoubleClick={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            promoteTab(tabId);
                          }}
                          tabIndex={-1}
                        >
                          <span
                            data-editor-tab-title-overflow={isActive ? 'fade' : 'ellipsis'}
                            className={cn('min-w-0 flex-1', tabTitleOverflowClassName(isActive))}
                          >
                            {prefix ? (
                              <span
                                className={cn(
                                  'text-muted-foreground/60 @max-[5rem]/tab:hidden',
                                  isActive && 'text-muted-foreground',
                                )}
                              >
                                {prefix}
                              </span>
                            ) : null}
                            <span>{baseName}</span>
                          </span>
                        </button>
                      </TabPathTooltip>
                    </EditorTabFrame>
                  );
                }

                const docName = tab.docName;
                const skill = editableSkillsByTabId.get(docName);
                const docExt = pageMeta.get(docName)?.docExt ?? '.md';
                // An editable `.md`/`.mdx` reference opens as an ordinary doc
                // tab, not a `skill-file` one, so its bundle-file actions have
                // to be resolved back from the doc name to reach parity with
                // the same file's row in the Skills sidebar.
                const bundleFile = skill
                  ? null
                  : skillFileForDocName(docName, editableSkills, docExt);
                const { baseName, extension, label, prefix } = tabParts(docName, docExt);
                const accessibleLabel = `${prefix}${label}`;
                const hideDocExtension = docExt === '.md' || docExt === '.mdx';
                const hasFileTargetActions =
                  !isSkillDocName(docName) && !isSkillBundleShapedPath(docName);
                return (
                  <EditorTabFrame
                    key={tabId}
                    accessibleLabel={accessibleLabel}
                    activateTab={activateTab}
                    ariaKeyShortcuts={ariaKeyShortcuts}
                    dropIndicatorSide={dropIndicatorSideForTab(tabIndex)}
                    tabId={tabId}
                    paneId={resolvedPaneId}
                    docExt={docExt}
                    target={
                      hasFileTargetActions ? { kind: 'doc', target: docName, docName } : undefined
                    }
                    renameName={hasFileTargetActions ? `${baseName}${extension}` : undefined}
                    openTabs={visibleTabIds}
                    closeTab={closeTab}
                    closeTabs={closeVisibleTabs}
                    forceCloseVisible={forceTabCloseVisible}
                    isActive={isActive}
                    isPinned={isPinned}
                    isPreview={isPreview}
                    pinTab={pinTab}
                    pinnedTabIds={pinnedTabIds}
                    promoteTab={promoteTab}
                    shortcutHint={shortcutHint}
                    splitTab={splitTab}
                    skillMenuItems={
                      skill ? (
                        <SkillContextMenuItems
                          actions={skillActions}
                          existingNames={skillNamesByScope.get(skill.scope) ?? EMPTY_SKILL_NAME_SET}
                          menuKind="context"
                          skill={skill}
                        />
                      ) : bundleFile ? (
                        <SkillFileContextMenuItems
                          actions={skillActions}
                          filePath={bundleFile.filePath}
                          menuKind="context"
                          skill={bundleFile.skill}
                        />
                      ) : undefined
                    }
                    unpinTab={unpinTab}
                  >
                    <DocumentTabButton
                      accessibleLabel={accessibleLabel}
                      activateTab={activateTab}
                      baseName={baseName}
                      docName={docName}
                      extension={extension}
                      hideDocExtension={hideDocExtension}
                      isActive={isActive}
                      isFocusedPane={isFocusedPane}
                      isPreview={isPreview}
                      promoteTab={promoteTab}
                      tabId={tabId}
                    />
                  </EditorTabFrame>
                );
              })}
            </div>
          </div>
        </SortableContext>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              aria-label={t`New tab`}
              data-testid="editor-new-tab-button"
              className={cn(
                'first:mb-3 mb-1.5 shrink-0',
                isElectronHost && '[-webkit-app-region:no-drag]',
              )}
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
      {skillActions.dialogs}
    </div>
  );
}

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { isMacOS } from '@tiptap/core';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { assetTabId, folderTabId, skillFileTabId } from '@/editor/editor-tabs';
import { renderLinguiTemplate } from '@/test-utils/lingui-mock';
import {
  expectVisualClassTokens,
  expectVisualClassTokensAbsent,
} from '@/test-utils/visual-contract';

let activeDocName: string | null = 'docs/team/spec';
let activeTabId: string | null = 'docs/team/spec';
let activeNewTabId: string | null = null;
let activeTarget: unknown = null;
let isNewTabActive = false;
let openTabs: string[] = [];
let visibleTabIds: string[] = [];
let newTabIds: string[] = [];
let pinnedTabIds: string[] = [];
let previewTabId: string | null = null;
let pageMeta: Map<string, { docExt?: string }> = new Map();
let lifecycleStatuses: Map<string, string> = new Map();
let focusedPaneId = 'pane-a';
let skillsState: unknown = { status: 'idle' };

const activateTab = vi.fn(() => {});
const activateNewTab = vi.fn(() => {});
const closeNewTab = vi.fn(() => {});
const closeTab = vi.fn(() => {});
const closeTabs = vi.fn(() => {});
const openNewTab = vi.fn(() => {});
const pinTab = vi.fn(() => {});
const promoteTab = vi.fn(() => {});
const reopenClosedTab = vi.fn(() => {});
const reorderTabs = vi.fn(() => {});
const unpinTab = vi.fn(() => {});
const moveTabToNewPane = vi.fn(() => 'pane-new' as string | null);
const requestSkillDelete = vi.fn(() => {});
const requestSkillFileRename = vi.fn(() => {});

function primaryShortcutModifier(): Pick<KeyboardEventInit, 'ctrlKey' | 'metaKey'> {
  return isMacOS() ? { metaKey: true } : { ctrlKey: true };
}

type DndContextProps = {
  accessibility?: { container?: HTMLElement };
  children?: ReactNode;
  onDragEnd?: (event: { active: { id: string }; over: { id: string } | null }) => void;
  sensors?: unknown;
};

const pointerSensorToken = { name: 'PointerSensor' };
const keyboardSensorToken = { name: 'KeyboardSensor' };
const closestCenterToken = { name: 'closestCenter' };
const horizontalListSortingStrategyToken = { name: 'horizontalListSortingStrategy' };
const sortableKeyboardCoordinatesToken = { name: 'sortableKeyboardCoordinates' };
const dndContextProps: DndContextProps[] = [];
const sensorCalls: Array<{ sensor: unknown; options: unknown }> = [];
const sortableContextProps: Array<{ items: string[]; strategy: unknown }> = [];
const sortableOptions: Array<{
  animateLayoutChanges?: () => boolean;
  data?: unknown;
  disabled?: boolean;
  id: string;
  transition?: unknown;
}> = [];
// Stands in for dnd-kit's in-flight drag; non-null simulates a reorder drag.
let activeDrag: { id: string } | null = null;

import * as actualLinguiMacro from '@lingui/react/macro';

vi.doMock('@lingui/react/macro', () => ({
  ...actualLinguiMacro,
  Trans: ({ children }: { children?: ReactNode }) => <>{children}</>,
  useLingui: () => ({ t: renderLinguiTemplate }),
}));

vi.doMock('@dnd-kit/core', () => ({
  closestCenter: closestCenterToken,
  DndContext: (props: DndContextProps) => {
    dndContextProps.push(props);
    return <div data-testid="dnd-context">{props.children}</div>;
  },
  KeyboardCode: {
    Down: 'ArrowDown',
    End: 'End',
    Enter: 'Enter',
    Esc: 'Escape',
    Home: 'Home',
    Left: 'ArrowLeft',
    Right: 'ArrowRight',
    Space: 'Space',
    Up: 'ArrowUp',
  },
  KeyboardSensor: keyboardSensorToken,
  PointerSensor: pointerSensorToken,
  useDndContext: () => ({ active: activeDrag }),
  useSensor: (sensor: unknown, options: unknown) => {
    sensorCalls.push({ sensor, options });
    return { sensor, options };
  },
  useSensors: (...sensors: unknown[]) => sensors,
}));

vi.doMock('@dnd-kit/sortable', () => ({
  arrayMove: <T,>(items: T[], from: number, to: number) => {
    const next = [...items];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item);
    return next;
  },
  horizontalListSortingStrategy: horizontalListSortingStrategyToken,
  sortableKeyboardCoordinates: sortableKeyboardCoordinatesToken,
  SortableContext: ({
    children,
    items,
    strategy,
  }: {
    children?: ReactNode;
    items: string[];
    strategy: unknown;
  }) => {
    sortableContextProps.push({ items: [...items], strategy });
    return <div data-testid="sortable-context">{children}</div>;
  },
  useSortable: (options: {
    animateLayoutChanges?: () => boolean;
    data?: unknown;
    id: string;
    transition?: unknown;
  }) => {
    const { id } = options;
    sortableOptions.push(options);
    return {
      attributes: {
        role: 'button',
        'aria-roledescription': 'sortable',
        'data-sortable-id': id,
      },
      isDragging: false,
      listeners: {},
      rect: { current: { width: 120 } },
      setNodeRef: () => {},
      transform: null,
      transition: 'transform 200ms ease',
    };
  },
}));

vi.doMock('@dnd-kit/utilities', () => ({
  CSS: {
    Transform: {
      toString: () => undefined,
    },
  },
}));

vi.doMock('@/components/ui/context-menu', () => ({
  ContextMenu: ({ children }: { children?: ReactNode }) => <>{children}</>,
  ContextMenuContent: ({ children, className }: { children?: ReactNode; className?: string }) => (
    <div className={className} role="menu">
      {children}
    </div>
  ),
  ContextMenuGroup: ({ children }: { children?: ReactNode }) => <>{children}</>,
  ContextMenuItem: ({
    children,
    disabled,
    onSelect,
    ...props
  }: {
    children?: ReactNode;
    disabled?: boolean;
    onSelect?: () => void;
    [key: string]: unknown;
  }) => (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={() => {
        if (!disabled) onSelect?.();
      }}
      {...props}
    >
      {children}
    </button>
  ),
  ContextMenuSeparator: () => <hr data-testid="context-menu-separator" />,
  ContextMenuTrigger: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));

vi.doMock('@/components/EditorTabTargetMenuItems', () => ({
  EditorTabTargetMenuItems: () => null,
}));

vi.doMock('@/components/FileTargetRenameDialog', () => ({
  FileTargetRenameDialog: () => null,
}));

vi.doMock('@/components/skill-actions', () => ({
  SkillFileContextMenuItems: ({
    actions,
    filePath,
    menuKind,
    skill,
  }: {
    actions: { requestFileRename: (skill: unknown, filePath: string) => void };
    filePath: string;
    menuKind?: string;
    skill: { name: string };
  }) => (
    <button
      type="button"
      role="menuitem"
      data-menu-kind={menuKind}
      onClick={() => actions.requestFileRename(skill, filePath)}
    >
      Rename skill file {filePath}
    </button>
  ),
  SkillContextMenuItems: ({
    actions,
    menuKind,
    skill,
  }: {
    actions: { requestDelete: (skill: unknown) => void };
    menuKind?: string;
    skill: { name: string };
  }) => (
    <button
      type="button"
      role="menuitem"
      data-menu-kind={menuKind}
      onClick={() => actions.requestDelete(skill)}
    >
      Delete skill {skill.name}
    </button>
  ),
  useSkillActions: () => ({
    dialogs: <div data-testid="skill-action-dialogs" />,
    requestDelete: requestSkillDelete,
    requestFileRename: requestSkillFileRename,
  }),
}));

vi.doMock('@/editor/DocumentContext', () => ({
  // EditorTabs imports isBlobRunnerNewTabId to name the runner's tab; this is
  // a whole-module replacement, so the export must exist here or the link
  // detonates on load.
  isBlobRunnerNewTabId: () => false,
  useDocumentContext: () => ({
    activeDocName,
    activeNewTabId,
    activeTabId,
    activeTarget,
    activateNewTab,
    activateTab,
    closeNewTab,
    closeTab,
    closeTabs,
    isNewTabActive,
    newTabIds,
    openNewTab,
    openTabs,
    pinTab,
    pinnedTabIds,
    reopenClosedTab,
    reorderTabs,
    unpinTab,
    visibleTabIds,
    visibleTabIdsByPane: new Map([['pane-a', visibleTabIds]]),
    focusedPaneId,
    panes: [
      {
        id: 'pane-a',
        openTabs,
        pinnedTabIds,
        previewTabId,
        activeTabId,
        newTabIds,
        activeNewTabId,
        activeTarget:
          activeTarget ??
          (activeDocName ? { kind: 'doc', target: activeDocName, docName: activeDocName } : null),
        size: 100,
      },
    ],
    activateTabInPane: (_paneId: string, tabId: string) => activateTab(tabId),
    activateNewTabInPane: (_paneId: string, tabId: string) => activateNewTab(tabId),
    closeNewTabInPane: (_paneId: string, tabId: string) => closeNewTab(tabId),
    closeTabInPane: (_paneId: string, tabId: string) => closeTab(tabId),
    closeTabsInPane: (_paneId: string, tabIds: readonly string[]) => closeTabs(tabIds),
    moveTabToNewPane,
    openNewTabInPane: () => openNewTab(),
    pinTabInPane: (_paneId: string, tabId: string) => pinTab(tabId),
    promoteTabInPane: (_paneId: string, tabId: string) => promoteTab(tabId),
    unpinTabInPane: (_paneId: string, tabId: string) => unpinTab(tabId),
  }),
}));

vi.doMock('@/components/PageListContext', () => ({
  usePageList: () => ({
    pageMeta,
  }),
}));

vi.doMock('@/hooks/use-lifecycle-status', () => ({
  useLifecycleStatus: (docName: string) => lifecycleStatuses.get(docName) ?? null,
}));

vi.doMock('@/hooks/use-skills', () => ({
  useSkills: () => skillsState,
}));

function defaultTabs() {
  const folderId = folderTabId('docs/team');
  const assetId = assetTabId('images/cat.png');
  const newId = 'new-tab-1';
  return {
    assetId,
    folderId,
    newId,
    tabs: ['docs/team/notes', 'docs/team/spec', 'docs/team/readme', folderId, assetId],
    visible: ['docs/team/notes', 'docs/team/spec', 'docs/team/readme', folderId, assetId, newId],
  };
}

function resetState() {
  const { newId, tabs, visible } = defaultTabs();
  activeDocName = 'docs/team/spec';
  activeTabId = 'docs/team/spec';
  activeNewTabId = null;
  activeTarget = null;
  isNewTabActive = false;
  openTabs = tabs;
  visibleTabIds = visible;
  newTabIds = [newId];
  pinnedTabIds = [];
  previewTabId = null;
  pageMeta = new Map([
    ['docs/team/notes', { docExt: '.md' }],
    ['docs/team/spec', { docExt: '.mdx' }],
    ['docs/team/readme', { docExt: '.txt' }],
  ]);
  lifecycleStatuses = new Map();
  focusedPaneId = 'pane-a';
  skillsState = { status: 'idle' };
  activeDrag = null;
  dndContextProps.length = 0;
  sensorCalls.length = 0;
  sortableContextProps.length = 0;
  sortableOptions.length = 0;
  for (const fn of [
    activateTab,
    activateNewTab,
    closeNewTab,
    closeTab,
    closeTabs,
    openNewTab,
    pinTab,
    promoteTab,
    reopenClosedTab,
    reorderTabs,
    unpinTab,
    moveTabToNewPane,
    requestSkillDelete,
    requestSkillFileRename,
  ]) {
    fn.mockClear();
  }
  Object.defineProperty(window, 'okDesktop', {
    configurable: true,
    value: undefined,
  });
  window.location.hash = '';
}

async function renderEditorTabs({
  dropIndicatorIndex = null,
  reserveLeadingChrome = false,
}: {
  dropIndicatorIndex?: number | null;
  reserveLeadingChrome?: boolean;
} = {}) {
  const { EditorTabs } = await import('./EditorTabs');
  return render(
    <TooltipProvider>
      <EditorTabs
        dropIndicatorIndex={dropIndicatorIndex}
        paneId="pane-a"
        reserveLeadingChrome={reserveLeadingChrome}
      />
    </TooltipProvider>,
  );
}

function tabButton(name: string) {
  const button = screen
    .getAllByRole('button', { name })
    .find((element) => element.tagName === 'BUTTON' && !element.hasAttribute('data-sortable-id'));
  expect(button).toBeDefined();
  return button as HTMLButtonElement;
}

// Radix appends a visually-hidden copy of the content for screen readers, so
// the element's textContent repeats the label. The first node is what a
// sighted user actually reads, and comparing it exactly keeps these
// assertions from passing on a different tab's tooltip.
function tooltipText(tooltip: HTMLElement): string {
  return tooltip.firstChild?.textContent ?? tooltip.textContent ?? '';
}

describe('EditorTabs runtime behavior', () => {
  beforeEach(() => {
    resetState();
  });

  afterEach(() => {
    cleanup();
  });

  test('renders markdown doc labels without extensions while preserving full-path accessible names', async () => {
    await renderEditorTabs();

    const markdownTab = tabButton('docs/team/notes.md');
    expect(markdownTab.textContent).toBe('notes');
    expect(markdownTab.getAttribute('title')).toBeNull();
    expect(markdownTab.closest('[data-sortable-id]')?.getAttribute('aria-keyshortcuts')).toBe(
      'Meta+1 Control+1',
    );

    const mdxTab = tabButton('docs/team/spec.mdx');
    expect(mdxTab.textContent).toBe('spec');
    expect(mdxTab.getAttribute('title')).toBeNull();
    expect(mdxTab.closest('[data-sortable-id]')?.getAttribute('aria-current')).toBe('page');

    const txtTab = tabButton('docs/team/readme.txt');
    expect(txtTab.textContent).toBe('readme.txt');
    expect(txtTab.getAttribute('title')).toBeNull();
  });

  // The visible label is only the base name, so two same-named files in
  // different folders are indistinguishable without disclosing the path.
  test('hovering a doc tab discloses its full path, which the label alone does not show', async () => {
    await renderEditorTabs();

    const markdownTab = tabButton('docs/team/notes.md');
    expect(markdownTab.textContent).toBe('notes');
    expect(markdownTab.getAttribute('title')).toBeNull();

    fireEvent.pointerEnter(markdownTab, { pointerType: 'mouse' });
    fireEvent.pointerMove(markdownTab, { pointerType: 'mouse' });

    const tooltip = await screen.findByRole('tooltip');
    expect(tooltipText(tooltip)).toBe('docs/team/notes.md');
  });

  test.each([
    ['folder', 'docs/team/'],
    ['asset', 'images/cat.png'],
  ])('hovering a %s tab discloses its full path', async (_kind, expectedPath) => {
    await renderEditorTabs();

    const tab = tabButton(expectedPath);
    expect(tab.getAttribute('title')).toBeNull();
    fireEvent.pointerEnter(tab, { pointerType: 'mouse' });
    fireEvent.pointerMove(tab, { pointerType: 'mouse' });

    const tooltip = await screen.findByRole('tooltip');
    expect(tooltipText(tooltip)).toBe(expectedPath);
  });

  test('a reorder drag suppresses the path tooltip instead of stranding it over the strip', async () => {
    activeDrag = { id: 'docs/team/notes' };
    await renderEditorTabs();

    const markdownTab = tabButton('docs/team/notes.md');
    fireEvent.pointerEnter(markdownTab, { pointerType: 'mouse' });
    fireEvent.pointerMove(markdownTab, { pointerType: 'mouse' });

    await Promise.resolve();
    expect(screen.queryByRole('tooltip')).toBeNull();
    expect(markdownTab.getAttribute('title')).toBeNull();
    // Load-bearing, not incidental coupling: the tooltip opens on a timer, so
    // the absence above would also hold in the split second before an
    // unsuppressed tooltip appeared. Asserting the trigger is gone is what
    // makes this fail if the suppression is removed.
    expect(markdownTab.getAttribute('data-slot')).not.toBe('tooltip-trigger');
  });

  // Tabs cap at max-w-64 and truncate, so a root-level name long enough to be
  // clipped still needs the disclosure even though no folder prefix precedes
  // it. Suppressing the apparent echo would leave that tab unreadable.
  test('a doc at the content root still discloses its name on hover', async () => {
    openTabs = ['readme'];
    visibleTabIds = ['readme'];
    pageMeta = new Map([['readme', { docExt: '.txt' }]]);
    await renderEditorTabs();

    const rootTab = tabButton('readme.txt');
    expect(rootTab.textContent).toBe('readme.txt');
    expect(rootTab.getAttribute('title')).toBeNull();

    fireEvent.pointerEnter(rootTab, { pointerType: 'mouse' });
    fireEvent.pointerMove(rootTab, { pointerType: 'mouse' });

    const tooltip = await screen.findByRole('tooltip');
    expect(tooltipText(tooltip)).toBe('readme.txt');
  });

  test('advertises pane-local tab shortcuts only in the focused pane', async () => {
    focusedPaneId = 'pane-b';
    const { container } = await renderEditorTabs();

    for (const tab of container.querySelectorAll('[data-sortable-id]')) {
      expect(tab.getAttribute('aria-keyshortcuts')).toBeNull();
    }
  });

  test('bolds the active tab only when its pane is focused', async () => {
    focusedPaneId = 'pane-b';
    await renderEditorTabs();

    expectVisualClassTokensAbsent(tabButton('docs/team/spec.mdx').className, ['font-semibold']);
  });

  test('keeps folder, asset, and new-tab branches closeable and independently activatable', async () => {
    const { assetId, folderId, newId } = defaultTabs();
    await renderEditorTabs();

    const folderTab = tabButton('docs/team/');
    expect(folderTab.textContent).toBe('docs/team/');
    fireEvent.click(folderTab);
    expect(activateTab).toHaveBeenCalledWith(folderId);

    const assetTab = tabButton('images/cat.png');
    expect(assetTab.textContent).toBe('images/cat.png');
    fireEvent.click(assetTab);
    expect(activateTab).toHaveBeenCalledWith(assetId);

    fireEvent.click(screen.getByRole('button', { name: 'Activate new tab' }));
    expect(activateNewTab).toHaveBeenCalledWith(newId);

    fireEvent.click(screen.getByRole('button', { name: 'Close new tab' }));
    expect(closeNewTab).toHaveBeenCalledWith(newId);

    fireEvent.click(screen.getByTestId('editor-new-tab-button'));
    expect(openNewTab).toHaveBeenCalledTimes(1);
  });

  test('reuses the sidebar skill actions for an editable skill tab', async () => {
    const skill = {
      scope: 'project',
      name: 'release-notes',
      path: '.ok/skills/release-notes/SKILL.md',
      managed: false,
    };
    const skillTabId = '.ok/skills/release-notes/SKILL';
    activeDocName = skillTabId;
    activeTabId = skillTabId;
    openTabs = [skillTabId];
    visibleTabIds = [skillTabId];
    newTabIds = [];
    skillsState = { status: 'ready', data: [skill] };

    await renderEditorTabs();

    const deleteItem = screen.getByRole('menuitem', { name: 'Delete skill release-notes' });
    expect(deleteItem.getAttribute('data-menu-kind')).toBe('context');
    expect(screen.getByTestId('skill-action-dialogs')).toBeTruthy();

    fireEvent.click(deleteItem);
    expect(requestSkillDelete).toHaveBeenCalledWith(skill);
  });

  test('does not expose skill actions for a managed skill tab', async () => {
    const skill = {
      scope: 'project',
      name: 'release-notes',
      path: '.ok/skills/release-notes/SKILL.md',
      managed: true,
    };
    const skillTabId = '.ok/skills/release-notes/SKILL';
    activeDocName = skillTabId;
    activeTabId = skillTabId;
    openTabs = [skillTabId];
    visibleTabIds = [skillTabId];
    newTabIds = [];
    skillsState = { status: 'ready', data: [skill] };

    await renderEditorTabs();

    expect(screen.queryByRole('menuitem', { name: 'Delete skill release-notes' })).toBeNull();
  });

  test('reuses the sidebar file actions for an editable skill-file tab', async () => {
    const skill = {
      scope: 'global',
      name: 'ask-matt',
      path: '.agents/skills/ask-matt/SKILL.md',
      absolutePath: '/Users/example/.agents/skills/ask-matt/SKILL.md',
      hosts: ['agents'],
      managed: false,
    };
    const filePath = 'agents/openai.yml';
    const skillTabId = skillFileTabId({ scope: 'global', name: skill.name, path: filePath });
    activeDocName = null;
    activeTabId = skillTabId;
    openTabs = [skillTabId];
    visibleTabIds = [skillTabId];
    newTabIds = [];
    skillsState = { status: 'ready', data: [skill] };

    await renderEditorTabs();

    const renameItem = screen.getByRole('menuitem', {
      name: `Rename skill file ${filePath}`,
    });
    expect(renameItem.getAttribute('data-menu-kind')).toBe('context');

    fireEvent.click(renameItem);
    expect(requestSkillFileRename).toHaveBeenCalledWith(skill, filePath);
  });

  test('reuses the sidebar file actions for an editable reference DOC tab', async () => {
    // A `.md` reference opens as an ordinary doc tab, not a `skill-file` one —
    // it carried no skill actions at all until its bundle path was resolved
    // back from the doc name.
    const skill = {
      scope: 'project',
      name: 'ask-matt',
      path: '.agents/skills/ask-matt/SKILL.md',
      hosts: ['agents'],
      managed: false,
    };
    const docName = '.agents/skills/ask-matt/references/notes';
    activeDocName = docName;
    activeTabId = docName;
    openTabs = [docName];
    visibleTabIds = [docName];
    newTabIds = [];
    skillsState = { status: 'ready', data: [skill] };

    await renderEditorTabs();

    const renameItem = screen.getByRole('menuitem', {
      name: 'Rename skill file references/notes.md',
    });
    expect(renameItem.getAttribute('data-menu-kind')).toBe('context');

    fireEvent.click(renameItem);
    expect(requestSkillFileRename).toHaveBeenCalledWith(skill, 'references/notes.md');
  });

  test('uses the host-qualified owner for an editable skill-file tab', async () => {
    const agentsSkill = {
      scope: 'global',
      name: 'ask-matt',
      path: '.agents/skills/ask-matt/SKILL.md',
      hosts: ['agents'],
      managed: false,
    };
    const claudeSkill = {
      scope: 'global',
      name: 'ask-matt',
      path: '.claude/skills/ask-matt/SKILL.md',
      hosts: ['claude'],
      managed: false,
    };
    const filePath = 'agents/openai.yml';
    const skillTabId = skillFileTabId({
      scope: 'global',
      name: agentsSkill.name,
      path: filePath,
      host: 'agents',
    });
    activeDocName = null;
    activeTabId = skillTabId;
    openTabs = [skillTabId];
    visibleTabIds = [skillTabId];
    newTabIds = [];
    skillsState = { status: 'ready', data: [claudeSkill, agentsSkill] };

    await renderEditorTabs();

    fireEvent.click(
      screen.getByRole('menuitem', {
        name: `Rename skill file ${filePath}`,
      }),
    );
    expect(requestSkillFileRename).toHaveBeenCalledWith(agentsSkill, filePath);
  });

  test('does not expose file actions when a host-less skill-file owner is ambiguous', async () => {
    const filePath = 'agents/openai.yml';
    const skillTabId = skillFileTabId({ scope: 'global', name: 'ask-matt', path: filePath });
    activeDocName = null;
    activeTabId = skillTabId;
    openTabs = [skillTabId];
    visibleTabIds = [skillTabId];
    newTabIds = [];
    skillsState = {
      status: 'ready',
      data: [
        {
          scope: 'global',
          name: 'ask-matt',
          path: '.agents/skills/ask-matt/SKILL.md',
          hosts: ['agents'],
          managed: false,
        },
        {
          scope: 'global',
          name: 'ask-matt',
          path: '.claude/skills/ask-matt/SKILL.md',
          hosts: ['claude'],
          managed: false,
        },
      ],
    };

    await renderEditorTabs();

    expect(screen.queryByRole('menuitem', { name: `Rename skill file ${filePath}` })).toBeNull();
  });

  test('Electron host makes tab-strip backgrounds draggable while controls opt out', async () => {
    Object.defineProperty(window, 'okDesktop', {
      configurable: true,
      value: {},
    });

    const { container } = await renderEditorTabs();
    const root = container.firstElementChild as HTMLElement;
    const overflowRoot = root.firstElementChild as HTMLElement;
    const scrollViewport = container.querySelector<HTMLElement>(
      '[data-editor-tab-scroll]',
    )?.parentElement;
    const newTabButton = screen.getByTestId('editor-new-tab-button');

    expect(root.getAttribute('data-editor-pane-tabs')).toBe('pane-a');
    expect(root.getAttribute('data-electron-drag')).toBe('');
    expectVisualClassTokens(root.className, ['[-webkit-app-region:drag]']);
    expectVisualClassTokensAbsent(root.className, ['[-webkit-app-region:no-drag]']);
    expect(overflowRoot.getAttribute('data-electron-drag')).toBe('');
    expectVisualClassTokens(overflowRoot.className, [
      'flex',
      'items-end',
      'gap-px',
      'min-w-0',
      'flex-1',
      'self-stretch',
      '[-webkit-app-region:drag]',
    ]);
    expectVisualClassTokensAbsent(overflowRoot.className, ['[-webkit-app-region:no-drag]']);
    expect(scrollViewport).toBeTruthy();
    expectVisualClassTokens(scrollViewport?.className, ['[-webkit-app-region:no-drag]']);
    expectVisualClassTokens(newTabButton.className, ['[-webkit-app-region:no-drag]']);
  });

  test('keeps restored-tab chrome alignment immediate', async () => {
    const { container } = await renderEditorTabs({ reserveLeadingChrome: true });
    const root = container.firstElementChild as HTMLElement;

    expectVisualClassTokens(root.className, [
      'pl-[calc(var(--editor-header-leading-offset,0px)+var(--editor-header-leading-width,0px)+0.5rem)]',
    ]);
    expectVisualClassTokensAbsent(root.className, [
      'motion-safe:group-data-[sidebar-transition-ready]/editor-header:transition-[padding-left]',
      'motion-safe:transition-[padding-left]',
    ]);
  });

  test('keeps every tab kind at the same wider resting width whether active or inactive', async () => {
    const { container } = await renderEditorTabs();
    const root = container.firstElementChild as HTMLElement;
    const wrapper = root.firstElementChild as HTMLElement;
    const scrollStrip = container.querySelector<HTMLElement>('[data-editor-tab-scroll]');
    const scrollViewport = scrollStrip?.parentElement;
    const newTabButton = screen.getByTestId('editor-new-tab-button');
    const sortableTabs = [...container.querySelectorAll<HTMLElement>('[data-editor-tab-sortable]')];

    expect(root.getAttribute('data-editor-pane-tabs')).toBe('pane-a');
    expect(container.querySelector('[data-electron-drag]')).toBeNull();
    expectVisualClassTokens(root.className, ['overflow-hidden']);
    expect(scrollStrip).toBeTruthy();
    expectVisualClassTokens(scrollStrip?.className, [
      'scrollbar-none',
      'overflow-x-auto',
      'overflow-y-hidden',
      'overscroll-x-contain',
      'group-data-[overflow-left]/tab-overflow:mask-l-from-[calc(100%-4rem)]',
      'group-data-[overflow-right]/tab-overflow:mask-r-from-[calc(100%-4rem)]',
      'w-fit',
      'max-w-full',
    ]);
    expectVisualClassTokens(scrollViewport?.className, [
      'w-fit',
      'max-w-[calc(100%-1.75rem)]',
      'flex-none',
    ]);
    expect(newTabButton.parentElement).toBe(wrapper);
    expect(wrapper.lastElementChild).toBe(newTabButton);
    expectVisualClassTokens(wrapper.className, [
      'group/tab-overflow',
      'relative',
      'min-w-0',
      'flex-1',
    ]);
    expect(container.querySelector('[data-editor-tab-overflow-control]')).toBeNull();
    expect(container.querySelector('[data-editor-tab-overflow-scrim]')).toBeNull();
    expect(sortableTabs.map((tab) => tab.dataset.sortableId)).toEqual(visibleTabIds);
    expect(sortableTabs.some((tab) => tab.dataset.activeTab === 'true')).toBe(true);
    expect(sortableTabs.some((tab) => tab.dataset.activeTab !== 'true')).toBe(true);
    for (const tab of sortableTabs) {
      expectVisualClassTokens(tab.className, [
        'min-w-32',
        'max-w-48',
        'grow-0',
        'basis-36',
        'shrink',
        'outline-none',
        'focus-visible:ring-2',
        'focus-visible:ring-ring/50',
        'focus-visible:ring-inset',
      ]);
      expectVisualClassTokensAbsent(tab.className, [
        'max-w-40',
        'basis-auto',
        'basis-28',
        'basis-32',
        'max-w-80',
        'grow-[2]',
        'basis-40',
        'max-w-56',
        'basis-24',
        'min-w-28',
        'min-w-0',
        'shrink-0',
        'transition-colors',
        'duration-100',
      ]);
    }
    const folderButton = tabButton('docs/team/');
    expectVisualClassTokens(folderButton.className, ['pl-3', 'pr-1.5']);
    expectVisualClassTokensAbsent(folderButton.className, ['px-3']);
    const folderLabel = folderButton.children[0];
    expect(folderLabel?.children[0]?.textContent).toBe('docs/');
    expect(folderLabel?.children[1]?.textContent).toBe('team/');
    expectVisualClassTokens(folderLabel?.className, ['min-w-0', 'flex-1', 'truncate']);
    expectVisualClassTokens(folderLabel?.children[0]?.className, ['@max-[5rem]/tab:hidden']);
    expectVisualClassTokensAbsent(folderLabel?.children[0]?.className, ['truncate', 'flex-1']);

    const assetButton = tabButton('images/cat.png');
    const assetLabel = assetButton.children[0];
    expect(assetLabel?.children[0]?.textContent).toBe('images/');
    expect(assetLabel?.children[1]?.textContent).toBe('cat.png');
    expectVisualClassTokens(assetLabel?.className, ['min-w-0', 'flex-1', 'truncate']);
    expectVisualClassTokens(assetLabel?.children[0]?.className, ['@max-[5rem]/tab:hidden']);
    expectVisualClassTokensAbsent(assetLabel?.children[0]?.className, ['truncate', 'flex-1']);

    expectVisualClassTokens(newTabButton.className, ['shrink-0']);
    expectVisualClassTokensAbsent(root.className, ['[-webkit-app-region:no-drag]']);
    expectVisualClassTokensAbsent(wrapper.className, ['[-webkit-app-region:no-drag]']);
  });

  test('does not scroll outer layout when a unified-header tab strip mounts', async () => {
    const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
    const scrollIntoView = vi.fn();
    HTMLElement.prototype.scrollIntoView = scrollIntoView;

    try {
      await renderEditorTabs();
      expect(scrollIntoView).not.toHaveBeenCalled();
    } finally {
      HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
    }
  });

  test('scrolls a newly selected tab into view without smooth motion', async () => {
    const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
    const scrollIntoView = vi.fn();
    HTMLElement.prototype.scrollIntoView = scrollIntoView;

    try {
      const view = await renderEditorTabs();
      const { EditorTabs } = await import('./EditorTabs');

      activeDocName = 'docs/team/readme';
      activeTabId = 'docs/team/readme';
      view.rerender(
        <TooltipProvider>
          <EditorTabs paneId="pane-a" />
        </TooltipProvider>,
      );

      expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest', inline: 'nearest' });
    } finally {
      HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
    }
  });

  test('maps a vertical wheel gesture to the overflowing tab strip', async () => {
    const { container } = await renderEditorTabs();
    const scrollStrip = container.querySelector<HTMLElement>('[data-editor-tab-scroll]');
    const overflowRoot = container.querySelector<HTMLElement>('[data-editor-tab-overflow-root]');
    if (!scrollStrip) throw new Error('Expected editor tab scroll strip');
    if (!overflowRoot) throw new Error('Expected editor tab overflow root');
    Object.defineProperties(scrollStrip, {
      clientWidth: { configurable: true, value: 320 },
      scrollWidth: { configurable: true, value: 800 },
    });

    fireEvent.scroll(scrollStrip);
    expect(overflowRoot.hasAttribute('data-overflow-left')).toBe(false);
    expect(overflowRoot.hasAttribute('data-overflow-right')).toBe(true);

    fireEvent.wheel(scrollStrip, { deltaX: 0, deltaY: 64 });

    expect(scrollStrip.scrollLeft).toBe(64);
    expect(overflowRoot.hasAttribute('data-overflow-left')).toBe(true);
    expect(overflowRoot.hasAttribute('data-overflow-right')).toBe(true);

    scrollStrip.scrollLeft = 480;
    fireEvent.scroll(scrollStrip);
    expect(overflowRoot.hasAttribute('data-overflow-left')).toBe(true);
    expect(overflowRoot.hasAttribute('data-overflow-right')).toBe(false);
  });

  test('double-click and Keep open stabilize preview tabs without changing tab geometry', async () => {
    previewTabId = 'docs/team/notes';
    const { container } = await renderEditorTabs();

    const previewButton = tabButton('docs/team/notes.md');
    const activeButton = tabButton('docs/team/spec.mdx');
    const previewTab = previewButton.closest<HTMLElement>('[data-editor-tab-sortable]');
    const activeTab = activeButton.closest<HTMLElement>('[data-editor-tab-sortable]');

    expect(previewTab?.dataset.previewTab).toBe('true');
    expect(activeTab?.dataset.previewTab).toBeUndefined();
    expectVisualClassTokens(previewButton.className, ['italic']);
    expectVisualClassTokensAbsent(previewButton.className, ['font-semibold']);
    expectVisualClassTokens(activeButton.className, ['font-semibold']);
    expectVisualClassTokensAbsent(activeButton.className, ['italic']);
    expect(previewTab?.className).toContain('basis-36');
    expect(activeTab?.className).toContain('basis-36');

    fireEvent.doubleClick(previewButton);
    expect(promoteTab).toHaveBeenCalledWith('docs/team/notes');

    promoteTab.mockClear();
    fireEvent.click(screen.getByTestId('editor-tab-context-keep-open'));
    expect(promoteTab).toHaveBeenCalledWith('docs/team/notes');
    expect(container.querySelectorAll('[data-preview-tab="true"]')).toHaveLength(1);
  });

  test('suppresses the native outline on the mouse-focused tab title', async () => {
    await renderEditorTabs();

    const titleButton = tabButton('docs/team/spec.mdx');
    const sortableTab = titleButton.closest<HTMLElement>('[data-editor-tab-sortable]');

    expectVisualClassTokens(titleButton.className, ['outline-none']);
    expectVisualClassTokens(sortableTab?.className ?? '', [
      'focus-visible:ring-2',
      'focus-visible:ring-ring/50',
    ]);
  });

  test('double-click stabilizes folder and asset tabs', async () => {
    const { assetId, folderId } = defaultTabs();
    await renderEditorTabs();

    fireEvent.doubleClick(tabButton('docs/team/'));
    expect(promoteTab).toHaveBeenCalledWith(folderId);

    promoteTab.mockClear();
    fireEvent.doubleClick(tabButton('images/cat.png'));
    expect(promoteTab).toHaveBeenCalledWith(assetId);
  });

  test('uses one truncation owner for every path-based tab while preserving its full label', async () => {
    const folderId = folderTabId('wiki/modules');
    const assetId = assetTabId('images/brand/logo.png');
    const skillId = skillFileTabId({
      scope: 'project',
      name: 'release-notes',
      path: 'references/publishing.md',
    });
    openTabs = [folderId, assetId, skillId];
    visibleTabIds = [folderId, assetId, skillId];
    newTabIds = [];

    await renderEditorTabs();

    const pathTabs = [
      tabButton('wiki/modules/'),
      tabButton('images/brand/logo.png'),
      tabButton('references/publishing.md'),
    ];
    expect(pathTabs.map((tab) => tab.textContent)).toEqual([
      'wiki/modules/',
      'images/brand/logo.png',
      'references/publishing.md',
    ]);
    expect(pathTabs.map((tab) => tab.querySelectorAll('.truncate').length)).toEqual([1, 1, 1]);
  });

  test('leaves the shared dnd context to the workspace and registers pane-owned sortables', async () => {
    await renderEditorTabs();

    expect(dndContextProps).toHaveLength(0);
    expect(sensorCalls).toHaveLength(0);
    expect(sortableContextProps.at(-1)).toEqual({
      items: visibleTabIds,
      strategy: horizontalListSortingStrategyToken,
    });
    expect(sortableOptions[0]?.data).toMatchObject({
      kind: 'editor-tab',
      paneId: 'pane-a',
      tabId: 'docs/team/notes',
      splittable: true,
    });
    expect(sortableOptions.at(-1)?.data).toMatchObject({
      kind: 'editor-tab',
      paneId: 'pane-a',
      tabId: defaultTabs().newId,
      splittable: true,
    });
    expect(sortableOptions.every((options) => options.transition === null)).toBe(true);
    expect(sortableOptions.every((options) => options.animateLayoutChanges?.() === false)).toBe(
      true,
    );
  });

  test('shows a static primary separator at the requested drop boundary', async () => {
    const { container } = await renderEditorTabs({ dropIndicatorIndex: 1 });

    const indicators = container.querySelectorAll<HTMLElement>('[data-editor-tab-drop-indicator]');
    expect(indicators).toHaveLength(1);
    expect(indicators[0]?.dataset.editorTabDropIndicator).toBe('before');
    expect(indicators[0]?.closest('[data-editor-tab-id]')?.getAttribute('data-editor-tab-id')).toBe(
      visibleTabIds[1],
    );
    expectVisualClassTokens(indicators[0]?.className ?? '', [
      'bg-primary',
      'w-0.5',
      'rounded-full',
      'left-0',
    ]);
    expectVisualClassTokensAbsent(indicators[0]?.className ?? '', ['transition']);
  });

  test('fades active and hovered inactive tab titles before the close button', async () => {
    await renderEditorTabs();

    const activeTitle = tabButton('docs/team/spec.mdx').querySelector<HTMLElement>(
      '[data-editor-tab-title-overflow="fade"]',
    );
    expect(activeTitle).not.toBeNull();
    expectVisualClassTokens(activeTitle?.className ?? '', [
      'flex-1',
      'overflow-hidden',
      'whitespace-nowrap',
      'mask-r-from-[calc(100%-1.5rem)]',
      'mask-r-to-[100%]',
    ]);
    expectVisualClassTokensAbsent(activeTitle?.className ?? '', ['truncate']);

    const inactiveTitle = tabButton('docs/team/notes.md').querySelector<HTMLElement>(
      '[data-editor-tab-title-overflow="ellipsis"]',
    );
    expect(inactiveTitle).not.toBeNull();
    expectVisualClassTokens(inactiveTitle?.className ?? '', [
      'truncate',
      'group-hover:text-clip',
      'group-hover:mask-r-from-[calc(100%-3rem)]',
      'group-hover:mask-r-to-[calc(100%-1.5rem)]',
    ]);
    expect(inactiveTitle?.className.split(/\s+/)).not.toContain('mask-r-to-[100%]');

    const inactiveFolderTitle = tabButton('docs/team/').querySelector<HTMLElement>(
      '[data-editor-tab-title-overflow="ellipsis"]',
    );
    expectVisualClassTokens(inactiveFolderTitle?.className ?? '', [
      'group-hover:text-clip',
      'group-hover:mask-r-from-[calc(100%-3rem)]',
      'group-hover:mask-r-to-[calc(100%-1.5rem)]',
    ]);
  });

  test('does not fade the fixed new-tab label', async () => {
    const { newId } = defaultTabs();
    activeDocName = null;
    activeTabId = null;
    activeNewTabId = newId;
    isNewTabActive = true;
    await renderEditorTabs();

    const title = screen
      .getByTestId('editor-new-tab-placeholder-button')
      .querySelector<HTMLElement>('[data-editor-tab-title-overflow]');

    expect(title?.getAttribute('data-editor-tab-title-overflow')).toBe('ellipsis');
    expectVisualClassTokens(title?.className ?? '', ['truncate']);
    expectVisualClassTokensAbsent(title?.className ?? '', [
      'mask-r-from-[calc(100%-1.5rem)]',
      'mask-r-to-[100%]',
      'group-hover:mask-r-from-[calc(100%-3rem)]',
      'group-hover:mask-r-to-[100%]',
    ]);
  });

  test('preserves a pane-local new-tab interleave', async () => {
    const { newId, tabs } = defaultTabs();
    visibleTabIds = [tabs[0], newId, ...tabs.slice(1)];

    await renderEditorTabs();

    expect(sortableContextProps.at(-1)?.items).toEqual(visibleTabIds);
  });

  test('handles tab keyboard shortcuts for create, navigation, jump, and reopen', async () => {
    const { newId } = defaultTabs();
    await renderEditorTabs();

    const primaryMod = primaryShortcutModifier();

    fireEvent.keyDown(window, { key: 't', ...primaryMod });
    expect(openNewTab).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(window, { key: 'Tab', ctrlKey: true });
    expect(activateTab).toHaveBeenLastCalledWith('docs/team/readme');

    fireEvent.keyDown(window, { key: 'Tab', ctrlKey: true, shiftKey: true });
    expect(activateTab).toHaveBeenLastCalledWith('docs/team/notes');

    fireEvent.keyDown(window, { key: '1', ...primaryMod });
    expect(activateTab).toHaveBeenLastCalledWith('docs/team/notes');

    fireEvent.keyDown(window, { key: '9', ...primaryMod });
    expect(activateNewTab).toHaveBeenLastCalledWith(newId);

    fireEvent.keyDown(window, { key: 'T', ...primaryMod, shiftKey: true });
    expect(reopenClosedTab).toHaveBeenCalledTimes(1);

    activateNewTab.mockClear();
    activateTab.mockClear();
    fireEvent.keyDown(window, { key: '7', ...primaryMod });
    expect(activateNewTab).not.toHaveBeenCalled();
    expect(activateTab).not.toHaveBeenCalled();
  });

  test('tab cycling shortcuts wrap from last to first and first to last', async () => {
    const { newId } = defaultTabs();
    activeDocName = null;
    activeTabId = null;
    activeNewTabId = newId;
    isNewTabActive = true;
    await renderEditorTabs();

    fireEvent.keyDown(window, { key: 'Tab', ctrlKey: true });
    expect(activateTab).toHaveBeenLastCalledWith('docs/team/notes');

    cleanup();
    resetState();
    activeDocName = 'docs/team/notes';
    activeTabId = 'docs/team/notes';
    await renderEditorTabs();

    fireEvent.keyDown(window, { key: 'Tab', ctrlKey: true, shiftKey: true });
    expect(activateNewTab).toHaveBeenLastCalledWith(newId);
  });

  test('modifier hold delays per-tab shortcut hints and non-active close affordances', async () => {
    vi.useFakeTimers();
    try {
      await renderEditorTabs();

      expect(screen.queryAllByTestId('editor-tab-shortcut-hint')).toHaveLength(0);

      fireEvent.keyDown(window, { key: 'Meta', metaKey: true });

      expect(screen.queryAllByTestId('editor-tab-shortcut-hint')).toHaveLength(0);
      expectVisualClassTokens(
        screen.getByRole('button', { name: 'Close docs/team/notes.md' }).getAttribute('class'),
        ['pointer-events-none', 'opacity-0'],
      );
      expectVisualClassTokens(
        screen.getByRole('button', { name: 'Close new tab' }).getAttribute('class'),
        ['pointer-events-none', 'opacity-0'],
      );

      act(() => {
        vi.advanceTimersByTime(999);
      });

      expect(screen.queryAllByTestId('editor-tab-shortcut-hint')).toHaveLength(0);
      expectVisualClassTokens(
        screen.getByRole('button', { name: 'Close docs/team/notes.md' }).getAttribute('class'),
        ['pointer-events-none', 'opacity-0'],
      );

      act(() => {
        vi.advanceTimersByTime(1);
      });

      expect(
        screen.getAllByTestId('editor-tab-shortcut-hint').map((node) => node.textContent),
      ).toEqual(['⌘1', '⌘2', '⌘3', '⌘4', '⌘5', '⌘6']);
      for (const hint of screen.getAllByTestId('editor-tab-shortcut-hint')) {
        expectVisualClassTokens(hint.className, ['mr-1', 'w-fit', 'shrink-0']);
        expectVisualClassTokensAbsent(hint.className, ['absolute', 'animate-in', 'zoom-in-95']);
      }
      expect(screen.queryByRole('button', { name: 'Close docs/team/notes.md' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Close new tab' })).toBeNull();

      fireEvent.blur(window);

      expect(screen.queryAllByTestId('editor-tab-shortcut-hint')).toHaveLength(0);
      expect(screen.getByRole('button', { name: 'Close docs/team/notes.md' })).toBeTruthy();

      fireEvent.keyDown(window, { key: 'Meta', metaKey: true });
      act(() => {
        vi.advanceTimersByTime(1000);
      });
      expect(screen.getAllByTestId('editor-tab-shortcut-hint')).toHaveLength(6);

      fireEvent.keyUp(window, { key: 'Meta' });

      expect(screen.queryAllByTestId('editor-tab-shortcut-hint')).toHaveLength(0);
      expect(screen.getByRole('button', { name: 'Close docs/team/notes.md' })).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  test('context actions close visible document tabs in bulk while routing empty tabs through closeNewTab', async () => {
    const { newId } = defaultTabs();
    pinnedTabIds = ['docs/team/readme'];
    await renderEditorTabs();

    fireEvent.click(screen.getAllByRole('menuitem', { name: 'Close others' })[0]);

    expect(closeTabs).toHaveBeenCalledWith([
      'docs/team/spec',
      defaultTabs().folderId,
      defaultTabs().assetId,
    ]);
    expect(closeNewTab).toHaveBeenCalledWith(newId);

    closeTabs.mockClear();
    closeNewTab.mockClear();
    fireEvent.click(screen.getAllByRole('menuitem', { name: 'Close all unpinned' })[0]);

    expect(closeTabs).toHaveBeenCalledWith([
      'docs/team/notes',
      'docs/team/spec',
      defaultTabs().folderId,
      defaultTabs().assetId,
    ]);
    expect(closeNewTab).toHaveBeenCalledWith(newId);
  });

  test('context actions move document, folder, and blank tabs into a new pane', async () => {
    const { folderId, newId } = defaultTabs();
    await renderEditorTabs();

    fireEvent.click(screen.getAllByTestId('editor-tab-context-split-left')[0]);
    expect(moveTabToNewPane).toHaveBeenCalledWith('docs/team/notes', 'left');
    const announcement = screen.getByTestId('editor-tab-split-announcement');
    expect(announcement.getAttribute('aria-live')).toBe('polite');
    expect(announcement.textContent).toBe('Moved docs/team/notes.md to a new pane on the left.');

    fireEvent.click(screen.getAllByTestId('editor-tab-context-split-right')[1]);
    expect(moveTabToNewPane).toHaveBeenCalledWith('docs/team/spec', 'right');
    expect(announcement.textContent).toBe('Moved docs/team/spec.mdx to a new pane on the right.');

    const folderTabIndex = visibleTabIds.indexOf(folderId);
    fireEvent.click(screen.getAllByTestId('editor-tab-context-split-left')[folderTabIndex]);
    expect(moveTabToNewPane).toHaveBeenCalledWith(folderId, 'left');

    const blankTabIndex = visibleTabIds.indexOf(newId);
    fireEvent.click(screen.getAllByTestId('editor-tab-context-split-right')[blankTabIndex]);
    expect(moveTabToNewPane).toHaveBeenCalledWith(newId, 'right');
  });

  test('offers Open in New Window on document tabs only, and never on the web host', async () => {
    const { folderId, assetId, newId } = defaultTabs();

    // Web host: no desktop bridge, so the pop-out entry point does not exist.
    await renderEditorTabs();
    expect(screen.queryAllByTestId('editor-tab-context-open-in-new-window')).toHaveLength(0);

    cleanup();
    const openNoteWindow = vi.fn(async () => ({ ok: true as const, outcome: 'created' as const }));
    Object.defineProperty(window, 'okDesktop', {
      configurable: true,
      value: { noteWindow: { open: openNoteWindow } },
    });
    await renderEditorTabs();

    // One per file-backed DOCUMENT tab. A folder and an asset carry their own
    // id prefixes; a blank "New tab" has no prefix and so parses as a doc, but
    // is backed by no file — all three are excluded.
    const items = screen.getAllByTestId('editor-tab-context-open-in-new-window');
    const docTabCount = visibleTabIds.filter(
      (id) => id !== folderId && id !== assetId && id !== newId,
    ).length;
    expect(items).toHaveLength(docTabCount);
    expect(docTabCount).toBe(3);

    fireEvent.click(items[0] as HTMLElement);
    expect(openNoteWindow).toHaveBeenCalledWith('docs/team/notes', 'tab-menu');
  });

  test('popping a tab out leaves the origin tab list untouched', async () => {
    const openNoteWindow = vi.fn(async () => ({ ok: true as const, outcome: 'created' as const }));
    Object.defineProperty(window, 'okDesktop', {
      configurable: true,
      value: { noteWindow: { open: openNoteWindow } },
    });
    await renderEditorTabs();

    fireEvent.click(
      screen.getAllByTestId('editor-tab-context-open-in-new-window')[0] as HTMLElement,
    );

    // Keep-both: the origin tab stays open, so nothing on the origin side moves.
    expect(closeTab).not.toHaveBeenCalled();
    expect(closeTabs).not.toHaveBeenCalled();
    expect(moveTabToNewPane).not.toHaveBeenCalled();
  });

  test('disables move-to-pane actions when the pane has only one tab', async () => {
    activeDocName = 'docs/team/notes';
    activeTabId = 'docs/team/notes';
    openTabs = ['docs/team/notes'];
    visibleTabIds = ['docs/team/notes'];
    newTabIds = [];
    await renderEditorTabs();

    const moveLeft = screen.getByTestId('editor-tab-context-split-left') as HTMLButtonElement;
    const moveRight = screen.getByTestId('editor-tab-context-split-right') as HTMLButtonElement;

    expect(moveLeft.disabled).toBe(true);
    expect(moveRight.disabled).toBe(true);

    fireEvent.click(moveLeft);
    fireEvent.click(moveRight);
    expect(moveTabToNewPane).not.toHaveBeenCalled();
  });

  test('pin state changes close controls, menu actions, and middle-click behavior', async () => {
    pinnedTabIds = ['docs/team/readme'];
    await renderEditorTabs();

    fireEvent.click(screen.getByRole('button', { name: 'Close docs/team/notes.md' }));
    expect(closeTab).toHaveBeenCalledWith('docs/team/notes');

    const unpinButton = screen.getByRole('button', { name: 'Unpin docs/team/readme.txt' });
    expect(unpinButton.getAttribute('title')).toBeNull();
    // `text-primary!` — the important modifier is part of the token, and the
    // pinned tint only holds because it outranks the button variant's own color.
    expectVisualClassTokens(unpinButton.className, ['text-primary!']);
    fireEvent.click(unpinButton);
    expect(unpinTab).toHaveBeenCalledWith('docs/team/readme');

    fireEvent.click(screen.getAllByRole('menuitem', { name: 'Pin tab' })[0]);
    expect(pinTab).toHaveBeenCalledWith('docs/team/notes');

    fireEvent.click(screen.getAllByRole('menuitem', { name: 'Unpin tab' })[0]);
    expect(unpinTab).toHaveBeenCalledWith('docs/team/readme');

    fireEvent(
      tabButton('docs/team/readme.txt').closest('[data-sortable-id]') ??
        tabButton('docs/team/readme.txt'),
      new MouseEvent('auxclick', { bubbles: true, button: 1, cancelable: true }),
    );
    expect(closeTab).not.toHaveBeenCalledWith('docs/team/readme');
  });

  test('tab context menus and active tab styling are visible behavior, not source-shape details', async () => {
    lifecycleStatuses.set('docs/team/notes', 'conflict');
    await renderEditorTabs();

    const conflictedTabButton = screen.getByRole('button', {
      name: 'docs/team/notes.md (conflict)',
    });
    expect(conflictedTabButton).toBeTruthy();
    expect(conflictedTabButton.getAttribute('title')).toBeNull();
    // A conflict is the one case where the tooltip carries state beyond the
    // path, so pin that it tracks the label rather than just the path.
    fireEvent.pointerEnter(conflictedTabButton, { pointerType: 'mouse' });
    fireEvent.pointerMove(conflictedTabButton, { pointerType: 'mouse' });
    expect(tooltipText(await screen.findByRole('tooltip'))).toBe('docs/team/notes.md (conflict)');
    expect(screen.getByTestId('editor-tab-conflict-badge').getAttribute('aria-hidden')).toBe(
      'true',
    );
    expect(screen.getAllByRole('menuitem', { name: 'Close' }).length).toBeGreaterThan(0);
    const closeOthersItems = screen.getAllByRole('menuitem', { name: 'Close others' });
    expect(closeOthersItems.length).toBeGreaterThan(0);
    expect(closeOthersItems[0]?.querySelector('svg.lucide-copy-x')).not.toBeNull();
    expect(screen.getAllByRole('menuitem', { name: 'Close all' }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('menuitem', { name: 'Pin tab' }).length).toBeGreaterThan(0);
    expect(screen.getAllByTestId('context-menu-separator').length).toBeGreaterThan(0);
    const activeSortable = screen
      .getAllByRole('button', { name: 'docs/team/spec.mdx' })
      .find((element) => element.tagName === 'BUTTON')
      ?.closest('[data-sortable-id]') as HTMLElement;
    expectVisualClassTokens(activeSortable.className, [
      'rounded-t-lg',
      'rounded-b-none',
      'border-border',
      'border-b-0',
      'bg-background',
    ]);

    const inactiveClose = within(
      conflictedTabButton.closest('[data-sortable-id]') as HTMLElement,
    ).getByRole('button', { name: 'Close docs/team/notes.md' });
    expectVisualClassTokens(inactiveClose.className, ['absolute', 'right-1']);
    expectVisualClassTokensAbsent(inactiveClose.className, [
      'bg-background/80',
      'backdrop-blur-sm',
    ]);
    expectVisualClassTokensAbsent(inactiveClose.className, ['mr-1']);

    const placeholderClose = screen.getByTestId('editor-new-tab-placeholder-close');
    expectVisualClassTokens(placeholderClose.className, [
      'pointer-events-none',
      'opacity-0',
      'group-hover:pointer-events-auto',
    ]);
  });
});

/**
 * The tab chords are registered capture-phase on `window`, so they run before
 * anything an overlay could install — an open command palette or dialog cannot
 * stop them from underneath and the listener has to decline for itself.
 *
 * Each suppression case is paired with the same chord fired without an overlay,
 * so a test that goes green because the shortcut stopped working outright is
 * distinguishable from one that goes green because the gate works.
 *
 * Keys the app never claims (⌘C/⌘V/⌘X/⌘A/⌘Z) are pinned as untouched while an
 * overlay is up: the gate must decline these chords, not swallow the whole
 * keyboard, or pasting into the palette's own search field breaks.
 */
describe('EditorTabs global chords — overlay gate', () => {
  beforeEach(() => {
    resetState();
  });

  afterEach(() => {
    cleanup();
  });

  async function renderTabsUnderOverlay() {
    const { EditorTabs } = await import('./EditorTabs');
    const { Dialog, DialogContent, DialogDescription, DialogTitle } = await import(
      '@/components/ui/dialog'
    );
    const view = render(
      <TooltipProvider>
        <EditorTabs />
        <Dialog open>
          <DialogContent>
            <DialogTitle>Command palette</DialogTitle>
            <DialogDescription>Search files and commands</DialogDescription>
          </DialogContent>
        </Dialog>
      </TooltipProvider>,
    );
    await waitFor(() => expect(screen.getByRole('dialog')).not.toBeNull());
    return view;
  }

  function press(init: KeyboardEventInit): boolean {
    let notPrevented = true;
    act(() => {
      notPrevented = fireEvent.keyDown(document.body, init);
    });
    return notPrevented;
  }

  const newTab = () => ({ key: 't', ...primaryShortcutModifier() });
  const reopenClosed = () => ({ key: 't', shiftKey: true, ...primaryShortcutModifier() });
  const jumpToFirst = () => ({ key: '1', ...primaryShortcutModifier() });
  const nextTab = () => ({ key: 'Tab', ctrlKey: true });

  test('⌘T opens a tab with no overlay, and does not while one is open', async () => {
    await renderEditorTabs();
    press(newTab());
    expect(openNewTab).toHaveBeenCalledTimes(1);

    cleanup();
    resetState();

    await renderTabsUnderOverlay();
    press(newTab());
    expect(openNewTab).not.toHaveBeenCalled();
  });

  test('⇧⌘T reopens a closed tab with no overlay, and does not while one is open', async () => {
    await renderEditorTabs();
    press(reopenClosed());
    expect(reopenClosedTab).toHaveBeenCalledTimes(1);

    cleanup();
    resetState();

    await renderTabsUnderOverlay();
    press(reopenClosed());
    expect(reopenClosedTab).not.toHaveBeenCalled();
  });

  test('⌘1 jumps to a tab with no overlay, and does not while one is open', async () => {
    await renderEditorTabs();
    press(jumpToFirst());
    expect(activateTab).toHaveBeenCalledTimes(1);

    cleanup();
    resetState();

    await renderTabsUnderOverlay();
    press(jumpToFirst());
    expect(activateTab).not.toHaveBeenCalled();
  });

  test('⌃Tab cycles tabs with no overlay, and does not while one is open', async () => {
    await renderEditorTabs();
    press(nextTab());
    expect(activateTab).toHaveBeenCalledTimes(1);

    cleanup();
    resetState();

    await renderTabsUnderOverlay();
    press(nextTab());
    expect(activateTab).not.toHaveBeenCalled();
  });

  test('leaves unclaimed chords alone while an overlay is open', async () => {
    await renderTabsUnderOverlay();

    const seen: string[] = [];
    const spy = (event: Event) => seen.push((event as KeyboardEvent).key);
    document.addEventListener('keydown', spy);

    try {
      // Clipboard, select-all, and undo/redo have to reach the overlay's own
      // input, so nothing may cancel them.
      for (const key of ['c', 'v', 'x', 'a', 'z']) {
        expect(press({ key, ...primaryShortcutModifier() })).toBe(true);
      }
      expect(press({ key: 'z', shiftKey: true, ...primaryShortcutModifier() })).toBe(true);
      for (const key of ['ArrowDown', 'ArrowUp', 'Enter']) {
        expect(press({ key })).toBe(true);
      }
      // Escape is cancelled by the dialog itself (that is the dismiss); the
      // property under test is only that it still reaches every listener.
      press({ key: 'Escape' });
    } finally {
      document.removeEventListener('keydown', spy);
    }

    expect(seen).toEqual(['c', 'v', 'x', 'a', 'z', 'z', 'ArrowDown', 'ArrowUp', 'Enter', 'Escape']);
    expect(openNewTab).not.toHaveBeenCalled();
    expect(activateTab).not.toHaveBeenCalled();
    expect(reopenClosedTab).not.toHaveBeenCalled();
  });
});

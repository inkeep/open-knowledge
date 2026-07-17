import { afterEach, beforeEach, describe, expect, jest, mock, test } from 'bun:test';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { isMacOS } from '@tiptap/core';
import type { ReactNode } from 'react';
import { assetTabId, folderTabId } from '@/editor/editor-tabs';
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
let pageMeta: Map<string, { docExt?: string }> = new Map();
let lifecycleStatuses: Map<string, string> = new Map();
let toastErrors: string[] = [];

const activateTab = mock(() => {});
const activateNewTab = mock(() => {});
const closeAndClearForRename = mock(() => Promise.resolve());
const closeNewTab = mock(() => {});
const closeTab = mock(() => {});
const closeTabs = mock(() => {});
const getPoolActiveDocName = mock(() => null as string | null);
const openNewTab = mock(() => {});
const pinTab = mock(() => {});
const reopenClosedTab = mock(() => {});
const remapTabsForRename = mock(() => {});
const reorderTabs = mock(() => {});
const unpinTab = mock(() => {});

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
const sortableOptions: Array<{ id: string; disabled?: boolean }> = [];

import * as actualLinguiMacro from '@lingui/react/macro';

mock.module('@lingui/react/macro', () => ({
  ...actualLinguiMacro,
  Trans: ({ children }: { children?: ReactNode }) => <>{children}</>,
  useLingui: () => ({ t: renderLinguiTemplate }),
}));

mock.module('@dnd-kit/core', () => ({
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
  useSensor: (sensor: unknown, options: unknown) => {
    sensorCalls.push({ sensor, options });
    return { sensor, options };
  },
  useSensors: (...sensors: unknown[]) => sensors,
}));

mock.module('@dnd-kit/sortable', () => ({
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
  useSortable: ({ id, disabled }: { id: string; disabled?: boolean }) => {
    sortableOptions.push({ id, disabled });
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

mock.module('@dnd-kit/utilities', () => ({
  CSS: {
    Transform: {
      toString: () => undefined,
    },
  },
}));

mock.module('@/components/ui/context-menu', () => ({
  ContextMenu: ({ children }: { children?: ReactNode }) => <>{children}</>,
  ContextMenuContent: ({ children, className }: { children?: ReactNode; className?: string }) => (
    <div className={className} role="menu">
      {children}
    </div>
  ),
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

mock.module('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children?: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children?: ReactNode }) => <div role="tooltip">{children}</div>,
  TooltipTrigger: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));

mock.module('@/editor/DocumentContext', () => ({
  useDocumentContext: () => ({
    activeDocName,
    activeNewTabId,
    activeTabId,
    activeTarget,
    activateNewTab,
    activateTab,
    closeAndClearForRename,
    closeNewTab,
    closeTab,
    closeTabs,
    getPoolActiveDocName,
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
  }),
}));

mock.module('@/components/PageListContext', () => ({
  usePageList: () => ({
    pageMeta,
  }),
}));

mock.module('@/hooks/use-lifecycle-status', () => ({
  useLifecycleStatus: (docName: string) => lifecycleStatuses.get(docName) ?? null,
}));

mock.module('sonner', () => ({
  toast: {
    error: (message: string) => {
      toastErrors.push(message);
    },
  },
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
  pageMeta = new Map([
    ['docs/team/notes', { docExt: '.md' }],
    ['docs/team/spec', { docExt: '.mdx' }],
    ['docs/team/readme', { docExt: '.txt' }],
  ]);
  lifecycleStatuses = new Map();
  toastErrors = [];
  dndContextProps.length = 0;
  sensorCalls.length = 0;
  sortableContextProps.length = 0;
  sortableOptions.length = 0;
  for (const fn of [
    activateTab,
    activateNewTab,
    closeAndClearForRename,
    closeNewTab,
    closeTab,
    closeTabs,
    getPoolActiveDocName,
    openNewTab,
    pinTab,
    reopenClosedTab,
    remapTabsForRename,
    reorderTabs,
    unpinTab,
  ]) {
    fn.mockClear();
  }
  closeAndClearForRename.mockImplementation(() => Promise.resolve());
  getPoolActiveDocName.mockImplementation(() => null);
  remapTabsForRename.mockImplementation(() => {});
  Object.defineProperty(window, 'okDesktop', {
    configurable: true,
    value: undefined,
  });
  window.location.hash = '';
  globalThis.fetch = mock(() => Promise.reject(new Error('unexpected fetch'))) as never;
}

async function renderEditorTabs() {
  const { EditorTabs } = await import('./EditorTabs');
  return render(<EditorTabs />);
}

function latestDndContext() {
  const latest = dndContextProps.at(-1);
  expect(latest).toBeDefined();
  return latest as DndContextProps;
}

function tabButton(name: string) {
  const button = screen
    .getAllByRole('button', { name })
    .find((element) => element.tagName === 'BUTTON' && !element.hasAttribute('data-sortable-id'));
  expect(button).toBeDefined();
  return button as HTMLButtonElement;
}

describe('EditorTabs runtime behavior', () => {
  beforeEach(() => {
    resetState();
  });

  afterEach(() => {
    cleanup();
  });

  test('renders markdown doc labels without extensions while preserving full-path accessible names and titles', async () => {
    await renderEditorTabs();

    const markdownTab = tabButton('docs/team/notes.md');
    expect(markdownTab.textContent).toBe('notes');
    expect(markdownTab.getAttribute('title')).toBe('docs/team/notes.md');
    expect(markdownTab.closest('[data-sortable-id]')?.getAttribute('aria-keyshortcuts')).toBe(
      'Meta+1 Control+1',
    );

    const mdxTab = tabButton('docs/team/spec.mdx');
    expect(mdxTab.textContent).toBe('spec');
    expect(mdxTab.getAttribute('title')).toBe('docs/team/spec.mdx');
    expect(mdxTab.closest('[data-sortable-id]')?.getAttribute('aria-current')).toBe('page');

    const txtTab = tabButton('docs/team/readme.txt');
    expect(txtTab.textContent).toBe('readme.txt');
    expect(txtTab.getAttribute('title')).toBe('docs/team/readme.txt');
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

  test('Electron host applies drag only to the strip root and no-drag to the content wrapper', async () => {
    Object.defineProperty(window, 'okDesktop', {
      configurable: true,
      value: {},
    });

    const { container } = await renderEditorTabs();
    const root = container.firstElementChild as HTMLElement;
    const wrapper = root.firstElementChild as HTMLElement;

    expect(root.getAttribute('data-electron-drag')).toBe('');
    expectVisualClassTokens(root.className, ['[-webkit-app-region:drag]']);
    expectVisualClassTokens(wrapper.className, [
      '[-webkit-app-region:no-drag]',
      'flex',
      'items-end',
      'gap-1',
    ]);
    expectVisualClassTokensAbsent(wrapper.className, ['flex-1']);
  });

  test('web host keeps baseline scroll layout without app-region classes', async () => {
    const { container } = await renderEditorTabs();
    const root = container.firstElementChild as HTMLElement;
    const wrapper = root.firstElementChild as HTMLElement;

    expect(root.getAttribute('data-electron-drag')).toBeNull();
    expectVisualClassTokens(root.className, ['overflow-x-auto', 'scroll-fade-mask-x']);
    expectVisualClassTokensAbsent(root.className, ['[-webkit-app-region:drag]']);
    expectVisualClassTokensAbsent(wrapper.className, ['[-webkit-app-region:no-drag]']);
  });

  test('wires sortable sensors, visible items, drag-end reorder, and the accessibility portal at runtime', async () => {
    await renderEditorTabs();

    expect(sensorCalls).toEqual([
      { sensor: pointerSensorToken, options: { activationConstraint: { distance: 8 } } },
      {
        sensor: keyboardSensorToken,
        options: {
          coordinateGetter: sortableKeyboardCoordinatesToken,
          keyboardCodes: {
            cancel: ['Escape'],
            end: ['Space', 'Enter'],
            start: ['Space'],
          },
        },
      },
    ]);
    expect(latestDndContext().accessibility?.container).toBe(document.body);
    expect(latestDndContext().sensors).toEqual(sensorCalls.map((call) => call));
    expect(sortableContextProps.at(-1)).toEqual({
      items: visibleTabIds,
      strategy: horizontalListSortingStrategyToken,
    });

    act(() => {
      latestDndContext().onDragEnd?.({
        active: { id: 'docs/team/readme' },
        over: { id: 'docs/team/notes' },
      });
    });

    expect(reorderTabs).toHaveBeenCalledWith(
      [
        'docs/team/readme',
        'docs/team/notes',
        'docs/team/spec',
        defaultTabs().folderId,
        defaultTabs().assetId,
        defaultTabs().newId,
      ],
      'docs/team/readme',
    );
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
    jest.useFakeTimers();
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
        jest.advanceTimersByTime(999);
      });

      expect(screen.queryAllByTestId('editor-tab-shortcut-hint')).toHaveLength(0);
      expectVisualClassTokens(
        screen.getByRole('button', { name: 'Close docs/team/notes.md' }).getAttribute('class'),
        ['pointer-events-none', 'opacity-0'],
      );

      act(() => {
        jest.advanceTimersByTime(1);
      });

      expect(
        screen.getAllByTestId('editor-tab-shortcut-hint').map((node) => node.textContent),
      ).toEqual(['⌘1', '⌘2', '⌘3', '⌘4', '⌘5', '⌘6']);
      expect(screen.queryByRole('button', { name: 'Close docs/team/notes.md' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Close new tab' })).toBeNull();

      fireEvent.blur(window);

      expect(screen.queryAllByTestId('editor-tab-shortcut-hint')).toHaveLength(0);
      expect(screen.getByRole('button', { name: 'Close docs/team/notes.md' })).toBeTruthy();

      fireEvent.keyDown(window, { key: 'Meta', metaKey: true });
      act(() => {
        jest.advanceTimersByTime(1000);
      });
      expect(screen.getAllByTestId('editor-tab-shortcut-hint')).toHaveLength(6);

      fireEvent.keyUp(window, { key: 'Meta' });

      expect(screen.queryAllByTestId('editor-tab-shortcut-hint')).toHaveLength(0);
      expect(screen.getByRole('button', { name: 'Close docs/team/notes.md' })).toBeTruthy();
    } finally {
      jest.useRealTimers();
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

  test('pin state changes close controls, menu actions, and middle-click behavior', async () => {
    pinnedTabIds = ['docs/team/readme'];
    await renderEditorTabs();

    fireEvent.click(screen.getByRole('button', { name: 'Close docs/team/notes.md' }));
    expect(closeTab).toHaveBeenCalledWith('docs/team/notes');

    const unpinButton = screen.getByRole('button', { name: 'Unpin docs/team/readme.txt' });
    expect(unpinButton.getAttribute('title')).toBeNull();
    expectVisualClassTokens(unpinButton.className, ['text-primary']);
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

  test('rename mode strips the file extension, disables sorting, reports invalid input, and keeps the extension addon', async () => {
    await renderEditorTabs();

    fireEvent.doubleClick(tabButton('docs/team/readme.txt'));

    const input = screen.getByTestId('editor-tab-rename-input') as HTMLInputElement;
    expect(input.value).toBe('readme');
    expect(screen.getByText('.txt')).toBeTruthy();
    expect(
      sortableOptions.some((options) => options.id === 'docs/team/readme' && options.disabled),
    ).toBe(true);

    fireEvent.change(input, { target: { value: 'bad/name.txt' } });
    expect(input.value).toBe('bad/name');
    fireEvent.keyDown(input, { key: 'Enter' });

    expect((await screen.findByRole('alert')).textContent).toBe(
      'Name can’t be empty, ".", "..", or contain / or \\',
    );
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  test('rename post-commit reconciliation failures surface the refresh toast and skip navigation', async () => {
    activeDocName = 'docs/team/readme';
    activeTabId = 'docs/team/readme';
    remapTabsForRename.mockImplementation(() => {
      throw new Error('idb clear failed');
    });
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            renamed: [{ fromDocName: 'docs/team/readme', toDocName: 'docs/team/renamed' }],
          }),
          { headers: { 'Content-Type': 'application/json' }, status: 200 },
        ),
      ),
    ) as never;

    await renderEditorTabs();
    fireEvent.doubleClick(tabButton('docs/team/readme.txt'));
    const input = screen.getByTestId('editor-tab-rename-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'renamed.txt' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(toastErrors).toContain(
        'Rename succeeded but the tabstrip may be out of date — refresh to resync',
      );
    });
    expect(toastErrors).not.toContain('Network error — please try again');
    expect(window.location.hash).toBe('');
  });

  test('tab context menus and active tab styling are visible behavior, not source-shape details', async () => {
    lifecycleStatuses.set('docs/team/notes', 'conflict');
    await renderEditorTabs();

    const conflictedTabButton = screen.getByRole('button', {
      name: 'docs/team/notes.md (conflict)',
    });
    expect(conflictedTabButton).toBeTruthy();
    expect(conflictedTabButton.getAttribute('title')).toBe('docs/team/notes.md (conflict)');
    expect(screen.getByTestId('editor-tab-conflict-badge').getAttribute('aria-hidden')).toBe(
      'true',
    );
    expect(screen.getAllByRole('menuitem', { name: 'Close' }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('menuitem', { name: 'Close others' }).length).toBeGreaterThan(0);
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
    expectVisualClassTokens(inactiveClose.className, ['mr-1.5']);

    const placeholderClose = screen.getByTestId('editor-new-tab-placeholder-close');
    expectVisualClassTokens(placeholderClose.className, [
      'pointer-events-none',
      'opacity-0',
      'group-hover:pointer-events-auto',
    ]);
  });
});

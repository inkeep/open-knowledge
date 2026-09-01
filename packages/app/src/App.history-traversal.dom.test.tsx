import { cleanup, render, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { ResolvedNavigationTarget } from '@/components/navigation-targets';
import {
  createEmptyEditorWorkspace,
  type EditorWorkspaceState,
  type TabOpenDisposition,
  transitionEditorWorkspace,
} from '@/editor/editor-panes';
import { tabIdForNavigationTarget } from '@/editor/editor-tabs';
import {
  hashFromDocName,
  hashFromSkillPreview,
  pushHashWithoutNavigation,
  type SkillPreviewHashTarget,
} from '@/lib/doc-hash';
import { __resetLocalMenuActionBusForTests } from '@/lib/local-menu-action-bus';

interface OpenOptions {
  disposition?: TabOpenDisposition;
  tabBehavior?: 'append' | 'replace-active';
  consumeActiveNewTab?: boolean;
}

const SKILL_PREVIEW: SkillPreviewHashTarget = {
  flavor: 'builtin',
  source: 'bundled/skills/project',
  name: 'project',
  subtitle: '',
  level: 'project',
};

function previewTarget(preview: SkillPreviewHashTarget): ResolvedNavigationTarget {
  return {
    kind: 'skill-preview',
    target: `${preview.flavor}/${preview.source}/${preview.name}`,
    ...preview,
  };
}

const SKILL_PREVIEW_TARGET = previewTarget(SKILL_PREVIEW);

const EXPLORE_PREVIEW: SkillPreviewHashTarget = {
  flavor: 'explore',
  source: 'inkeep/open-knowledge-skills',
  name: 'trip-log',
  subtitle: 'inkeep/open-knowledge-skills',
  level: 'project',
};

const SKILL_PREVIEW_TAB_ID = tabIdForNavigationTarget(SKILL_PREVIEW_TARGET);
const EXPLORE_PREVIEW_TAB_ID = tabIdForNavigationTarget(previewTarget(EXPLORE_PREVIEW));

let workspace: EditorWorkspaceState = createEmptyEditorWorkspace();

function focusedPane() {
  const found = workspace.panes.find((candidate) => candidate.id === workspace.focusedPaneId);
  if (!found) throw new Error('no focused pane');
  return found;
}

function openTabIds(): string[] {
  return [...focusedPane().openTabs];
}

function previewTabId(): string | null {
  return focusedPane().previewTabId;
}

function activePreviewPath(): string | undefined {
  const target = focusedPane().activeTarget;
  if (target?.kind !== 'skill-preview') throw new Error('no skill preview is active');
  return target.path;
}

function applyOpen(target: ResolvedNavigationTarget, options: OpenOptions = {}) {
  const tabId = tabIdForNavigationTarget(target);
  if (!tabId) throw new Error(`no tab id for ${target.target}`);
  const transition = transitionEditorWorkspace(workspace, {
    type: 'open-target',
    paneId: workspace.focusedPaneId,
    tabId,
    target,
    disposition:
      options.disposition ?? (options.tabBehavior === 'replace-active' ? 'preview' : 'permanent'),
    consumeActiveNewTab: options.consumeActiveNewTab ?? true,
    existingTabBehavior: 'activate-owner',
  });
  workspace = transition.workspace;
}

function clickDocRow(docName: string, previewTabsEnabled: boolean) {
  applyOpen(
    { kind: 'doc', target: docName, docName },
    {
      disposition: previewTabsEnabled ? 'preview' : 'permanent',
      consumeActiveNewTab: true,
    },
  );
  pushHashWithoutNavigation(hashFromDocName(docName));
}

function clickSkillPreviewRow(preview: SkillPreviewHashTarget, previewTabsEnabled: boolean) {
  applyOpen(previewTarget(preview), {
    tabBehavior: previewTabsEnabled ? 'replace-active' : 'append',
  });
  pushHashWithoutNavigation(hashFromSkillPreview(preview));
}

let pages = new Set<string>();
let mergedConfig: { editor: { previewTabs: boolean } } | null = null;

vi.doMock('@/lib/perf', () => ({
  mark: () => {},
  ProfilerBoundary: ({ children }: { children: ReactNode }) => children,
}));

vi.doMock('@/editor/DocumentContext', () => ({
  DocumentProvider: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  useDocumentContext: () => ({
    activeDocName:
      focusedPane().activeTarget?.kind === 'doc' ? focusedPane().activeTarget?.target : null,
    activeTabId: focusedPane().activeTabId,
    activeTarget: focusedPane().activeTarget,
    clearTarget: () => {},
    promoteAllPreviewTabs: () => {},
    syncOpenTabsWithKnownTargets: () => {},
    tabSessionLoaded: true,
    openTabs: openTabIds(),
    closeDocument: () => {},
  }),
  useDocumentTransition: () => ({
    openTargetTransition: (target: ResolvedNavigationTarget, options?: OpenOptions) =>
      applyOpen(target, options),
  }),
}));

vi.doMock('@/components/PageListContext', () => {
  const list = () => ({
    assetPaths: new Set<string>(),
    filePaths: new Set<string>(),
    folderPaths: new Set<string>(),
    loading: false,
    pageMeta: new Map<string, unknown>(),
    pages,
    pagesBySlug: new Map<string, unknown>(),
    pagesByBasename: new Map<string, unknown>(),
  });
  return {
    PageListProvider: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    usePageList: list,
    useOptionalPageList: list,
  };
});

vi.doMock('@/components/navigation-targets', () => ({
  resolveNavigationTarget: (docName: string) => ({
    kind: 'doc' as const,
    target: docName,
    docName,
  }),
  downgradeFolderIndexForHashNav: (target: ResolvedNavigationTarget) => target,
  withLargeFileOpenGuard: (target: ResolvedNavigationTarget) => target,
}));

vi.doMock('@/lib/config-provider', () => ({
  ConfigProvider: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  useConfigContext: () => ({ merged: mergedConfig }),
}));
vi.doMock('@/lib/config-context', () => ({
  useConfigContext: () => ({ merged: mergedConfig }),
}));
vi.doMock('@/lib/api-config', () => ({
  fetchApiConfig: () =>
    Promise.resolve({
      status: 'ok' as const,
      config: { collabUrl: null, previewUrl: null, port: 0, singleFile: false },
    }),
}));
vi.doMock('@/lib/use-server-keepalive', () => ({ useServerKeepalive: () => {} }));
vi.doMock('@/lib/single-file-mode', () => ({
  SingleFileModeProvider: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  useSingleFileMode: () => false,
}));
vi.doMock('@/components/ConnectingBanner', () => ({ ConnectingBanner: () => null }));
vi.doMock('@/components/SystemDocSubscriber', () => ({ SystemDocSubscriber: () => null }));
vi.doMock('@/editor/EditorLifecycleFlush', () => ({ EditorLifecycleFlush: () => null }));
vi.doMock('@/editor/BackgroundThrottleReporter', () => ({
  BackgroundThrottleReporter: () => null,
}));
vi.doMock('@/components/McpConsentDialog', () => ({ McpConsentDialog: () => null }));
vi.doMock('@/components/CommandPalette', () => ({ CommandPalette: () => null }));
vi.doMock('@/components/AuthModal', () => ({ AuthModal: () => null }));
vi.doMock('@/components/InstallInClaudeDesktopDialog', () => ({
  InstallInClaudeDesktopDialog: () => null,
}));
vi.doMock('@/components/CreateProjectMenuTrigger', () => ({
  CreateProjectMenuTrigger: () => null,
}));
vi.doMock('@/components/ReportBugMenuTrigger', () => ({ ReportBugMenuTrigger: () => null }));
vi.doMock('@/components/FeedbackMenuTrigger', () => ({ FeedbackMenuTrigger: () => null }));
vi.doMock('@/components/ShareBranchSwitchDialog', () => ({ ShareBranchSwitchDialog: () => null }));
vi.doMock('@/components/ShareReceiveMissDialog', () => ({ ShareReceiveMissDialog: () => null }));
vi.doMock('@/components/NewItemDialog', () => ({
  isNewItemShortcut: () => false,
  NewItemDialog: () => null,
}));
vi.doMock('@/components/FileSidebar', () => ({ FileSidebar: () => null }));
vi.doMock('@/components/EditorPane', () => ({ EditorPane: () => <main /> }));
vi.doMock('@/components/ui/sidebar', () => ({
  SidebarProvider: ({ children }: { children: ReactNode }) => <section>{children}</section>,
  SidebarInset: ({ children }: { children: ReactNode }) => <section>{children}</section>,
}));
vi.doMock('@/components/ShareReceiveDialog', () => ({ ShareReceiveDialog: () => null }));
vi.doMock('@/lib/share/clone-controller', () => ({ createCloneController: () => ({}) }));
vi.doMock('@/lib/transports/auth-query-transport', () => ({ httpAuthQueryTransport: () => ({}) }));
vi.doMock('@/lib/transports/clone-transport', () => ({ httpCloneTransport: () => ({}) }));

const { App } = await import('./App');

describe('history traversal and the preview tab slot', () => {
  beforeEach(() => {
    workspace = createEmptyEditorWorkspace();
    pages = new Set(['page-a', 'page-b', 'page-c']);
    mergedConfig = { editor: { previewTabs: true } };
    window.history.replaceState(null, '', window.location.pathname);
    globalThis.fetch = vi.fn(() => Promise.resolve(new Response(null, { status: 204 }))) as never;
  });

  afterEach(() => {
    cleanup();
    __resetLocalMenuActionBusForTests();
    vi.restoreAllMocks();
  });

  test('three sidebar preview clicks keep the strip at one tab', async () => {
    const view = render(<App />);
    for (const doc of ['page-a', 'page-b', 'page-c']) {
      clickDocRow(doc, true);
      view.rerender(<App />);
    }
    await waitFor(() => expect(window.location.hash).toBe('#/page-c'));

    expect(openTabIds()).toEqual(['page-c']);
    expect(previewTabId()).toBe('page-c');
  });

  test('back to a doc opened as a preview reuses the preview slot instead of appending', async () => {
    const view = render(<App />);
    for (const doc of ['page-a', 'page-b', 'page-c']) {
      clickDocRow(doc, true);
      view.rerender(<App />);
    }
    expect(openTabIds()).toEqual(['page-c']);

    window.history.back();
    await waitFor(() => expect(window.location.hash).toBe('#/page-b'));
    view.rerender(<App />);

    await waitFor(() => expect(openTabIds()).toEqual(['page-b']));
    expect(previewTabId()).toBe('page-b');

    window.history.back();
    await waitFor(() => expect(window.location.hash).toBe('#/page-a'));
    view.rerender(<App />);

    await waitFor(() => expect(openTabIds()).toEqual(['page-a']));
    expect(previewTabId()).toBe('page-a');
  });

  test('a re-render between a traversal popstate and its hashchange reuses the preview slot', async () => {
    const view = render(<App />);
    for (const doc of ['page-a', 'page-b', 'page-c']) {
      clickDocRow(doc, true);
      view.rerender(<App />);
    }
    expect(openTabIds()).toEqual(['page-c']);

    const rerenderMidTraversal = () => {
      window.removeEventListener('popstate', rerenderMidTraversal);
      view.rerender(<App />);
    };
    window.addEventListener('popstate', rerenderMidTraversal);

    window.history.back();
    await waitFor(() => expect(window.location.hash).toBe('#/page-b'));
    view.rerender(<App />);

    await waitFor(() => expect(openTabIds()).toEqual(['page-b']));
    expect(previewTabId()).toBe('page-b');

    clickDocRow('page-c', true);
    view.rerender(<App />);
    await waitFor(() => expect(openTabIds()).toEqual(['page-c']));
  });

  test('a skill preview stays one reusable tab across a click away and back', async () => {
    const view = render(<App />);

    clickSkillPreviewRow(SKILL_PREVIEW, true);
    view.rerender(<App />);
    await waitFor(() => expect(openTabIds()).toEqual([SKILL_PREVIEW_TAB_ID]));

    clickDocRow('page-a', true);
    view.rerender(<App />);
    await waitFor(() => expect(openTabIds()).toEqual(['page-a']));

    window.history.back();
    await waitFor(() => expect(window.location.hash).toBe(hashFromSkillPreview(SKILL_PREVIEW)));
    view.rerender(<App />);

    await waitFor(() => expect(openTabIds()).toEqual([SKILL_PREVIEW_TAB_ID]));
    expect(previewTabId()).toBe(SKILL_PREVIEW_TAB_ID);
  });

  test('a bundle file clicked inside a preview moves the selection on the same tab', async () => {
    const view = render(<App />);

    clickSkillPreviewRow(EXPLORE_PREVIEW, true);
    view.rerender(<App />);
    await waitFor(() => expect(openTabIds()).toEqual([EXPLORE_PREVIEW_TAB_ID]));
    expect(activePreviewPath()).toBeUndefined();

    window.location.hash = hashFromSkillPreview({
      ...EXPLORE_PREVIEW,
      path: 'references/gear.md',
    });

    await waitFor(() => expect(activePreviewPath()).toBe('references/gear.md'));
    view.rerender(<App />);
    expect(openTabIds()).toEqual([EXPLORE_PREVIEW_TAB_ID]);
  });

  test('back to a doc whose tab is still open activates it without appending', async () => {
    mergedConfig = { editor: { previewTabs: false } };
    const view = render(<App />);

    clickDocRow('page-a', false);
    view.rerender(<App />);
    clickDocRow('page-b', false);
    view.rerender(<App />);
    expect(openTabIds()).toEqual(['page-a', 'page-b']);

    window.history.back();
    await waitFor(() => expect(window.location.hash).toBe('#/page-a'));
    view.rerender(<App />);

    expect(openTabIds()).toEqual(['page-a', 'page-b']);
  });

  test('with preview tabs off, back to a closed doc appends instead of taking a slot', async () => {
    const view = render(<App />);

    clickDocRow('page-a', true);
    view.rerender(<App />);
    clickDocRow('page-b', true);
    view.rerender(<App />);
    expect(openTabIds()).toEqual(['page-b']);

    mergedConfig = { editor: { previewTabs: false } };
    view.rerender(<App />);

    window.history.back();
    await waitFor(() => expect(window.location.hash).toBe('#/page-a'));
    view.rerender(<App />);

    await waitFor(() => expect(openTabIds()).toEqual(['page-b', 'page-a']));
    expect(previewTabId()).toBe('page-b');
  });
});

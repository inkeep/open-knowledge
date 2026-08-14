/**
 * History traversal must not upgrade a previewed tab into a permanent one.
 *
 * The sibling `App.dom.test.tsx` mocks the document context wholesale, so it can
 * only observe the disposition ARGUMENT the hash handler passes. That is blind
 * to what actually goes wrong here: the argument is one input to the tab
 * reducer, and what the user sees is the tab SET the reducer produces. So the
 * handler runs here against the real reducer, the real tab-id derivation, the
 * real hash writer, and jsdom's real History — and every assertion reads the
 * state the editor renders from: the tab list, and the pane's active target.
 *
 * One step is modeled: the document context's forwarding of (target, options)
 * into the reducer command, transcribed from `openTargetWithOptions` including
 * its disposition default. The real one needs a live collab provider pool,
 * which cannot exist in jsdom. That transcription is this file's only drift
 * risk, and the pair that closes it is
 * `tests/stress/history-traversal-preview-tab.e2e.ts`, which runs the same
 * journey in a real browser with nothing modeled.
 *
 * Fidelity limit worth knowing before reading a failure here: jsdom implements
 * `popstate`/`event.state` but not the Navigation API, so this tier can only
 * exercise a traversal classifier built on the former. The real-browser pair
 * above is the one that is agnostic to which signal the handler reads.
 */

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

/** The target the hash handler builds for a preview hash. Its `target` string is
 *  the identity coordinates only — no selected file, same as the tab id. */
function previewTarget(preview: SkillPreviewHashTarget): ResolvedNavigationTarget {
  return {
    kind: 'skill-preview',
    target: `${preview.flavor}/${preview.source}/${preview.name}`,
    ...preview,
  };
}

const SKILL_PREVIEW_TARGET = previewTarget(SKILL_PREVIEW);

// An un-imported skill: its bundle-file chips select in place on the preview
// rather than opening a skill-file tab, so they are the surface that moves a
// preview's selection without changing its tab.
const EXPLORE_PREVIEW: SkillPreviewHashTarget = {
  flavor: 'explore',
  source: 'inkeep/open-knowledge-skills',
  name: 'trip-log',
  subtitle: 'inkeep/open-knowledge-skills',
  level: 'project',
};

// Derived, never spelled out: a skill-preview tab id is NUL-prefixed and its
// segments are percent-encoded.
const SKILL_PREVIEW_TAB_ID = tabIdForNavigationTarget(SKILL_PREVIEW_TARGET);
const EXPLORE_PREVIEW_TAB_ID = tabIdForNavigationTarget(previewTarget(EXPLORE_PREVIEW));

// ----------------------------------------------------------------- real state

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

/** The bundle file the active preview shows — what `EditorArea` hands
 *  `SkillPreviewTab` as its `path`. */
function activePreviewPath(): string | undefined {
  const target = focusedPane().activeTarget;
  if (target?.kind !== 'skill-preview') throw new Error('no skill preview is active');
  return target.path;
}

/**
 * Transcription of `DocumentContext.openTargetWithOptions`' command
 * construction, down to the disposition default and the `activate-owner`
 * default for an already-open tab. Everything it calls is the real thing.
 */
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

/** What the Files tree does for a document row: open, then record the hash. */
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

/** What the Skills tree does for a read-only preview row. */
function clickSkillPreviewRow(preview: SkillPreviewHashTarget, previewTabsEnabled: boolean) {
  applyOpen(previewTarget(preview), {
    tabBehavior: previewTabsEnabled ? 'replace-active' : 'append',
  });
  pushHashWithoutNavigation(hashFromSkillPreview(preview));
}

// ---------------------------------------------------------------------- mocks

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
    // The control, and the guard on the handler's forward-path re-entry: the
    // effect re-runs on every tab-state change and re-enters the hash handler
    // with the hash the click just pushed. That self-echo must stay a no-op.
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

    // `page-b` was provisional when its history entry was recorded — the click
    // after it took the slot back. Replaying that entry must not durably grow
    // the strip.
    await waitFor(() => expect(openTabIds()).toEqual(['page-b']));
    expect(previewTabId()).toBe('page-b');

    window.history.back();
    await waitFor(() => expect(window.location.hash).toBe('#/page-a'));
    view.rerender(<App />);

    await waitFor(() => expect(openTabIds()).toEqual(['page-a']));
    expect(previewTabId()).toBe('page-a');
  });

  test('a re-render between a traversal popstate and its hashchange reuses the preview slot', async () => {
    // Engines dispatch popstate inside the traversal itself and queue
    // hashchange as a later task, so whatever else is already queued runs
    // between them — including React flushing a pending render, which
    // re-subscribes this effect and re-enters the hash sync while the traversal
    // is still in flight. That re-entry reads the same replay the hashchange is
    // about to read, and if it retires the signal that marks it a replay, the
    // hashchange behind it sees a fresh navigation and promotes the tab.
    //
    // jsdom fires the pair back to back, so the gap is opened here by a
    // popstate listener registered after the handler's own. Everything it
    // triggers is the real thing; only its timing is arranged.
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

    // What losing the slot costs the user: the next sidebar click appends
    // beside `page-b` instead of taking its place.
    clickDocRow('page-c', true);
    view.rerender(<App />);
    await waitFor(() => expect(openTabIds()).toEqual(['page-c']));
  });

  test('a skill preview stays one reusable tab across a click away and back', async () => {
    // The hash handler's second open site. It routes through the same
    // `openHashTarget` the document path uses, so it inherits both the identity
    // guard that absorbs the forward re-entry and the disposition a replay
    // re-derives. This journey is what holds those consistent across the two
    // branches: a skill preview has to come back from Back into the slot it
    // left, exactly as a document does.
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
    // A preview tab is deliberately one tab for the whole bundle: its id and its
    // target string both drop the selected file so the tab is reused as the
    // selection moves. That makes the selection invisible to a same-tab check,
    // and the hash handler runs one — so the hash a chip click writes has to
    // reach the pane anyway, or the preview keeps rendering the file the user
    // just navigated away from while the URL says otherwise.
    const view = render(<App />);

    clickSkillPreviewRow(EXPLORE_PREVIEW, true);
    view.rerender(<App />);
    await waitFor(() => expect(openTabIds()).toEqual([EXPLORE_PREVIEW_TAB_ID]));
    expect(activePreviewPath()).toBeUndefined();

    // What a FILES chip does on an un-imported skill: rewrite the hash with the
    // clicked file, changing nothing else about the target.
    window.location.hash = hashFromSkillPreview({
      ...EXPLORE_PREVIEW,
      path: 'references/gear.md',
    });

    await waitFor(() => expect(activePreviewPath()).toBe('references/gear.md'));
    view.rerender(<App />);
    // Still the one tab it started as — the selection moved, the tab did not.
    expect(openTabIds()).toEqual([EXPLORE_PREVIEW_TAB_ID]);
  });

  test('back to a doc whose tab is still open activates it without appending', async () => {
    // With preview tabs off every click keeps its own tab, so the doc a replay
    // lands on is already open and takes the activate-existing branch. Nothing
    // about restoring traversal semantics may change that.
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
    // The disposition-sensitive half of the preview-tabs-off contract. The
    // sibling above lands on a doc whose tab is still open, where the reducer
    // ignores the disposition outright — so it reads the same whether a replay
    // asks for a preview or a permanent tab. A closed target is the only shape
    // where those two answers diverge.
    //
    // Appending is the answer that has to hold: nothing promotes a preview tab
    // back once the setting is already off, so a replay that claimed the
    // preview slot would strand an evictable tab in a configuration that is
    // supposed to have none.
    //
    // Evicting `page-a` takes preview clicks, hence the flip between the clicks
    // and the traversal rather than a `previewTabs: false` run throughout.
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
    // The slot `page-b` still holds is left alone; the replay claims no slot of
    // its own.
    expect(previewTabId()).toBe('page-b');
  });
});

import { describe, expect, test } from 'bun:test';
import {
  buildViewMenuStateDeps,
  createDefaultEditorViewMenuState,
  mergeViewMenuState,
} from './view-menu-state';

describe('mergeViewMenuState — multi-publisher non-clobbering contract', () => {
  const initial = {
    showHiddenFiles: false,
    showOkFolders: false,
    showOnlyMarkdownFiles: false,
    showSkillsSection: true,
    canExpandAll: true,
    canCollapseAll: true,
    sidebarVisible: true,
    docPanelVisible: true,
  } as const;

  test('EditorArea push (docPanelVisible only) preserves FileSidebar fields', () => {
    const afterFileSidebar = mergeViewMenuState(initial, {
      showHiddenFiles: true,
      canExpandAll: false,
      canCollapseAll: false,
      sidebarVisible: false,
    });

    const afterEditorArea = mergeViewMenuState(afterFileSidebar, {
      docPanelVisible: false,
    });

    expect(afterEditorArea).toEqual({
      showHiddenFiles: true,
      showOkFolders: false,
      showOnlyMarkdownFiles: false,
      showSkillsSection: true,
      canExpandAll: false,
      canCollapseAll: false,
      sidebarVisible: false,
      docPanelVisible: false,
    });
  });

  test('FileSidebar visibility push (all four toggles) preserves the terminal + doc-panel fields', () => {
    const base = createDefaultEditorViewMenuState();
    const afterTerminal = mergeViewMenuState(base, { terminalVisible: true, terminalLive: true });

    const afterVisibilityPush = mergeViewMenuState(afterTerminal, {
      showHiddenFiles: true,
      showOkFolders: true,
      showOnlyMarkdownFiles: true,
      showSkillsSection: false,
    });

    expect(afterVisibilityPush).toEqual({
      ...base,
      terminalVisible: true,
      terminalLive: true,
      showHiddenFiles: true,
      showOkFolders: true,
      showOnlyMarkdownFiles: true,
      showSkillsSection: false,
    });
  });

  test('FileSidebar push (5 fields) preserves EditorArea docPanelVisible', () => {
    const afterEditorArea = mergeViewMenuState(initial, {
      docPanelVisible: false,
    });

    const afterFileSidebar = mergeViewMenuState(afterEditorArea, {
      showHiddenFiles: true,
      canExpandAll: false,
      canCollapseAll: true,
      sidebarVisible: false,
    });

    expect(afterFileSidebar.docPanelVisible).toBe(false);
    expect(afterFileSidebar.showHiddenFiles).toBe(true);
    expect(afterFileSidebar.sidebarVisible).toBe(false);
  });

  test('EditorPane push (terminalVisible only) preserves the sidebar + doc-panel fields', () => {
    const afterFileSidebar = mergeViewMenuState(initial, {
      showHiddenFiles: true,
      sidebarVisible: false,
    });
    const afterEditorArea = mergeViewMenuState(afterFileSidebar, { docPanelVisible: false });

    const afterEditorPane = mergeViewMenuState(afterEditorArea, { terminalVisible: true });

    expect(afterEditorPane.terminalVisible).toBe(true);
    expect(afterEditorPane.docPanelVisible).toBe(false);
    expect(afterEditorPane.sidebarVisible).toBe(false);
    expect(afterEditorPane.showHiddenFiles).toBe(true);
  });

  test('TerminalDock push (terminalLive only) composes with the other publishers without clobbering', () => {
    // TerminalDock is the third runtime publisher into the merged menu state
    // (terminalLive, the Kill-Terminal enablement signal). Its push must not
    // clobber EditorPane's terminalVisible or the sidebar/doc-panel fields, and
    // a later terminalVisible push must not clobber terminalLive.
    const afterEditorPane = mergeViewMenuState(initial, { terminalVisible: true });
    const afterTerminalDock = mergeViewMenuState(afterEditorPane, { terminalLive: true });

    expect(afterTerminalDock.terminalLive).toBe(true);
    expect(afterTerminalDock.terminalVisible).toBe(true);
    expect(afterTerminalDock.docPanelVisible).toBe(true);
    expect(afterTerminalDock.sidebarVisible).toBe(true);

    // Reverse direction: a subsequent terminalVisible push preserves terminalLive.
    const afterToggleHide = mergeViewMenuState(afterTerminalDock, { terminalVisible: false });
    expect(afterToggleHide.terminalLive).toBe(true);
    expect(afterToggleHide.terminalVisible).toBe(false);
  });
});

describe('createDefaultEditorViewMenuState — pre-first-push menu state', () => {
  test("matches the renderer's resolved config defaults exactly", () => {
    // toEqual on the full object: adding a snapshot field without deciding
    // its pre-push default must fail here, not silently read undefined.
    expect(createDefaultEditorViewMenuState()).toEqual({
      showHiddenFiles: false,
      showOkFolders: false,
      showOnlyMarkdownFiles: false,
      showSkillsSection: true,
      canExpandAll: true,
      canCollapseAll: true,
      sidebarVisible: true,
      docPanelVisible: true,
      terminalVisible: false,
      terminalLive: false,
    });
  });
});

describe('buildViewMenuStateDeps — snapshot → menu-deps wiring', () => {
  // Every field deliberately differs from the pre-push default so an
  // accidental default-instead-of-snapshot read fails the mapping assertions.
  const snapshot = {
    showHiddenFiles: true,
    showOkFolders: true,
    showOnlyMarkdownFiles: true,
    showSkillsSection: false,
    canExpandAll: false,
    canCollapseAll: false,
    sidebarVisible: false,
    docPanelVisible: false,
    terminalVisible: true,
    terminalLive: true,
  } as const;

  test('maps every snapshot field onto its menu dep', () => {
    const deps = buildViewMenuStateDeps(snapshot, () => {});
    expect(deps.showHiddenFilesChecked).toBe(true);
    expect(deps.showOkFoldersChecked).toBe(true);
    expect(deps.showOnlyMarkdownFilesChecked).toBe(true);
    expect(deps.showSkillsSectionChecked).toBe(false);
    expect(deps.canExpandAll).toBe(false);
    expect(deps.canCollapseAll).toBe(false);
    expect(deps.sidebarVisible).toBe(false);
    expect(deps.docPanelVisible).toBe(false);
    expect(deps.terminalVisible).toBe(true);
    expect(deps.terminalLive).toBe(true);
  });

  test('each toggle / tree / terminal handler dispatches its menu-action ID', () => {
    const dispatched: string[] = [];
    const deps = buildViewMenuStateDeps(createDefaultEditorViewMenuState(), (action) => {
      dispatched.push(action);
    });

    deps.onToggleShowHiddenFiles?.();
    deps.onToggleShowOkFolders?.();
    deps.onToggleShowOnlyMarkdownFiles?.();
    deps.onToggleShowSkillsSection?.();
    deps.onToggleSidebar?.();
    deps.onToggleDocPanel?.();
    deps.onToggleTerminal?.();
    deps.onNewTerminal?.();
    deps.onKillTerminal?.();
    deps.onExpandAll?.();
    deps.onCollapseAll?.();

    expect(dispatched).toEqual([
      'toggle-show-hidden-files',
      'toggle-show-ok-folders',
      'toggle-show-only-markdown-files',
      'toggle-show-skills-section',
      'toggle-sidebar',
      'toggle-doc-panel',
      'toggle-terminal',
      'new-terminal',
      'kill-terminal',
      'expand-all-tree',
      'collapse-all-tree',
    ]);
  });
});

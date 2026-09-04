import { describe, expect, test } from 'vitest';
import {
  buildViewMenuStateDeps,
  createDefaultEditorViewMenuState,
  EditorViewMenuStateRegistry,
  mergeViewMenuState,
} from './view-menu-state';

describe('EditorViewMenuStateRegistry — focused-window ownership', () => {
  test('keeps two window snapshots independent and selects the focused one', () => {
    const registry = new EditorViewMenuStateRegistry();
    registry.update(11, { terminalPlacement: 'bottom', terminalVisible: true });
    registry.update(22, { terminalPlacement: 'right', terminalVisible: false });

    registry.select(11);
    expect(registry.current().terminalPlacement).toBe('bottom');
    expect(registry.current().terminalVisible).toBe(true);

    registry.select(22);
    expect(registry.current().terminalPlacement).toBe('right');
    expect(registry.current().terminalVisible).toBe(false);
  });

  test('deleting a closed selected window falls back to safe defaults', () => {
    const registry = new EditorViewMenuStateRegistry();
    registry.update(11, { terminalPlacement: 'right', terminalVisible: true });
    registry.select(11);
    registry.delete(11);

    expect(registry.current()).toEqual(createDefaultEditorViewMenuState());
  });
});

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
    const afterEditorPane = mergeViewMenuState(initial, { terminalVisible: true });
    const afterTerminalDock = mergeViewMenuState(afterEditorPane, { terminalLive: true });

    expect(afterTerminalDock.terminalLive).toBe(true);
    expect(afterTerminalDock.terminalVisible).toBe(true);
    expect(afterTerminalDock.docPanelVisible).toBe(true);
    expect(afterTerminalDock.sidebarVisible).toBe(true);

    const afterToggleHide = mergeViewMenuState(afterTerminalDock, { terminalVisible: false });
    expect(afterToggleHide.terminalLive).toBe(true);
    expect(afterToggleHide.terminalVisible).toBe(false);
  });

  test('agents-panel push composes with every terminal publisher without clobbering', () => {
    const afterEditorPane = mergeViewMenuState(initial, { terminalVisible: true });
    const afterTerminalDock = mergeViewMenuState(afterEditorPane, { terminalLive: true });
    const afterAgentsPanel = mergeViewMenuState(afterTerminalDock, { agentPanelVisible: true });

    expect(afterAgentsPanel.agentPanelVisible).toBe(true);
    expect(afterAgentsPanel.terminalVisible).toBe(true);
    expect(afterAgentsPanel.terminalLive).toBe(true);
    expect(afterAgentsPanel.sidebarVisible).toBe(true);

    const afterHideTerminal = mergeViewMenuState(afterAgentsPanel, { terminalVisible: false });
    expect(afterHideTerminal.agentPanelVisible).toBe(true);
    expect(afterHideTerminal.terminalVisible).toBe(false);

    const afterHideAgents = mergeViewMenuState(afterAgentsPanel, { agentPanelVisible: false });
    expect(afterHideAgents.agentPanelVisible).toBe(false);
    expect(afterHideAgents.terminalVisible).toBe(true);
    expect(afterHideAgents.terminalLive).toBe(true);
  });
});

describe('createDefaultEditorViewMenuState — pre-first-push menu state', () => {
  test("matches the renderer's resolved config defaults exactly", () => {
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
      terminalPlacement: 'bottom',
      terminalLive: false,
      agentPanelVisible: false,
      canViewInSource: false,
      hasEditorSelection: false,
    });
  });
});

describe('buildViewMenuStateDeps — snapshot → menu-deps wiring', () => {
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
    terminalPlacement: 'right',
    terminalLive: true,
    agentPanelVisible: true,
    hasEditorSelection: true,
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
    expect(deps.terminalPlacement).toBe('right');
    expect(deps.terminalLive).toBe(true);
    expect(deps.agentPanelVisible).toBe(true);
    expect(deps.hasEditorSelection).toBe(true);
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
    deps.onMoveTerminal?.();
    deps.onToggleAgentPanel?.();
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
      'move-terminal',
      'toggle-agent-panel',
      'new-terminal',
      'kill-terminal',
      'expand-all-tree',
      'collapse-all-tree',
    ]);
  });
});

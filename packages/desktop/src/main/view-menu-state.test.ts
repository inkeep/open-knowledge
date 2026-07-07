import { describe, expect, test } from 'bun:test';
import { mergeViewMenuState } from './view-menu-state';

describe('mergeViewMenuState — multi-publisher non-clobbering contract', () => {
  const initial = {
    showHiddenFiles: false,
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
      canExpandAll: false,
      canCollapseAll: false,
      sidebarVisible: false,
      docPanelVisible: false,
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

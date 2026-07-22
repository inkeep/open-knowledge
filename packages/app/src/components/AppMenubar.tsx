/**
 * Custom-drawn Windows/Linux menu bar (the windows-linux-port renderer-menubar decision).
 *
 * macOS keeps the native menu bar; on Windows/Linux the window is frameless
 * (`titleBarStyle: 'hidden'` + window-controls overlay), so the menu bar is
 * drawn here, VS Code-style, inside the chrome row. Every click routes to
 * the main process over the single `bridge.menu.dispatch` channel — menu
 * SEMANTICS stay main-side and single-sourced with the native template
 * (`menu.ts`); this component only renders.
 *
 * Keyboard accelerators are NOT bound here: the hidden native application
 * menu keeps them registered OS-side, so shortcuts work without the DOM
 * menubar focused. The `MenubarShortcut` strings are display-only hints.
 *
 * Enable/check state comes from the `query` dispatch — the same aggregated
 * snapshot (active target + view-menu state + recents + capability flags)
 * that drives the native menu's rendering — refreshed each time a menu
 * opens, so it is at most one open stale.
 *
 * The Terminal menu is deliberately absent: the pty-backed dock is dark on
 * Windows/Linux (`config.ptyAvailable`), and every Terminal item is
 * pty-scoped. Re-add it from the native template if node-pty ever ships
 * off-mac.
 */

import { useLingui } from '@lingui/react/macro';
import { useState } from 'react';
import {
  Menubar,
  MenubarCheckboxItem,
  MenubarContent,
  MenubarItem,
  MenubarMenu,
  MenubarSeparator,
  MenubarShortcut,
  MenubarSub,
  MenubarSubContent,
  MenubarSubTrigger,
  MenubarTrigger,
} from '@/components/ui/menubar';
import type {
  OkDesktopBridge,
  OkMenuDispatchRequest,
  OkMenuRendererSnapshot,
} from '@/lib/desktop-bridge-types';

export function AppMenubar() {
  const { t } = useLingui();
  const bridge = typeof window !== 'undefined' ? (window.okDesktop ?? null) : null;
  const [snapshot, setSnapshot] = useState<OkMenuRendererSnapshot | null>(null);

  if (bridge == null || bridge.menu == null || bridge.platform === 'darwin') return null;
  const menu: NonNullable<OkDesktopBridge['menu']> = bridge.menu;
  const isWindows = bridge.platform === 'win32';

  const dispatch = (request: OkMenuDispatchRequest): void => {
    void menu.dispatch(request).catch(() => {
      // A torn-down window (or a main older than this renderer) has no
      // handler — the click degrades to a no-op, matching the native
      // menu's behavior when a dep is unwired.
    });
  };

  const refreshSnapshot = (): void => {
    menu
      .dispatch({ kind: 'query' })
      .then((next) => setSnapshot(next ?? null))
      .catch(() => setSnapshot(null));
  };

  const activeKind = snapshot?.activeTarget.kind ?? null;
  const view = snapshot?.viewMenuState;
  const revealLabel = isWindows ? t`Show in Explorer` : t`Show in File Manager`;

  return (
    <Menubar
      data-testid="app-menubar"
      // Chrome-row treatment: borderless and compact (the shadcn default is
      // a bordered island), and clickable inside the drag region.
      className="h-auto rounded-none border-0 bg-transparent p-0 shadow-none [-webkit-app-region:no-drag]"
      onValueChange={(value) => {
        if (value) refreshSnapshot();
      }}
    >
      <MenubarMenu>
        <MenubarTrigger className="px-2 py-1 text-xs font-normal">{t`File`}</MenubarTrigger>
        <MenubarContent>
          <MenubarItem onSelect={() => dispatch({ kind: 'menu-action', action: 'new-doc' })}>
            {t`New file`}
            <MenubarShortcut>Ctrl+N</MenubarShortcut>
          </MenubarItem>
          <MenubarItem onSelect={() => dispatch({ kind: 'menu-action', action: 'new-folder' })}>
            {t`New folder`}
            <MenubarShortcut>Ctrl+Shift+N</MenubarShortcut>
          </MenubarItem>
          <MenubarItem
            onSelect={() => dispatch({ kind: 'menu-action', action: 'new-from-template' })}
          >
            {t`New from Template…`}
          </MenubarItem>
          <MenubarSeparator />
          <MenubarSub>
            <MenubarSubTrigger>{t`Recent project`}</MenubarSubTrigger>
            <MenubarSubContent>
              {snapshot == null || snapshot.recentProjects.length === 0 ? (
                <MenubarItem disabled>{t`No recent projects`}</MenubarItem>
              ) : (
                <>
                  {snapshot.recentProjects.slice(0, 10).map((row) => (
                    <MenubarItem
                      key={row.path}
                      onSelect={() => dispatch({ kind: 'open-recent-project', path: row.path })}
                    >
                      {row.name}
                    </MenubarItem>
                  ))}
                  <MenubarSeparator />
                  <MenubarItem
                    onSelect={() => dispatch({ kind: 'command', command: 'clear-recent-projects' })}
                  >
                    {t`Clear menu`}
                  </MenubarItem>
                </>
              )}
            </MenubarSubContent>
          </MenubarSub>
          <MenubarItem onSelect={() => dispatch({ kind: 'menu-action', action: 'new-project' })}>
            {t`New project…`}
          </MenubarItem>
          <MenubarItem onSelect={() => dispatch({ kind: 'command', command: 'open-navigator' })}>
            {t`Switch project…`}
            <MenubarShortcut>Ctrl+Shift+P</MenubarShortcut>
          </MenubarItem>
          <MenubarItem
            onSelect={() => dispatch({ kind: 'command', command: 'open-folder-dialog' })}
          >
            {t`Open folder…`}
            <MenubarShortcut>Ctrl+O</MenubarShortcut>
          </MenubarItem>
          <MenubarSeparator />
          <MenubarItem onSelect={() => dispatch({ kind: 'menu-action', action: 'new-worktree' })}>
            {t`New worktree…`}
          </MenubarItem>
          <MenubarItem
            onSelect={() => dispatch({ kind: 'menu-action', action: 'switch-worktree' })}
          >
            {t`Switch worktree…`}
          </MenubarItem>
          <MenubarSeparator />
          <MenubarItem
            disabled={activeKind !== 'doc' && activeKind !== 'folder'}
            onSelect={() => dispatch({ kind: 'menu-action', action: 'duplicate' })}
          >
            {t`Duplicate`}
            <MenubarShortcut>Ctrl+D</MenubarShortcut>
          </MenubarItem>
          <MenubarItem
            disabled={activeKind === null}
            onSelect={() => dispatch({ kind: 'menu-action', action: 'rename' })}
          >
            {t`Rename`}
          </MenubarItem>
          <MenubarItem
            disabled={activeKind === null}
            onSelect={() => dispatch({ kind: 'menu-action', action: 'move-to-trash' })}
          >
            {t`Move to Trash`}
            <MenubarShortcut>Ctrl+Del</MenubarShortcut>
          </MenubarItem>
          <MenubarSeparator />
          <MenubarItem
            onSelect={() => dispatch({ kind: 'menu-action', action: 'reveal-in-finder' })}
          >
            {revealLabel}
          </MenubarItem>
          <MenubarItem
            disabled={activeKind === 'asset'}
            onSelect={() => dispatch({ kind: 'menu-action', action: 'send-to-ai' })}
          >
            {t`Open with AI`}
          </MenubarItem>
          <MenubarSub>
            <MenubarSubTrigger>{t`Copy path`}</MenubarSubTrigger>
            <MenubarSubContent>
              <MenubarItem
                onSelect={() => dispatch({ kind: 'menu-action', action: 'copy-full-path' })}
              >
                {t`Full path`}
              </MenubarItem>
              <MenubarItem
                onSelect={() => dispatch({ kind: 'menu-action', action: 'copy-relative-path' })}
              >
                {t`Relative path`}
              </MenubarItem>
            </MenubarSubContent>
          </MenubarSub>
          <MenubarSeparator />
          {snapshot?.canReconfigureMcpWiring === true && (
            <>
              <MenubarItem
                onSelect={() => dispatch({ kind: 'command', command: 'reconfigure-mcp-wiring' })}
              >
                {t`Set up OpenKnowledge integrations…`}
              </MenubarItem>
              <MenubarSeparator />
            </>
          )}
          <MenubarItem onSelect={() => dispatch({ kind: 'command', command: 'open-settings' })}>
            {t`Settings…`}
            <MenubarShortcut>Ctrl+,</MenubarShortcut>
          </MenubarItem>
          <MenubarSeparator />
          <MenubarItem onSelect={() => dispatch({ kind: 'role', role: 'quit' })}>
            {t`Exit`}
          </MenubarItem>
        </MenubarContent>
      </MenubarMenu>

      <MenubarMenu>
        <MenubarTrigger className="px-2 py-1 text-xs font-normal">{t`Edit`}</MenubarTrigger>
        <MenubarContent>
          <MenubarItem onSelect={() => dispatch({ kind: 'role', role: 'undo' })}>
            {t`Undo`}
            <MenubarShortcut>Ctrl+Z</MenubarShortcut>
          </MenubarItem>
          <MenubarItem onSelect={() => dispatch({ kind: 'role', role: 'redo' })}>
            {t`Redo`}
            <MenubarShortcut>Ctrl+Y</MenubarShortcut>
          </MenubarItem>
          <MenubarSeparator />
          <MenubarItem onSelect={() => dispatch({ kind: 'role', role: 'cut' })}>
            {t`Cut`}
            <MenubarShortcut>Ctrl+X</MenubarShortcut>
          </MenubarItem>
          <MenubarItem onSelect={() => dispatch({ kind: 'role', role: 'copy' })}>
            {t`Copy`}
            <MenubarShortcut>Ctrl+C</MenubarShortcut>
          </MenubarItem>
          <MenubarItem onSelect={() => dispatch({ kind: 'role', role: 'paste' })}>
            {t`Paste`}
            <MenubarShortcut>Ctrl+V</MenubarShortcut>
          </MenubarItem>
          <MenubarItem onSelect={() => dispatch({ kind: 'role', role: 'selectAll' })}>
            {t`Select All`}
            <MenubarShortcut>Ctrl+A</MenubarShortcut>
          </MenubarItem>
          <MenubarSeparator />
          <MenubarCheckboxItem
            checked={snapshot?.spellCheckEnabled ?? true}
            onSelect={() => dispatch({ kind: 'command', command: 'toggle-spell-check' })}
          >
            {t`Check spelling while typing`}
          </MenubarCheckboxItem>
        </MenubarContent>
      </MenubarMenu>

      <MenubarMenu>
        <MenubarTrigger className="px-2 py-1 text-xs font-normal">{t`View`}</MenubarTrigger>
        <MenubarContent>
          <MenubarItem onSelect={() => dispatch({ kind: 'role', role: 'reload' })}>
            {t`Reload`}
          </MenubarItem>
          <MenubarItem onSelect={() => dispatch({ kind: 'role', role: 'forceReload' })}>
            {t`Force Reload`}
          </MenubarItem>
          {snapshot?.showDevToolsMenu === true && (
            <MenubarItem onSelect={() => dispatch({ kind: 'role', role: 'toggleDevTools' })}>
              {t`Toggle Developer Tools`}
            </MenubarItem>
          )}
          <MenubarSeparator />
          <MenubarItem onSelect={() => dispatch({ kind: 'menu-action', action: 'toggle-sidebar' })}>
            {view?.sidebarVisible === false ? t`Show sidebar` : t`Hide sidebar`}
            <MenubarShortcut>Ctrl+Alt+S</MenubarShortcut>
          </MenubarItem>
          <MenubarItem
            onSelect={() => dispatch({ kind: 'menu-action', action: 'toggle-doc-panel' })}
          >
            {view?.docPanelVisible === false ? t`Show document panel` : t`Hide document panel`}
            <MenubarShortcut>Ctrl+Alt+B</MenubarShortcut>
          </MenubarItem>
          <MenubarSeparator />
          <MenubarCheckboxItem
            checked={view?.showHiddenFiles ?? false}
            onSelect={() => dispatch({ kind: 'menu-action', action: 'toggle-show-hidden-files' })}
          >
            {t`Show hidden files`}
            <MenubarShortcut>Ctrl+Shift+.</MenubarShortcut>
          </MenubarCheckboxItem>
          <MenubarCheckboxItem
            checked={view?.showOkFolders ?? false}
            onSelect={() => dispatch({ kind: 'menu-action', action: 'toggle-show-ok-folders' })}
          >
            {t`Show .ok folders`}
          </MenubarCheckboxItem>
          <MenubarCheckboxItem
            checked={view?.showOnlyMarkdownFiles ?? false}
            onSelect={() =>
              dispatch({ kind: 'menu-action', action: 'toggle-show-only-markdown-files' })
            }
          >
            {t`Show only markdown files`}
          </MenubarCheckboxItem>
          <MenubarCheckboxItem
            checked={view?.showSkillsSection ?? true}
            onSelect={() => dispatch({ kind: 'menu-action', action: 'toggle-show-skills-section' })}
          >
            {t`Show skills section`}
          </MenubarCheckboxItem>
          <MenubarSeparator />
          {(view?.canExpandAll ?? true) && (
            <MenubarItem
              onSelect={() => dispatch({ kind: 'menu-action', action: 'expand-all-tree' })}
            >
              {t`Expand all`}
            </MenubarItem>
          )}
          {(view?.canCollapseAll ?? true) && (
            <MenubarItem
              onSelect={() => dispatch({ kind: 'menu-action', action: 'collapse-all-tree' })}
            >
              {t`Collapse all`}
            </MenubarItem>
          )}
          <MenubarSeparator />
          <MenubarItem onSelect={() => dispatch({ kind: 'role', role: 'resetZoom' })}>
            {t`Actual Size`}
          </MenubarItem>
          <MenubarItem onSelect={() => dispatch({ kind: 'role', role: 'zoomIn' })}>
            {t`Zoom In`}
          </MenubarItem>
          <MenubarItem onSelect={() => dispatch({ kind: 'role', role: 'zoomOut' })}>
            {t`Zoom Out`}
          </MenubarItem>
          <MenubarSeparator />
          <MenubarItem onSelect={() => dispatch({ kind: 'role', role: 'toggleFullScreen' })}>
            {t`Toggle Full Screen`}
            <MenubarShortcut>F11</MenubarShortcut>
          </MenubarItem>
        </MenubarContent>
      </MenubarMenu>

      <MenubarMenu>
        <MenubarTrigger className="px-2 py-1 text-xs font-normal">{t`Window`}</MenubarTrigger>
        <MenubarContent>
          <MenubarItem onSelect={() => dispatch({ kind: 'role', role: 'minimize' })}>
            {t`Minimize`}
          </MenubarItem>
          <MenubarItem onSelect={() => dispatch({ kind: 'role', role: 'close' })}>
            {t`Close Window`}
          </MenubarItem>
        </MenubarContent>
      </MenubarMenu>

      <MenubarMenu>
        <MenubarTrigger className="px-2 py-1 text-xs font-normal">{t`Help`}</MenubarTrigger>
        <MenubarContent>
          <MenubarItem onSelect={() => dispatch({ kind: 'command', command: 'open-github' })}>
            {t`OpenKnowledge on GitHub`}
          </MenubarItem>
          <MenubarItem onSelect={() => dispatch({ kind: 'menu-action', action: 'report-bug' })}>
            {t`Report a Bug…`}
          </MenubarItem>
          {snapshot?.canCheckForUpdates === true && (
            <>
              <MenubarSeparator />
              <MenubarItem
                onSelect={() => dispatch({ kind: 'command', command: 'check-for-updates' })}
              >
                {t`Check for updates…`}
              </MenubarItem>
            </>
          )}
        </MenubarContent>
      </MenubarMenu>
    </Menubar>
  );
}

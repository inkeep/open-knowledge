/**
 * Menu template unit tests — exercise `buildMenuTemplate(deps)` as a pure
 * function over the injected `MenuDeps`, no real Electron runtime needed.
 *
 * `buildMenuTemplate` is the "exported-for-testing" seam in `menu.ts`; these
 * tests pin down (a) the recents-submenu shape on 0 / N entries + top-10
 * clamp, (b) the Clear-Menu click wiring, and (c) the macOS branch of the
 * File / Window submenus (close vs quit, Window `zoom`/`front` vs `close`).
 *
 * We don't mount a real menu — Electron's `Menu.setApplicationMenu` is
 * exercised in packaged-build Playwright smoke. The value here is
 * regression detection on the template shape: if a future edit breaks the
 * top-10 clamp or the isMac branch, these tests fail with a precise diff.
 */
import { describe, expect, mock, test } from 'bun:test';
import type { MenuItemConstructorOptions } from 'electron';
import { buildMenuTemplate, type MenuDeps } from '../../src/main/menu.ts';

type RecentRow = { path: string; name: string };

function makeDeps(overrides: Partial<MenuDeps> = {}): MenuDeps {
  return {
    appName: 'OpenKnowledge',
    showDevToolsMenu: true,
    dialog: {} as MenuDeps['dialog'],
    openNavigator: mock(() => {}),
    openProject: mock(() => Promise.resolve()),
    getRecentProjects: mock(() => []),
    clearRecentProjects: mock(() => {}),
    openExternalUrl: mock(() => {}),
    ...overrides,
  };
}

/** Find the first submenu item with `label === searchLabel` at any depth. */
function findByLabel(
  items: readonly MenuItemConstructorOptions[],
  searchLabel: string,
): MenuItemConstructorOptions | undefined {
  for (const item of items) {
    if (item.label === searchLabel) return item;
    const sub = item.submenu;
    if (Array.isArray(sub)) {
      const found = findByLabel(sub, searchLabel);
      if (found) return found;
    }
  }
  return undefined;
}

describe('buildMenuTemplate', () => {
  test('empty recents → "No recent projects" disabled placeholder', () => {
    const deps = makeDeps();
    const template = buildMenuTemplate(deps);
    const openRecent = findByLabel(template, 'Recent project');
    expect(openRecent).toBeDefined();
    const sub = openRecent?.submenu as MenuItemConstructorOptions[] | undefined;
    expect(Array.isArray(sub)).toBe(true);
    expect(sub?.length).toBe(1);
    expect(sub?.[0]?.label).toBe('No recent projects');
    expect(sub?.[0]?.enabled).toBe(false);
  });

  test('populated recents → N entries + separator + Clear menu', () => {
    const recents: RecentRow[] = [
      { path: '/tmp/a', name: 'alpha' },
      { path: '/tmp/b', name: 'beta' },
    ];
    const deps = makeDeps({ getRecentProjects: () => recents });
    const template = buildMenuTemplate(deps);
    const openRecent = findByLabel(template, 'Recent project');
    const sub = openRecent?.submenu as MenuItemConstructorOptions[] | undefined;
    // 2 rows + separator + Clear menu = 4 items
    expect(sub?.length).toBe(4);
    expect(sub?.[0]?.label).toBe('alpha');
    expect(sub?.[0]?.sublabel).toBe('/tmp/a');
    expect(sub?.[1]?.label).toBe('beta');
    expect(sub?.[2]?.type).toBe('separator');
    expect(sub?.[3]?.label).toBe('Clear menu');
  });

  test('clamps at 10 entries even when more are present', () => {
    const recents: RecentRow[] = Array.from({ length: 15 }, (_, i) => ({
      path: `/tmp/p${i}`,
      name: `project-${i}`,
    }));
    const deps = makeDeps({ getRecentProjects: () => recents });
    const template = buildMenuTemplate(deps);
    const openRecent = findByLabel(template, 'Recent project');
    const sub = openRecent?.submenu as MenuItemConstructorOptions[] | undefined;
    // 10 rows + separator + Clear menu = 12 items (not 17)
    expect(sub?.length).toBe(12);
    expect(sub?.[0]?.label).toBe('project-0');
    expect(sub?.[9]?.label).toBe('project-9');
    // entries 10-14 are dropped; position 10 is the separator.
    expect(sub?.[10]?.type).toBe('separator');
    expect(sub?.[11]?.label).toBe('Clear menu');
  });

  test('recent-row click dispatches deps.openProject(path, "recents")', () => {
    const openProject = mock(() => Promise.resolve());
    const deps = makeDeps({
      getRecentProjects: () => [{ path: '/tmp/foo', name: 'foo' }],
      openProject,
    });
    const template = buildMenuTemplate(deps);
    const openRecent = findByLabel(template, 'Recent project');
    const sub = openRecent?.submenu as MenuItemConstructorOptions[] | undefined;
    const row = sub?.[0];
    // Electron's click signature accepts many args; we only use the zero-arg form.
    (row?.click as (() => void) | undefined)?.();
    expect(openProject).toHaveBeenCalledWith('/tmp/foo', 'recents');
  });

  test('File → Open folder click dispatches deps.openProject(path, "pick-existing")', async () => {
    const openProject = mock(() => Promise.resolve());
    const showOpenDialog = mock(() =>
      Promise.resolve({ canceled: false, filePaths: ['/tmp/picked'] }),
    );
    const deps = makeDeps({
      openProject,
      dialog: { showOpenDialog } as unknown as MenuDeps['dialog'],
    });
    const template = buildMenuTemplate(deps);
    const openFolder = findByLabel(template, 'Open folder…');
    expect(openFolder).toBeDefined();
    await (openFolder?.click as (() => Promise<void>) | undefined)?.();
    expect(openProject).toHaveBeenCalledWith('/tmp/picked', 'pick-existing');
  });

  test('Clear menu click dispatches deps.clearRecentProjects()', () => {
    const clearRecentProjects = mock(() => {});
    const deps = makeDeps({
      getRecentProjects: () => [{ path: '/tmp/foo', name: 'foo' }],
      clearRecentProjects,
    });
    const template = buildMenuTemplate(deps);
    const clearMenu = findByLabel(template, 'Clear menu');
    expect(clearMenu).toBeDefined();
    (clearMenu?.click as (() => void) | undefined)?.();
    expect(clearRecentProjects).toHaveBeenCalledTimes(1);
  });

  test('Switch project click dispatches deps.openNavigator()', () => {
    const openNavigator = mock(() => {});
    const deps = makeDeps({ openNavigator });
    const template = buildMenuTemplate(deps);
    const switchProject = findByLabel(template, 'Switch project…');
    expect(switchProject).toBeDefined();
    (switchProject?.click as (() => void) | undefined)?.();
    expect(openNavigator).toHaveBeenCalledTimes(1);
  });

  test('Switch project rebound to Cmd+Shift+P (FR19 / D39 — Cmd+Shift+N now owns New folder)', () => {
    // The rebind frees Cmd+Shift+N for the higher-frequency New folder
    // operation per macOS HIG conventions (matches VS Code / Finder).
    const template = buildMenuTemplate(makeDeps());
    const switchProject = findByLabel(template, 'Switch project…');
    expect(switchProject?.accelerator).toBe('CmdOrCtrl+Shift+P');
  });

  test('"New Project…" label no longer appears in any submenu', () => {
    // Regression guard against partial rename — the old verb was misleading
    // because the underlying action covers create AND open AND list.
    const template = buildMenuTemplate(makeDeps());
    expect(findByLabel(template, 'New Project…')).toBeUndefined();
  });

  describe('Worktree items (SPEC: worktree = window)', () => {
    test('New worktree… / Switch worktree… are disabled when their deps are unwired', () => {
      const template = buildMenuTemplate(makeDeps());
      expect(findByLabel(template, 'New worktree…')?.enabled).toBe(false);
      expect(findByLabel(template, 'Switch worktree…')?.enabled).toBe(false);
    });

    test('New worktree… click dispatches deps.onNewWorktree()', () => {
      const onNewWorktree = mock(() => {});
      const template = buildMenuTemplate(makeDeps({ onNewWorktree }));
      const item = findByLabel(template, 'New worktree…');
      expect(item?.enabled).toBe(true);
      (item?.click as () => void)?.();
      expect(onNewWorktree).toHaveBeenCalledTimes(1);
    });

    test('Switch worktree… click dispatches deps.onSwitchWorktree()', () => {
      const onSwitchWorktree = mock(() => {});
      const template = buildMenuTemplate(makeDeps({ onSwitchWorktree }));
      const item = findByLabel(template, 'Switch worktree…');
      expect(item?.enabled).toBe(true);
      (item?.click as () => void)?.();
      expect(onSwitchWorktree).toHaveBeenCalledTimes(1);
    });
  });

  test('top-level menus include File / Edit / View / Terminal / Window / Help', () => {
    const template = buildMenuTemplate(makeDeps());
    const topLabels = template.map((t) => t.label);
    expect(topLabels).toContain('File');
    expect(topLabels).toContain('Edit');
    expect(topLabels).toContain('View');
    expect(topLabels).toContain('Terminal');
    expect(topLabels).toContain('Window');
    expect(topLabels).toContain('Help');
  });

  describe('View → Reload / Force Reload / Toggle Developer Tools cluster', () => {
    function viewRoles(deps: MenuDeps): Array<string | undefined> {
      const template = buildMenuTemplate(deps);
      const view = template.find((t) => t.label === 'View');
      const sub = view?.submenu as MenuItemConstructorOptions[] | undefined;
      return sub?.map((item) => item.role) ?? [];
    }

    test('showDevToolsMenu: true exposes the dev cluster (dev + beta channel)', () => {
      const roles = viewRoles(makeDeps({ showDevToolsMenu: true }));
      expect(roles).toContain('reload');
      expect(roles).toContain('forceReload');
      expect(roles).toContain('toggleDevTools');
      // Zoom + fullscreen entries remain unconditionally — asserted symmetrically
      // with the false branch so a future regression that accidentally gates
      // zoomIn/zoomOut on showDevToolsMenu fails in BOTH tests.
      expect(roles).toContain('resetZoom');
      expect(roles).toContain('zoomIn');
      expect(roles).toContain('zoomOut');
      expect(roles).toContain('togglefullscreen');
    });

    test('showDevToolsMenu: false hides the dev cluster (stable channel)', () => {
      const roles = viewRoles(makeDeps({ showDevToolsMenu: false }));
      expect(roles).not.toContain('reload');
      expect(roles).not.toContain('forceReload');
      expect(roles).not.toContain('toggleDevTools');
      // Zoom + fullscreen entries still present so View isn't empty.
      expect(roles).toContain('resetZoom');
      expect(roles).toContain('zoomIn');
      expect(roles).toContain('zoomOut');
      expect(roles).toContain('togglefullscreen');
    });
  });

  test('does not render Desktop command-line tools install/uninstall menu items', () => {
    const template = buildMenuTemplate(makeDeps());
    expect(findByLabel(template, 'Install Command-Line Tools…')).toBeUndefined();
    expect(findByLabel(template, 'Uninstall Command-Line Tools')).toBeUndefined();
  });

  describe('Settings… menu item (US-010 / FR-1 / D54)', () => {
    const isMac = process.platform === 'darwin';

    test('Settings… is rendered with the CmdOrCtrl+, accelerator', () => {
      const deps = makeDeps({ openSettings: mock(() => {}) });
      const template = buildMenuTemplate(deps);
      const settings = findByLabel(template, 'Settings…');
      expect(settings).toBeDefined();
      expect(settings?.accelerator).toBe('CmdOrCtrl+,');
    });

    test('Settings… click dispatches deps.openSettings()', () => {
      const openSettings = mock(() => {});
      const deps = makeDeps({ openSettings });
      const template = buildMenuTemplate(deps);
      const settings = findByLabel(template, 'Settings…');
      (settings?.click as (() => void) | undefined)?.();
      expect(openSettings).toHaveBeenCalledTimes(1);
    });

    test('Settings… click is a safe no-op when openSettings dep is omitted', () => {
      const deps = makeDeps();
      const template = buildMenuTemplate(deps);
      const settings = findByLabel(template, 'Settings…');
      // The optional-dep (?.()) shape MUST not throw when unwired — unit
      // tests build the menu without runtime wiring.
      expect(() => (settings?.click as (() => void) | undefined)?.()).not.toThrow();
    });

    if (isMac) {
      test('macOS: Settings… lives in the App menu, between About and the services separator', () => {
        const deps = makeDeps({ openSettings: mock(() => {}) });
        const template = buildMenuTemplate(deps);
        // The first top-level submenu on macOS is the App menu (label === appName).
        const appMenu = template.find((t) => t.label === deps.appName);
        expect(appMenu).toBeDefined();
        const sub = appMenu?.submenu as MenuItemConstructorOptions[] | undefined;
        if (!sub) throw new Error('App submenu missing on macOS');
        const aboutIdx = sub.findIndex((i) => i.role === 'about');
        const settingsIdx = sub.findIndex((i) => i.label === 'Settings…');
        const servicesIdx = sub.findIndex((i) => i.role === 'services');
        // Apple HIG: Settings sits after About + before Services. Both
        // separators bracket Settings on either side.
        expect(aboutIdx).toBeGreaterThanOrEqual(0);
        expect(settingsIdx).toBeGreaterThan(aboutIdx);
        expect(settingsIdx).toBeLessThan(servicesIdx);
      });

      test('macOS: Settings… does NOT appear in the File submenu', () => {
        const deps = makeDeps({ openSettings: mock(() => {}) });
        const template = buildMenuTemplate(deps);
        const fileMenu = template.find((t) => t.label === 'File');
        const sub = fileMenu?.submenu as MenuItemConstructorOptions[] | undefined;
        if (!sub) throw new Error('File submenu missing');
        const settingsInFile = sub.find((i) => i.label === 'Settings…');
        // On macOS Settings lives in the App menu, not File — duplicating
        // it across both menus would be a HIG violation.
        expect(settingsInFile).toBeUndefined();
      });
    } else {
      test('Windows/Linux: Settings… lives in the File submenu, above the trailing close/quit row', () => {
        const deps = makeDeps({ openSettings: mock(() => {}) });
        const template = buildMenuTemplate(deps);
        const fileMenu = template.find((t) => t.label === 'File');
        const sub = fileMenu?.submenu as MenuItemConstructorOptions[] | undefined;
        if (!sub) throw new Error('File submenu missing');
        const settingsIdx = sub.findIndex((i) => i.label === 'Settings…');
        const trailingRoleIdx = sub.findIndex((i) => i.role === 'close' || i.role === 'quit');
        expect(settingsIdx).toBeGreaterThanOrEqual(0);
        expect(settingsIdx).toBeLessThan(trailingRoleIdx);
      });
    }
  });

  describe('Check for updates… menu item', () => {
    const isMac = process.platform === 'darwin';

    test('omitted entirely when onCheckForUpdates dep is undefined (dev mode / boot failure)', () => {
      const deps = makeDeps();
      const template = buildMenuTemplate(deps);
      expect(findByLabel(template, 'Check for updates…')).toBeUndefined();
    });

    if (isMac) {
      test('macOS: appears in App menu between About and Settings…', () => {
        const onCheckForUpdates = mock(() => {});
        const deps = makeDeps({ onCheckForUpdates, openSettings: mock(() => {}) });
        const template = buildMenuTemplate(deps);
        const appMenu = template.find((t) => t.label === deps.appName);
        const sub = appMenu?.submenu as MenuItemConstructorOptions[] | undefined;
        if (!sub) throw new Error('App submenu missing');
        const aboutIdx = sub.findIndex((i) => i.role === 'about');
        const checkIdx = sub.findIndex((i) => i.label === 'Check for updates…');
        const settingsIdx = sub.findIndex((i) => i.label === 'Settings…');
        expect(aboutIdx).toBeGreaterThanOrEqual(0);
        expect(checkIdx).toBeGreaterThan(aboutIdx);
        expect(settingsIdx).toBeGreaterThan(checkIdx);
      });

      test('macOS: also appears in Help menu (cross-platform discoverability)', () => {
        const onCheckForUpdates = mock(() => {});
        const deps = makeDeps({ onCheckForUpdates });
        const template = buildMenuTemplate(deps);
        const helpMenu = template.find((t) => t.label === 'Help');
        const sub = helpMenu?.submenu as MenuItemConstructorOptions[] | undefined;
        if (!sub) throw new Error('Help submenu missing');
        expect(sub.find((i) => i.label === 'Check for updates…')).toBeDefined();
      });
    } else {
      test('non-mac: appears in Help menu only (no App menu on these platforms)', () => {
        const onCheckForUpdates = mock(() => {});
        const deps = makeDeps({ onCheckForUpdates });
        const template = buildMenuTemplate(deps);
        const helpMenu = template.find((t) => t.label === 'Help');
        const sub = helpMenu?.submenu as MenuItemConstructorOptions[] | undefined;
        if (!sub) throw new Error('Help submenu missing');
        expect(sub.find((i) => i.label === 'Check for updates…')).toBeDefined();
      });
    }

    test('click dispatches deps.onCheckForUpdates()', () => {
      const onCheckForUpdates = mock(() => {});
      const deps = makeDeps({ onCheckForUpdates });
      const template = buildMenuTemplate(deps);
      const item = findByLabel(template, 'Check for updates…');
      if (!item || typeof item.click !== 'function')
        throw new Error('Check for updates… click missing');
      // The click handler shape varies by Electron typings (sometimes
      // (item, win, event) — the menu builder passes the dep as a bare
      // function reference, so calling with no args mirrors what
      // Electron does at runtime when the menu item has no shortcut.
      (item.click as () => void)();
      expect(onCheckForUpdates).toHaveBeenCalledTimes(1);
    });
  });

  describe('Uninstall OpenKnowledge… menu item', () => {
    test('omitted entirely when onUninstall dep is undefined', () => {
      const template = buildMenuTemplate(makeDeps());
      expect(findByLabel(template, 'Uninstall OpenKnowledge…')).toBeUndefined();
    });

    if (process.platform === 'darwin') {
      test('macOS: appears in the App menu before Quit when wired', () => {
        const onUninstall = mock(() => {});
        const deps = makeDeps({ onUninstall });
        const template = buildMenuTemplate(deps);
        const appMenu = template.find((t) => t.label === deps.appName);
        const sub = appMenu?.submenu as MenuItemConstructorOptions[] | undefined;
        if (!sub) throw new Error('App submenu missing');
        const uninstallIdx = sub.findIndex((i) => i.label === 'Uninstall OpenKnowledge…');
        const quitIdx = sub.findIndex((i) => i.role === 'quit');
        expect(uninstallIdx).toBeGreaterThanOrEqual(0);
        expect(uninstallIdx).toBeLessThan(quitIdx);
      });
    }

    test('click dispatches deps.onUninstall()', () => {
      const onUninstall = mock(() => {});
      const item = findByLabel(
        buildMenuTemplate(makeDeps({ onUninstall })),
        'Uninstall OpenKnowledge…',
      );
      if (process.platform !== 'darwin') {
        expect(item).toBeUndefined();
        return;
      }
      if (!item || typeof item.click !== 'function') throw new Error('uninstall click missing');
      (item.click as () => void)();
      expect(onUninstall).toHaveBeenCalledTimes(1);
    });
  });

  test('File close item follows the current test host branch', () => {
    // `buildMenuTemplate` reads `process.platform` directly — we can assert
    // the consistent cross-shape pairing rather than stubbing the platform.
    // On darwin: File closes the active tab first via a custom handler,
    // Window submenu has zoom + front.
    // On others: File.quit is a role, Window submenu has close.
    const template = buildMenuTemplate(makeDeps());
    const file = findByLabel(template, 'File');
    const fileSub = file?.submenu as MenuItemConstructorOptions[] | undefined;
    const last = fileSub?.[fileSub.length - 1];
    expect(last).toBeDefined();
    if (process.platform === 'darwin') {
      expect(last?.label).toBe('Close tab');
      expect(last?.accelerator).toBe('CmdOrCtrl+W');
      expect(last?.role).toBeUndefined();
    } else {
      expect(last?.role).toBe('quit');
    }

    const windowMenu = findByLabel(template, 'Window');
    const windowSub = windowMenu?.submenu as MenuItemConstructorOptions[] | undefined;
    // macOS adds zoom + separator + front (so length > 1); non-mac adds close.
    const roles = windowSub?.map((i) => i.role).filter(Boolean) ?? [];
    const hasZoom = roles.includes('zoom');
    const hasClose = roles.includes('close');
    const hasFront = roles.includes('front');
    // Exactly one branch must have fired — not both, not neither.
    const isMacBranch = hasZoom && hasFront;
    const isOtherBranch = hasClose && !hasZoom;
    expect(isMacBranch || isOtherBranch).toBe(true);
    // Minimize is always present.
    expect(roles).toContain('minimize');
  });

  test('Close tab click dispatches deps.onCloseActiveTabOrWindow on macOS', () => {
    if (process.platform !== 'darwin') return;
    const onCloseActiveTabOrWindow = mock(() => {});
    const template = buildMenuTemplate(makeDeps({ onCloseActiveTabOrWindow }));
    const closeTab = findByLabel(template, 'Close tab');
    expect(closeTab?.enabled).toBe(true);
    (closeTab?.click as (() => void) | undefined)?.();
    expect(onCloseActiveTabOrWindow).toHaveBeenCalledTimes(1);
  });
});

describe('buildMenuTemplate — File menu state-aware items (US-020 / FR16 + FR19)', () => {
  test('New file renders with Cmd+N accelerator (FR19 — was unbound today)', () => {
    const template = buildMenuTemplate(makeDeps({ onNewFile: mock(() => {}) }));
    const newFile = findByLabel(template, 'New file');
    expect(newFile).toBeDefined();
    expect(newFile?.accelerator).toBe('CmdOrCtrl+N');
  });

  test('New folder renders with Cmd+Shift+N accelerator (FR19 — rebound from Switch project)', () => {
    const template = buildMenuTemplate(makeDeps({ onNewFolder: mock(() => {}) }));
    const newFolder = findByLabel(template, 'New folder');
    expect(newFolder).toBeDefined();
    expect(newFolder?.accelerator).toBe('CmdOrCtrl+Shift+N');
  });

  test('Move to Trash renders with Cmd+Delete accelerator (FR19 — matches Finder + VSCode)', () => {
    const template = buildMenuTemplate(makeDeps({ onMoveToTrash: mock(() => {}) }));
    const moveToTrash = findByLabel(template, 'Move to Trash');
    expect(moveToTrash).toBeDefined();
    expect(moveToTrash?.accelerator).toBe('CmdOrCtrl+Delete');
  });

  test('Duplicate renders with Cmd+D accelerator', () => {
    const template = buildMenuTemplate(makeDeps({ onDuplicate: mock(() => {}) }));
    const duplicate = findByLabel(template, 'Duplicate');
    expect(duplicate).toBeDefined();
    expect(duplicate?.accelerator).toBe('CmdOrCtrl+D');
  });

  test('Rename + Duplicate + Move to Trash DISABLED in project scope (activeTarget.kind = null)', () => {
    const template = buildMenuTemplate(
      makeDeps({
        activeTarget: { kind: null },
        onRename: mock(() => {}),
        onDuplicate: mock(() => {}),
        onMoveToTrash: mock(() => {}),
      }),
    );
    expect(findByLabel(template, 'Rename')?.enabled).toBe(false);
    expect(findByLabel(template, 'Duplicate')?.enabled).toBe(false);
    expect(findByLabel(template, 'Move to Trash')?.enabled).toBe(false);
  });

  test('Rename + Duplicate + Move to Trash ENABLED in doc scope (activeTarget.kind = "doc")', () => {
    const template = buildMenuTemplate(
      makeDeps({
        activeTarget: { kind: 'doc', identifier: 'notes/today' },
        onRename: mock(() => {}),
        onDuplicate: mock(() => {}),
        onMoveToTrash: mock(() => {}),
      }),
    );
    expect(findByLabel(template, 'Rename')?.enabled).toBe(true);
    expect(findByLabel(template, 'Duplicate')?.enabled).toBe(true);
    expect(findByLabel(template, 'Move to Trash')?.enabled).toBe(true);
  });

  test('Rename + Duplicate + Move to Trash ENABLED in folder scope (activeTarget.kind = "folder")', () => {
    const template = buildMenuTemplate(
      makeDeps({
        activeTarget: { kind: 'folder', identifier: 'specs/2026' },
        onRename: mock(() => {}),
        onDuplicate: mock(() => {}),
        onMoveToTrash: mock(() => {}),
      }),
    );
    expect(findByLabel(template, 'Rename')?.enabled).toBe(true);
    expect(findByLabel(template, 'Duplicate')?.enabled).toBe(true);
    expect(findByLabel(template, 'Move to Trash')?.enabled).toBe(true);
  });

  test('asset scope enables Rename + Move to Trash but disables Duplicate and Open with AI', () => {
    const template = buildMenuTemplate(
      makeDeps({
        activeTarget: { kind: 'asset', identifier: 'media/diagram.png' },
        onRename: mock(() => {}),
        onDuplicate: mock(() => {}),
        onMoveToTrash: mock(() => {}),
        onSendToAi: mock(() => {}),
      }),
    );
    expect(findByLabel(template, 'Rename')?.enabled).toBe(true);
    expect(findByLabel(template, 'Duplicate')?.enabled).toBe(false);
    expect(findByLabel(template, 'Move to Trash')?.enabled).toBe(true);
    expect(findByLabel(template, 'Open with AI')?.enabled).toBe(false);
  });

  test('Rename DISABLED when activeTarget is undefined (deps missing — unit-test default)', () => {
    const template = buildMenuTemplate(makeDeps({ onRename: mock(() => {}) }));
    expect(findByLabel(template, 'Rename')?.enabled).toBe(false);
  });

  test('Creation cluster + Reveal/Send-to-AI/CopyPath always ENABLED when deps provided', () => {
    // Project scope (null activeTarget) — creation items + project-scope ops
    // are still enabled because their target is contentDir.
    const template = buildMenuTemplate(
      makeDeps({
        activeTarget: { kind: null },
        onNewFile: mock(() => {}),
        onNewFolder: mock(() => {}),
        onNewFromTemplate: mock(() => {}),
        onRevealInFinder: mock(() => {}),
        onSendToAi: mock(() => {}),
        onCopyFullPath: mock(() => {}),
        onCopyRelativePath: mock(() => {}),
      }),
    );
    expect(findByLabel(template, 'New file')?.enabled).toBe(true);
    expect(findByLabel(template, 'New folder')?.enabled).toBe(true);
    expect(findByLabel(template, 'New from template…')?.enabled).toBe(true);
    expect(findByLabel(template, 'Reveal in Finder')?.enabled).toBe(true);
    expect(findByLabel(template, 'Open with AI')?.enabled).toBe(true);
    expect(findByLabel(template, 'Copy path')?.enabled).toBe(true);
  });

  test('Items DISABLED when their handler dep is undefined (unit-test default = unwired)', () => {
    const template = buildMenuTemplate(makeDeps());
    expect(findByLabel(template, 'New file')?.enabled).toBe(false);
    expect(findByLabel(template, 'New folder')?.enabled).toBe(false);
    expect(findByLabel(template, 'New from template…')?.enabled).toBe(false);
    expect(findByLabel(template, 'Duplicate')?.enabled).toBe(false);
    expect(findByLabel(template, 'Reveal in Finder')?.enabled).toBe(false);
    expect(findByLabel(template, 'Open with AI')?.enabled).toBe(false);
    expect(findByLabel(template, 'Copy path')?.enabled).toBe(false);
    if (process.platform === 'darwin') {
      expect(findByLabel(template, 'Close tab')?.enabled).toBe(false);
    }
  });

  test('Copy path submenu renders Full path + Relative path (FR9 parity with sidebar)', () => {
    const template = buildMenuTemplate(
      makeDeps({
        onCopyFullPath: mock(() => {}),
        onCopyRelativePath: mock(() => {}),
      }),
    );
    const copyPath = findByLabel(template, 'Copy path');
    expect(copyPath).toBeDefined();
    const sub = copyPath?.submenu as MenuItemConstructorOptions[] | undefined;
    expect(sub?.[0]?.label).toBe('Full path');
    expect(sub?.[1]?.label).toBe('Relative path');
  });

  test('click handlers dispatch to deps (e.g. New file → onNewFile)', () => {
    const onNewFile = mock(() => {});
    const onDuplicate = mock(() => {});
    const onMoveToTrash = mock(() => {});
    const onCopyFullPath = mock(() => {});
    const template = buildMenuTemplate(
      makeDeps({
        activeTarget: { kind: 'doc', identifier: 'a' },
        onNewFile,
        onDuplicate,
        onMoveToTrash,
        onCopyFullPath,
      }),
    );
    (findByLabel(template, 'New file')?.click as (() => void) | undefined)?.();
    expect(onNewFile).toHaveBeenCalledTimes(1);
    (findByLabel(template, 'Duplicate')?.click as (() => void) | undefined)?.();
    expect(onDuplicate).toHaveBeenCalledTimes(1);
    (findByLabel(template, 'Move to Trash')?.click as (() => void) | undefined)?.();
    expect(onMoveToTrash).toHaveBeenCalledTimes(1);
    (findByLabel(template, 'Full path')?.click as (() => void) | undefined)?.();
    expect(onCopyFullPath).toHaveBeenCalledTimes(1);
  });

  test('Hide this file / Hide folder do NOT appear in File menu (D37 trim — stays sidebar-only)', () => {
    const template = buildMenuTemplate(
      makeDeps({
        activeTarget: { kind: 'doc', identifier: 'a' },
      }),
    );
    expect(findByLabel(template, 'Hide this file')).toBeUndefined();
    expect(findByLabel(template, 'Hide folder')).toBeUndefined();
  });
});

describe('buildMenuTemplate — New project… menu item', () => {
  test('renders enabled when onNewProject dep is provided', () => {
    const template = buildMenuTemplate(makeDeps({ onNewProject: mock(() => {}) }));
    const item = findByLabel(template, 'New project…');
    expect(item).toBeDefined();
    expect(item?.enabled).toBe(true);
  });

  test('DISABLED when onNewProject dep is omitted (unit-test default = unwired)', () => {
    const template = buildMenuTemplate(makeDeps());
    expect(findByLabel(template, 'New project…')?.enabled).toBe(false);
  });

  test('enabled regardless of activeTarget scope (project-scope-independent)', () => {
    // Unlike Rename / Duplicate / Move to Trash, creating a project does not
    // depend on the current target — it must stay enabled in project scope.
    const template = buildMenuTemplate(
      makeDeps({ activeTarget: { kind: null }, onNewProject: mock(() => {}) }),
    );
    expect(findByLabel(template, 'New project…')?.enabled).toBe(true);
  });

  test('click dispatches deps.onNewProject()', () => {
    const onNewProject = mock(() => {});
    const template = buildMenuTemplate(makeDeps({ onNewProject }));
    const item = findByLabel(template, 'New project…');
    (item?.click as (() => void) | undefined)?.();
    expect(onNewProject).toHaveBeenCalledTimes(1);
  });

  test('click is a safe no-op when onNewProject dep is omitted', () => {
    const template = buildMenuTemplate(makeDeps());
    const item = findByLabel(template, 'New project…');
    expect(() => (item?.click as (() => void) | undefined)?.()).not.toThrow();
  });

  test('project section mirrors the ProjectSwitcher order and sits right after New from template…', () => {
    // Native File menu and the in-app ProjectSwitcher present the same project
    // actions in the same order: Recent project, New project, Switch project,
    // Open folder — placed directly under the New… items, above the
    // item-management actions (Duplicate / Rename / Move to Trash).
    const template = buildMenuTemplate(makeDeps({ onNewProject: mock(() => {}) }));
    const fileMenu = template.find((t) => t.label === 'File');
    const sub = fileMenu?.submenu as MenuItemConstructorOptions[] | undefined;
    if (!sub) throw new Error('File submenu missing');
    const idx = (label: string) => sub.findIndex((i) => i.label === label);
    const newFromTemplateIdx = idx('New from template…');
    const recentIdx = idx('Recent project');
    const newProjectIdx = idx('New project…');
    const switchIdx = idx('Switch project…');
    const openFolderIdx = idx('Open folder…');
    const duplicateIdx = idx('Duplicate');
    expect(newFromTemplateIdx).toBeGreaterThanOrEqual(0);
    // Switcher-parity order: Recent → New project → Switch project → Open folder.
    expect(recentIdx).toBeGreaterThan(newFromTemplateIdx);
    expect(newProjectIdx).toBeGreaterThan(recentIdx);
    expect(switchIdx).toBeGreaterThan(newProjectIdx);
    expect(openFolderIdx).toBeGreaterThan(switchIdx);
    // The whole section precedes the item-management actions.
    expect(duplicateIdx).toBeGreaterThan(openFolderIdx);
    // Contiguity — the four project items are one uninterrupted block (no
    // separator interleaved), so the menu visually mirrors the switcher group.
    expect(newProjectIdx - recentIdx).toBe(1);
    expect(switchIdx - newProjectIdx).toBe(1);
    expect(openFolderIdx - switchIdx).toBe(1);
  });

  test('does NOT reintroduce the ambiguous "New Project…" label (regression guard)', () => {
    // The Navigator opener was once mislabeled "New Project…" (title case)
    // before it became "Switch project…". The create action is now "New
    // project…" (sentence case); this guards against the retired title-case label.
    const template = buildMenuTemplate(makeDeps({ onNewProject: mock(() => {}) }));
    expect(findByLabel(template, 'New Project…')).toBeUndefined();
    expect(findByLabel(template, 'New project…')).toBeDefined();
  });
});

describe('buildMenuTemplate — View menu visibility toggles + tree-scoped expand/collapse', () => {
  test('Show hidden files renders as a checkbox-type item', () => {
    const template = buildMenuTemplate(
      makeDeps({ onToggleShowHiddenFiles: mock(() => {}), showHiddenFilesChecked: false }),
    );
    const item = findByLabel(template, 'Show hidden files');
    expect(item).toBeDefined();
    expect(item?.type).toBe('checkbox');
    expect(item?.checked).toBe(false);
    expect(item?.enabled).toBe(true);
  });

  test('Show hidden files binds Cmd+Shift+. accelerator (Finder convention)', () => {
    // Pinned because the keyboard shortcut is the muscle-memory affordance for
    // macOS users coming from Finder, where Cmd+Shift+. is the canonical
    // toggle for hidden files. A future refactor that drops the accelerator
    // would silently break that affordance — no other surface would catch it.
    const template = buildMenuTemplate(
      makeDeps({ onToggleShowHiddenFiles: mock(() => {}), showHiddenFilesChecked: false }),
    );
    expect(findByLabel(template, 'Show hidden files')?.accelerator).toBe('CmdOrCtrl+Shift+.');
  });

  test('Show hidden files DISABLED when toggle handler missing (unit-test default)', () => {
    const template = buildMenuTemplate(makeDeps());
    expect(findByLabel(template, 'Show hidden files')?.enabled).toBe(false);
  });

  test('Expand all / Collapse all render with visible=true by default', () => {
    const template = buildMenuTemplate(
      makeDeps({ onExpandAll: mock(() => {}), onCollapseAll: mock(() => {}) }),
    );
    expect(findByLabel(template, 'Expand all')?.visible).toBe(true);
    expect(findByLabel(template, 'Collapse all')?.visible).toBe(true);
  });

  test('Expand all HIDDEN when canExpandAll === false (smart-hide per D15)', () => {
    const template = buildMenuTemplate(
      makeDeps({ onExpandAll: mock(() => {}), canExpandAll: false }),
    );
    expect(findByLabel(template, 'Expand all')?.visible).toBe(false);
  });

  test('Collapse all HIDDEN when canCollapseAll === false', () => {
    const template = buildMenuTemplate(
      makeDeps({ onCollapseAll: mock(() => {}), canCollapseAll: false }),
    );
    expect(findByLabel(template, 'Collapse all')?.visible).toBe(false);
  });

  test('View menu click handlers dispatch to deps', () => {
    const onToggleShowHiddenFiles = mock(() => {});
    const onExpandAll = mock(() => {});
    const onCollapseAll = mock(() => {});
    const template = buildMenuTemplate(
      makeDeps({
        onToggleShowHiddenFiles,
        onExpandAll,
        onCollapseAll,
      }),
    );
    (findByLabel(template, 'Show hidden files')?.click as (() => void) | undefined)?.();
    expect(onToggleShowHiddenFiles).toHaveBeenCalledTimes(1);
    (findByLabel(template, 'Expand all')?.click as (() => void) | undefined)?.();
    expect(onExpandAll).toHaveBeenCalledTimes(1);
    (findByLabel(template, 'Collapse all')?.click as (() => void) | undefined)?.();
    expect(onCollapseAll).toHaveBeenCalledTimes(1);
  });

  test("View menu retains today's Zoom + Fullscreen items (regression guard)", () => {
    const template = buildMenuTemplate(makeDeps());
    const view = findByLabel(template, 'View');
    expect(view).toBeDefined();
    const sub = view?.submenu as MenuItemConstructorOptions[] | undefined;
    const roles = sub?.map((i) => i.role).filter(Boolean) ?? [];
    expect(roles).toContain('resetZoom');
    expect(roles).toContain('zoomIn');
    expect(roles).toContain('zoomOut');
    expect(roles).toContain('togglefullscreen');
  });

  test('New View menu items appear BEFORE Zoom items (FR17 / D38 placement)', () => {
    const template = buildMenuTemplate(
      makeDeps({
        onToggleShowHiddenFiles: mock(() => {}),
        onExpandAll: mock(() => {}),
      }),
    );
    const view = findByLabel(template, 'View');
    const sub = view?.submenu as MenuItemConstructorOptions[] | undefined;
    expect(sub).toBeDefined();
    const labels = sub?.map((i) => i.label ?? `[role:${i.role ?? 'sep'}]`) ?? [];
    const showHiddenFilesIdx = labels.indexOf('Show hidden files');
    const expandAllIdx = labels.indexOf('Expand all');
    const resetZoomIdx = labels.indexOf('[role:resetZoom]');
    expect(showHiddenFilesIdx).toBeGreaterThan(-1);
    expect(resetZoomIdx).toBeGreaterThan(showHiddenFilesIdx);
    expect(resetZoomIdx).toBeGreaterThan(expandAllIdx);
  });
});

describe('buildMenuTemplate — View → Show/Hide sidebar', () => {
  // The sidebar-toggle View-menu item follows Apple HIG convention (Finder's
  // pattern): a single row whose label flips between "Show sidebar" /
  // "Hide sidebar" based on the current state — NOT a checkbox row. ⌥⌘S is
  // Apple's canonical accelerator for sidebar toggle; ⌘B (the shadcn upstream
  // default) is unavailable here because it is Bold in the TipTap editor.
  // The earlier ⌘\ window-keydown shortcut in `ui/sidebar.tsx` was removed
  // when this native menu item took over — the accelerator is OS-captured
  // before any renderer keydown handler can observe it.

  test('renders "Hide sidebar" when sidebarVisible is true (or undefined default)', () => {
    const expanded = buildMenuTemplate(
      makeDeps({ onToggleSidebar: mock(() => {}), sidebarVisible: true }),
    );
    expect(findByLabel(expanded, 'Hide sidebar')).toBeDefined();
    expect(findByLabel(expanded, 'Show sidebar')).toBeUndefined();

    // `undefined` defaults to "visible" so the menu reads correctly before
    // the first renderer-pushed view-menu-state snapshot lands.
    const defaultDeps = buildMenuTemplate(makeDeps({ onToggleSidebar: mock(() => {}) }));
    expect(findByLabel(defaultDeps, 'Hide sidebar')).toBeDefined();
    expect(findByLabel(defaultDeps, 'Show sidebar')).toBeUndefined();
  });

  test('renders "Show sidebar" when sidebarVisible is false', () => {
    const collapsed = buildMenuTemplate(
      makeDeps({ onToggleSidebar: mock(() => {}), sidebarVisible: false }),
    );
    expect(findByLabel(collapsed, 'Show sidebar')).toBeDefined();
    expect(findByLabel(collapsed, 'Hide sidebar')).toBeUndefined();
  });

  test('binds CmdOrCtrl+Alt+S accelerator (⌥⌘S on macOS, Apple HIG sidebar convention)', () => {
    // Pinned because the keyboard shortcut is the muscle-memory affordance
    // for macOS users coming from Finder, Notes, Pages, etc. — ⌥⌘S is the
    // canonical sidebar-toggle accelerator. ⌘B (the shadcn upstream default)
    // collides with Bold in the editor; ⌘\ (the previous OK shortcut) is
    // non-standard. Spelled `CmdOrCtrl+Alt+S` (the cross-platform-safe form the
    // sibling accelerators use): Electron renders it as ⌥⌘S on macOS. A future
    // refactor that drops or changes the accelerator would silently break that
    // affordance.
    const template = buildMenuTemplate(makeDeps({ onToggleSidebar: mock(() => {}) }));
    expect(findByLabel(template, 'Hide sidebar')?.accelerator).toBe('CmdOrCtrl+Alt+S');

    const collapsed = buildMenuTemplate(
      makeDeps({ onToggleSidebar: mock(() => {}), sidebarVisible: false }),
    );
    expect(findByLabel(collapsed, 'Show sidebar')?.accelerator).toBe('CmdOrCtrl+Alt+S');
  });

  test('DISABLED when toggle handler missing (unit-test default)', () => {
    const template = buildMenuTemplate(makeDeps());
    expect(findByLabel(template, 'Hide sidebar')?.enabled).toBe(false);
  });

  test('click dispatches deps.onToggleSidebar', () => {
    const onToggleSidebar = mock(() => {});
    const template = buildMenuTemplate(makeDeps({ onToggleSidebar, sidebarVisible: true }));
    (findByLabel(template, 'Hide sidebar')?.click as (() => void) | undefined)?.();
    expect(onToggleSidebar).toHaveBeenCalledTimes(1);

    const onToggleSidebar2 = mock(() => {});
    const collapsed = buildMenuTemplate(
      makeDeps({ onToggleSidebar: onToggleSidebar2, sidebarVisible: false }),
    );
    (findByLabel(collapsed, 'Show sidebar')?.click as (() => void) | undefined)?.();
    expect(onToggleSidebar2).toHaveBeenCalledTimes(1);
  });

  test('Show/Hide sidebar precedes Show hidden files in the View submenu', () => {
    const template = buildMenuTemplate(
      makeDeps({
        onToggleSidebar: mock(() => {}),
        onToggleShowHiddenFiles: mock(() => {}),
      }),
    );
    const view = findByLabel(template, 'View');
    const sub = view?.submenu as MenuItemConstructorOptions[] | undefined;
    const labels = sub?.map((i) => i.label ?? `[role:${i.role ?? 'sep'}]`) ?? [];
    const sidebarIdx = labels.indexOf('Hide sidebar');
    const showHiddenFilesIdx = labels.indexOf('Show hidden files');
    expect(sidebarIdx).toBeGreaterThan(-1);
    expect(showHiddenFilesIdx).toBeGreaterThan(sidebarIdx);
  });

  // Show/Hide document panel — Q-RIGHT-SHORTCUT → ⌥⌘B (VS Code Secondary Side
  // Bar convention; modifier-coherent with the left's ⌥⌘S).
  // Structural tests mirror the ⌥⌘S cluster above so accelerator drift, label
  // drift on `docPanelVisible`, and unwired-deps disabling all fail loudly.
  test('renders "Hide document panel" when docPanelVisible is unset or true', () => {
    const unsetDeps = buildMenuTemplate(makeDeps({ onToggleDocPanel: mock(() => {}) }));
    expect(findByLabel(unsetDeps, 'Hide document panel')).toBeDefined();
    expect(findByLabel(unsetDeps, 'Show document panel')).toBeUndefined();

    const visible = buildMenuTemplate(
      makeDeps({ onToggleDocPanel: mock(() => {}), docPanelVisible: true }),
    );
    expect(findByLabel(visible, 'Hide document panel')).toBeDefined();
    expect(findByLabel(visible, 'Show document panel')).toBeUndefined();
  });

  test('renders "Show document panel" when docPanelVisible is false', () => {
    const collapsed = buildMenuTemplate(
      makeDeps({ onToggleDocPanel: mock(() => {}), docPanelVisible: false }),
    );
    expect(findByLabel(collapsed, 'Show document panel')).toBeDefined();
    expect(findByLabel(collapsed, 'Hide document panel')).toBeUndefined();
  });

  test('Document panel binds CmdOrCtrl+Alt+B accelerator (⌥⌘B on macOS, VS Code Secondary Side Bar convention)', () => {
    // Pinned because the keyboard shortcut is the muscle-memory affordance for
    // the right doc-panel — ⌥⌘B is the canonical secondary-sidebar accelerator
    // (VS Code's Secondary Side Bar binding) and modifier-coherent with the
    // left's ⌥⌘S. The ideal letter "I" is blocked by the browser/Electron
    // DevTools binding (⌥⌘I), and ⌥⌘0 collides with TipTap paragraph; ⌥⌘B
    // clears all four collision surfaces (macOS / browser / Electron DevTools
    // / TipTap-CodeMirror). Spelled `CmdOrCtrl+Alt+B` (cross-platform-safe;
    // Electron renders as ⌥⌘B on macOS).
    const visible = buildMenuTemplate(makeDeps({ onToggleDocPanel: mock(() => {}) }));
    expect(findByLabel(visible, 'Hide document panel')?.accelerator).toBe('CmdOrCtrl+Alt+B');

    const collapsed = buildMenuTemplate(
      makeDeps({ onToggleDocPanel: mock(() => {}), docPanelVisible: false }),
    );
    expect(findByLabel(collapsed, 'Show document panel')?.accelerator).toBe('CmdOrCtrl+Alt+B');
  });

  test('Document panel DISABLED when toggle handler missing (unit-test default)', () => {
    const template = buildMenuTemplate(makeDeps());
    expect(findByLabel(template, 'Hide document panel')?.enabled).toBe(false);
  });

  test('Document panel click dispatches deps.onToggleDocPanel', () => {
    const onToggleDocPanel = mock(() => {});
    const template = buildMenuTemplate(makeDeps({ onToggleDocPanel, docPanelVisible: true }));
    (findByLabel(template, 'Hide document panel')?.click as (() => void) | undefined)?.();
    expect(onToggleDocPanel).toHaveBeenCalledTimes(1);

    const onToggleDocPanel2 = mock(() => {});
    const collapsed = buildMenuTemplate(
      makeDeps({ onToggleDocPanel: onToggleDocPanel2, docPanelVisible: false }),
    );
    (findByLabel(collapsed, 'Show document panel')?.click as (() => void) | undefined)?.();
    expect(onToggleDocPanel2).toHaveBeenCalledTimes(1);
  });
});

describe('buildMenuTemplate — View → Show/Hide Terminal', () => {
  // The docked-terminal toggle mirrors the sidebar/doc-panel single-row pattern
  // but inverts the default: the terminal starts HIDDEN, so undefined/false
  // reads "Show Terminal" (the sidebar/doc-panel start visible, so they default
  // to "Hide"). ⌘J / Ctrl+J is OS-captured before the renderer, matching the
  // sidebar item's accelerator model.

  test('renders "Show Terminal" when terminalVisible is unset or false', () => {
    const unsetDeps = buildMenuTemplate(makeDeps({ onToggleTerminal: mock(() => {}) }));
    expect(findByLabel(unsetDeps, 'Show Terminal')).toBeDefined();
    expect(findByLabel(unsetDeps, 'Hide Terminal')).toBeUndefined();

    const hidden = buildMenuTemplate(
      makeDeps({ onToggleTerminal: mock(() => {}), terminalVisible: false }),
    );
    expect(findByLabel(hidden, 'Show Terminal')).toBeDefined();
    expect(findByLabel(hidden, 'Hide Terminal')).toBeUndefined();
  });

  test('renders "Hide Terminal" when terminalVisible is true', () => {
    const visible = buildMenuTemplate(
      makeDeps({ onToggleTerminal: mock(() => {}), terminalVisible: true }),
    );
    expect(findByLabel(visible, 'Hide Terminal')).toBeDefined();
    expect(findByLabel(visible, 'Show Terminal')).toBeUndefined();
  });

  test('Terminal binds CmdOrCtrl+J accelerator (⌘J on macOS, VS Code panel convention)', () => {
    // Pinned because ⌘J / Ctrl+J is the muscle-memory affordance for the bottom
    // panel (VS Code parity); ⌘` is macOS window-cycling. A refactor that drops
    // or rebinds the accelerator silently breaks that affordance.
    const hidden = buildMenuTemplate(makeDeps({ onToggleTerminal: mock(() => {}) }));
    expect(findByLabel(hidden, 'Show Terminal')?.accelerator).toBe('CmdOrCtrl+J');

    const visible = buildMenuTemplate(
      makeDeps({ onToggleTerminal: mock(() => {}), terminalVisible: true }),
    );
    expect(findByLabel(visible, 'Hide Terminal')?.accelerator).toBe('CmdOrCtrl+J');
  });

  test('Terminal DISABLED when toggle handler missing (unit-test default)', () => {
    const template = buildMenuTemplate(makeDeps());
    expect(findByLabel(template, 'Show Terminal')?.enabled).toBe(false);
  });

  test('Terminal click dispatches deps.onToggleTerminal', () => {
    const onToggleTerminal = mock(() => {});
    const template = buildMenuTemplate(makeDeps({ onToggleTerminal }));
    (findByLabel(template, 'Show Terminal')?.click as (() => void) | undefined)?.();
    expect(onToggleTerminal).toHaveBeenCalledTimes(1);

    const onToggleTerminal2 = mock(() => {});
    const visible = buildMenuTemplate(
      makeDeps({ onToggleTerminal: onToggleTerminal2, terminalVisible: true }),
    );
    (findByLabel(visible, 'Hide Terminal')?.click as (() => void) | undefined)?.();
    expect(onToggleTerminal2).toHaveBeenCalledTimes(1);
  });

  test('Terminal follows the Document Panel toggle and precedes the Zoom cluster', () => {
    const template = buildMenuTemplate(
      makeDeps({ onToggleDocPanel: mock(() => {}), onToggleTerminal: mock(() => {}) }),
    );
    const view = findByLabel(template, 'View');
    const sub = view?.submenu as MenuItemConstructorOptions[] | undefined;
    const labels = sub?.map((i) => i.label ?? `[role:${i.role ?? 'sep'}]`) ?? [];
    const docPanelIdx = labels.indexOf('Hide document panel');
    const terminalIdx = labels.indexOf('Show Terminal');
    const resetZoomIdx = labels.indexOf('[role:resetZoom]');
    expect(terminalIdx).toBeGreaterThan(docPanelIdx);
    expect(resetZoomIdx).toBeGreaterThan(terminalIdx);
  });
});

describe('buildMenuTemplate — top-level Terminal menu (New / Kill)', () => {
  // VS Code-style top-level Terminal menu, placed between View and Window. The
  // View → Show/Hide Terminal toggle is kept too (⌘J muscle memory); this menu
  // is the discoverable home. New Terminal is click-only (no accelerator — ⌘J
  // belongs to the View toggle); Kill Terminal gates on a live session.

  test('inserts a Terminal menu between View and Window', () => {
    const labels = buildMenuTemplate(makeDeps()).map((t) => t.label);
    const viewIdx = labels.indexOf('View');
    const terminalIdx = labels.indexOf('Terminal');
    const windowIdx = labels.indexOf('Window');
    expect(terminalIdx).toBeGreaterThan(viewIdx);
    expect(windowIdx).toBeGreaterThan(terminalIdx);
  });

  test('contains New Terminal, New Terminal Window, then Kill Terminal; New Terminal is click-only (no ⌘J)', () => {
    const template = buildMenuTemplate(
      makeDeps({
        onNewTerminal: mock(() => {}),
        onNewTerminalWindow: mock(() => {}),
        onKillTerminal: mock(() => {}),
      }),
    );
    const sub = findByLabel(template, 'Terminal')?.submenu as
      | MenuItemConstructorOptions[]
      | undefined;
    expect(sub?.map((i) => i.label)).toEqual([
      'New Terminal',
      'New Terminal Window',
      'Kill Terminal',
    ]);
    // No accelerator: ⌘J belongs to the View → Show/Hide Terminal toggle, so
    // advertising it here too would only mislabel this item.
    expect(findByLabel(template, 'New Terminal')?.accelerator).toBeUndefined();
  });

  test('New Terminal dispatches onNewTerminal; disabled when the handler is unwired', () => {
    const onNewTerminal = mock(() => {});
    const item = findByLabel(buildMenuTemplate(makeDeps({ onNewTerminal })), 'New Terminal');
    expect(item?.enabled).toBe(true);
    (item?.click as (() => void) | undefined)?.();
    expect(onNewTerminal).toHaveBeenCalledTimes(1);

    expect(findByLabel(buildMenuTemplate(makeDeps()), 'New Terminal')?.enabled).toBe(false);
  });

  test('Kill Terminal is disabled with no live session, enabled + kills when one is live', () => {
    // Wired handler but no live session → disabled (spec: disable when no session).
    const offline = buildMenuTemplate(makeDeps({ onKillTerminal: mock(() => {}) }));
    expect(findByLabel(offline, 'Kill Terminal')?.enabled).toBe(false);

    // A live session but no wired handler (unit-test default) → still disabled.
    const unwired = buildMenuTemplate(makeDeps({ terminalLive: true }));
    expect(findByLabel(unwired, 'Kill Terminal')?.enabled).toBe(false);

    // Live + wired → enabled; clicking runs the kill path.
    const onKillTerminal = mock(() => {});
    const live = buildMenuTemplate(makeDeps({ onKillTerminal, terminalLive: true }));
    const killItem = findByLabel(live, 'Kill Terminal');
    expect(killItem?.enabled).toBe(true);
    (killItem?.click as (() => void) | undefined)?.();
    expect(onKillTerminal).toHaveBeenCalledTimes(1);
  });

  test('the View → Show/Hide Terminal toggle is preserved alongside the Terminal menu', () => {
    const template = buildMenuTemplate(makeDeps({ onToggleTerminal: mock(() => {}) }));
    expect(findByLabel(template, 'Show Terminal')).toBeDefined();
    expect(findByLabel(template, 'Terminal')).toBeDefined();
  });
});

describe('buildMenuTemplate — Edit → Check spelling while typing', () => {
  function editSubmenu(deps: MenuDeps): MenuItemConstructorOptions[] {
    const edit = findByLabel(buildMenuTemplate(deps), 'Edit');
    const sub = edit?.submenu as MenuItemConstructorOptions[] | undefined;
    if (!sub) throw new Error('Edit submenu missing');
    return sub;
  }

  test('renders as a checkbox-type item, checked when spellCheckEnabled is true', () => {
    const item = findByLabel(
      buildMenuTemplate(makeDeps({ spellCheckEnabled: true, onToggleSpellCheck: mock(() => {}) })),
      'Check spelling while typing',
    );
    expect(item).toBeDefined();
    expect(item?.type).toBe('checkbox');
    expect(item?.checked).toBe(true);
  });

  test('renders unchecked when spellCheckEnabled is false', () => {
    const item = findByLabel(
      buildMenuTemplate(makeDeps({ spellCheckEnabled: false, onToggleSpellCheck: mock(() => {}) })),
      'Check spelling while typing',
    );
    expect(item?.checked).toBe(false);
  });

  test('defaults to checked when spellCheckEnabled dep is omitted (matches the on-by-default persistence default)', () => {
    const item = findByLabel(
      buildMenuTemplate(makeDeps({ onToggleSpellCheck: mock(() => {}) })),
      'Check spelling while typing',
    );
    expect(item?.checked).toBe(true);
  });

  test('ENABLED when onToggleSpellCheck handler is provided', () => {
    const item = findByLabel(
      buildMenuTemplate(makeDeps({ onToggleSpellCheck: mock(() => {}) })),
      'Check spelling while typing',
    );
    expect(item?.enabled).toBe(true);
  });

  test('DISABLED when onToggleSpellCheck handler is missing (unit-test default = unwired)', () => {
    const item = findByLabel(buildMenuTemplate(makeDeps()), 'Check spelling while typing');
    expect(item?.enabled).toBe(false);
  });

  test('click dispatches deps.onToggleSpellCheck', () => {
    const onToggleSpellCheck = mock(() => {});
    const item = findByLabel(
      buildMenuTemplate(makeDeps({ onToggleSpellCheck })),
      'Check spelling while typing',
    );
    (item?.click as (() => void) | undefined)?.();
    expect(onToggleSpellCheck).toHaveBeenCalledTimes(1);
  });

  test('click is a safe no-op when onToggleSpellCheck dep is omitted', () => {
    const item = findByLabel(buildMenuTemplate(makeDeps()), 'Check spelling while typing');
    expect(() => (item?.click as (() => void) | undefined)?.()).not.toThrow();
  });

  test('lives in the Edit submenu after the Select All role', () => {
    const sub = editSubmenu(makeDeps({ onToggleSpellCheck: mock(() => {}) }));
    const selectAllIdx = sub.findIndex((i) => i.role === 'selectAll');
    const spellIdx = sub.findIndex((i) => i.label === 'Check spelling while typing');
    expect(selectAllIdx).toBeGreaterThanOrEqual(0);
    expect(spellIdx).toBeGreaterThan(selectAllIdx);
  });
});

describe('Terminal menu — New Terminal Window', () => {
  test('appears in the Terminal submenu beside New Terminal', () => {
    const template = buildMenuTemplate(makeDeps({ onNewTerminalWindow: mock(() => {}) }));
    const terminalMenu = template.find((i) => i.label === 'Terminal');
    const sub = terminalMenu?.submenu as MenuItemConstructorOptions[] | undefined;
    if (!sub) throw new Error('Terminal submenu missing');
    const labels = sub.map((i) => i.label);
    expect(labels).toContain('New Terminal');
    expect(labels).toContain('New Terminal Window');
  });

  test('renders with no keyboard accelerator', () => {
    const item = findByLabel(
      buildMenuTemplate(makeDeps({ onNewTerminalWindow: mock(() => {}) })),
      'New Terminal Window',
    );
    expect(item).toBeDefined();
    expect(item?.accelerator).toBeUndefined();
  });

  test('click invokes onNewTerminalWindow', () => {
    const onNewTerminalWindow = mock(() => {});
    const item = findByLabel(
      buildMenuTemplate(makeDeps({ onNewTerminalWindow })),
      'New Terminal Window',
    );
    (item?.click as (() => void) | undefined)?.();
    expect(onNewTerminalWindow).toHaveBeenCalledTimes(1);
  });

  test('disabled when the dep is omitted, enabled when wired', () => {
    expect(findByLabel(buildMenuTemplate(makeDeps()), 'New Terminal Window')?.enabled).toBe(false);
    const wired = findByLabel(
      buildMenuTemplate(makeDeps({ onNewTerminalWindow: mock(() => {}) })),
      'New Terminal Window',
    );
    expect(wired?.enabled).toBe(true);
  });
});

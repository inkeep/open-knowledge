import type { Dialog, MenuItemConstructorOptions } from 'electron';
import { describe, expect, test, vi } from 'vitest';
import { buildAssetMenuTemplate } from '../../src/main/asset-menu.ts';
import { buildMenuTemplate, type MenuDeps } from '../../src/main/menu.ts';
import type { MenuTranslator } from '../../src/main/menu-translator.ts';
import { buildSpellcheckMenuTemplate } from '../../src/main/spellcheck-menu.ts';

function makeDeps(overrides: Partial<MenuDeps> = {}): MenuDeps {
  return {
    appName: 'OpenKnowledge',
    showDevToolsMenu: true,
    terminalCapable: true,
    dialog: {} as Dialog,
    openNavigator: vi.fn(),
    openProject: vi.fn(async () => {}),
    getRecentProjects: () => [],
    clearRecentProjects: vi.fn(),
    openExternalUrl: vi.fn(),
    ...overrides,
  };
}

function walk(items: readonly MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
  const out: MenuItemConstructorOptions[] = [];
  for (const item of items) {
    out.push(item);
    if (Array.isArray(item.submenu)) out.push(...walk(item.submenu));
  }
  return out;
}

const MARKING_TRANSLATOR: MenuTranslator = (message, values) =>
  `«${message.replace(/\{(\w+)\}/g, (whole, name: string) => values?.[name] ?? whole)}»`;

describe('every role item carries an explicit label', () => {
  test('no item in the application menu has a role without a label', () => {
    const withRecentFiles = makeDeps({
      getRecentFiles: () => [],
      clearRecentFiles: vi.fn(),
      onCheckForUpdates: vi.fn(),
      onUninstall: vi.fn(),
      reconfigureMcpWiring: vi.fn(),
    });
    const unlabelled = walk(buildMenuTemplate(withRecentFiles))
      .filter((item) => item.role !== undefined && item.label === undefined)
      .map((item) => item.role);
    expect(unlabelled).toEqual([]);
  });

  test('the walker actually reaches role items', () => {
    const roles = walk(buildMenuTemplate(makeDeps()))
      .map((item) => item.role)
      .filter(Boolean);
    expect(roles.length).toBeGreaterThan(15);
  });

  test('no item in the editable-content context menu has a role without a label', () => {
    const unlabelled = buildSpellcheckMenuTemplate({
      params: {
        misspelledWord: 'teh',
        dictionarySuggestions: ['the'],
        selectionText: '',
        editFlags: { canCut: true, canCopy: true, canPaste: true, canSelectAll: true },
      },
      spellCheckEnabled: true,
      canViewInSource: true,
      actions: {
        replaceMisspelling: vi.fn(),
        addToDictionary: vi.fn(),
        setSpellCheckEnabled: vi.fn(),
        lookUp: vi.fn(),
        search: vi.fn(),
        viewInSource: vi.fn(),
      },
    })
      .filter((item) => item.role !== undefined && item.label === undefined)
      .map((item) => item.role);
    expect(unlabelled).toEqual([]);
  });
});

describe('builders render English when no translator is injected', () => {
  test('the application menu keeps its English labels', () => {
    const labels = walk(buildMenuTemplate(makeDeps({ getRecentFiles: () => [] }))).map(
      (item) => item.label,
    );
    for (const expected of [
      'File',
      'Edit',
      'View',
      'Terminal',
      'Window',
      'Help',
      'Recent project',
      'Recent files',
      'No recent projects',
      'No recent files',
      'Select All',
      'Actual Size',
      'Toggle Full Screen',
    ]) {
      expect(labels).toContain(expected);
    }
    if (process.platform === 'darwin') {
      expect(labels).toContain('Quit OpenKnowledge');
    }
  });

  test('the context menus keep their English labels', () => {
    const spellcheck = buildSpellcheckMenuTemplate({
      params: {
        misspelledWord: 'teh',
        dictionarySuggestions: [],
        selectionText: 'a phrase',
        editFlags: { canCut: false, canCopy: false, canPaste: false, canSelectAll: false },
      },
      spellCheckEnabled: true,
      canViewInSource: true,
      actions: {
        replaceMisspelling: vi.fn(),
        addToDictionary: vi.fn(),
        setSpellCheckEnabled: vi.fn(),
        lookUp: vi.fn(),
        search: vi.fn(),
        viewInSource: vi.fn(),
      },
    }).map((item) => item.label);
    expect(spellcheck).toContain('Add to Dictionary');
    expect(spellcheck).toContain('Disable Spell Check');
    expect(spellcheck).toContain('Look Up "a phrase"');
    expect(spellcheck).toContain('Search with Google');
    expect(spellcheck).toContain('View in Source Markdown');

    const asset = buildAssetMenuTemplate({
      kind: 'asset',
      platform: 'darwin',
      actions: { reveal: vi.fn(), openInDefault: vi.fn(), copyLink: vi.fn() },
    }).map((item) => item.label);
    expect(asset).toEqual(['Reveal in Finder', 'Open in default app', undefined, 'Copy link']);
  });
});

describe('an injected translator reaches every label', () => {
  test('the application menu leaves no label untranslated', () => {
    const template = buildMenuTemplate(
      makeDeps({
        translate: MARKING_TRANSLATOR,
        getRecentProjects: () => [{ path: '/tmp/Notes', name: 'Notes' }],
        getRecentFiles: () => [{ path: '/tmp/a.md', name: 'a.md' }],
        clearRecentFiles: vi.fn(),
        onCheckForUpdates: vi.fn(),
        onUninstall: vi.fn(),
        reconfigureMcpWiring: vi.fn(),
        onToggleSidebar: vi.fn(),
        onCopyFullPath: vi.fn(),
      }),
    );
    const userAuthored = new Set(['OpenKnowledge', 'Notes', 'a.md']);
    const untranslated = walk(template)
      .map((item) => item.label)
      .filter((label): label is string => label !== undefined)
      .filter((label) => !label.startsWith('«') && !userAuthored.has(label));
    expect(untranslated).toEqual([]);
  });

  test('role labels are translated and interpolate the app name', () => {
    const template = buildMenuTemplate(makeDeps({ translate: MARKING_TRANSLATOR }));
    const byRole = new Map(
      walk(template)
        .filter((item) => item.role !== undefined)
        .map((item) => [item.role, item.label]),
    );
    expect(byRole.get('copy')).toBe('«Copy»');
    expect(byRole.get('selectAll')).toBe('«Select All»');
    expect(byRole.get('resetZoom')).toBe('«Actual Size»');
    if (process.platform === 'darwin') {
      expect(byRole.get('quit')).toBe('«Quit OpenKnowledge»');
      expect(byRole.get('hide')).toBe('«Hide OpenKnowledge»');
      expect(byRole.get('about')).toBe('«About OpenKnowledge»');
    }
  });

  test('the context menus leave no chrome label untranslated', () => {
    const spellcheck = buildSpellcheckMenuTemplate({
      params: {
        misspelledWord: 'teh',
        dictionarySuggestions: ['the'],
        selectionText: '',
        editFlags: { canCut: true, canCopy: true, canPaste: true, canSelectAll: true },
      },
      spellCheckEnabled: true,
      canViewInSource: true,
      translate: MARKING_TRANSLATOR,
      actions: {
        replaceMisspelling: vi.fn(),
        addToDictionary: vi.fn(),
        setSpellCheckEnabled: vi.fn(),
        lookUp: vi.fn(),
        search: vi.fn(),
        viewInSource: vi.fn(),
      },
    }).map((item) => item.label);
    expect(spellcheck).toContain('the');
    expect(spellcheck).toContain('«Add to Dictionary»');
    expect(spellcheck).toContain('«Cut»');
    expect(spellcheck).toContain('«View in Source Markdown»');

    for (const platform of ['darwin', 'win32', 'linux'] as const) {
      const asset = buildAssetMenuTemplate({
        kind: 'asset',
        platform,
        translate: MARKING_TRANSLATOR,
        actions: { reveal: vi.fn(), openInDefault: vi.fn(), copyLink: vi.fn() },
      })
        .map((item) => item.label)
        .filter((label): label is string => label !== undefined);
      expect(asset.every((label) => label.startsWith('«'))).toBe(true);
    }
  });
});

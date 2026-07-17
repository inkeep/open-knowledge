/**
 * Command-palette / menu parity ratchet (Ratchet A + B).
 *
 * Modeled on `attribution-sweep-coverage.test.ts`: partitions every command
 * identity into exactly one classification and fails when something new is
 * neither reachable from Cmd+K nor explicitly reserved with a reason. This is
 * the durable "nothing is missed" guarantee — a new `OkMenuAction` id or a new
 * native-menu leaf that no one classified turns this test red.
 *
 * Two id-spaces are swept:
 *  - Ratchet A: the `OK_MENU_ACTIONS` runtime array (its drift from the
 *    `OkMenuAction` type is a compile error in `ok-menu-actions.ts`; here we
 *    assert every id is classified palette-command vs. app-reserved).
 *  - Ratchet B: every actionable leaf parsed from `buildMenuTemplate` across
 *    both platform branches is classified palette-command / OS-role / reserved.
 */

import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { APP_RESERVED_IDS, PALETTE_COMMAND_IDS } from '@/lib/command-menu-parity.test-helper';
import { formatShortcut, type KeyboardShortcutId } from '@/lib/keyboard-shortcuts';
import { OK_MENU_ACTIONS } from '@/lib/ok-menu-actions';
import { buildMenuTemplate, type MenuDeps } from '../../../desktop/src/main/menu.ts';

// Derive the menu-item type from buildMenuTemplate itself, so the ratchet does
// not take a direct `electron` dependency (the app package has none).
type MenuTemplateItem = ReturnType<typeof buildMenuTemplate>[number];

// ─── Ratchet A: OkMenuAction id classification ──────────────────────────────
// The classification sets (PALETTE_COMMAND_IDS / APP_RESERVED_IDS) are shared
// with the DOM render suite via command-menu-parity.test-helper.

// ─── Ratchet B: native-menu leaf classification ─────────────────────────────

// Electron `role:` items — keyboard-native / platform-standard / dev-only. This
// allowlist is maintained by hand against Electron's role set.
const OS_ROLE_EXEMPT = new Set<string>([
  'about',
  'services',
  'hide',
  'hideOthers',
  'unhide',
  'quit',
  'undo',
  'redo',
  'cut',
  'copy',
  'paste',
  'selectAll',
  'reload',
  'forceReload',
  'toggleDevTools',
  'resetZoom',
  'zoomIn',
  'zoomOut',
  'togglefullscreen',
  'minimize',
  'zoom',
  'front',
  'close',
]);

// Actionable menu leaves that ARE palette commands (labels, ellipsis-normalized;
// state-aware View toggles contribute both their Show/Hide variants). "Full path"
// / "Relative path" are the Copy-path submenu leaves the palette flattens.
const PALETTE_COMMAND_LABELS = new Set<string>([
  'New file',
  'New folder',
  'New from template',
  'New project',
  'Switch project',
  'Open folder',
  'New worktree',
  'Switch worktree',
  'Duplicate',
  'Rename',
  'Move to Trash',
  'Reveal in Finder',
  'Open with AI',
  'Full path',
  'Relative path',
  'Set up OpenKnowledge integrations',
  'Close tab',
  'Check for updates',
  'Settings',
  'Check spelling while typing',
  'Show sidebar',
  'Hide sidebar',
  'Show document panel',
  'Hide document panel',
  'Show Terminal',
  'Hide Terminal',
  'Show hidden files',
  'Show .ok folders',
  'Show only markdown files',
  'Show skills section',
  'Expand all',
  'Collapse all',
  'New Terminal',
  'Kill Terminal',
  'OpenKnowledge on GitHub',
  'Report a Bug',
  // Present already; not a single registry command but reachable from the palette
  // as its own surface (Install for Claude, gated behind SHOW_INSTALL_SKILL).
  'Install for Claude Chat & Cowork (desktop app)',
]);

// Non-role, non-palette leaves deliberately kept out of Cmd+K — each reasoned.
const APP_RESERVED_LABELS = new Map<string, string>([
  ['Uninstall OpenKnowledge', 'rare + destructive; deliberately not a quick-launch row'],
  ['New Terminal Window', 'opens directly in main with no renderer handler; window management'],
]);

/** All the deps present so every conditional menu item renders. */
function makeFullDeps(): MenuDeps {
  const noop = () => {};
  return {
    appName: 'OpenKnowledge',
    showDevToolsMenu: true,
    dialog: {} as MenuDeps['dialog'],
    openNavigator: noop,
    openProject: () => Promise.resolve(),
    getRecentProjects: () => [],
    clearRecentProjects: noop,
    openExternalUrl: noop,
    reconfigureMcpWiring: noop,
    openInstallSkillDialog: noop,
    openSettings: noop,
    onReportBug: noop,
    onCheckForUpdates: noop,
    onUninstall: noop,
    activeTarget: { kind: 'doc', target: 'doc.md' } as MenuDeps['activeTarget'],
    onNewFile: noop,
    onNewFolder: noop,
    onNewFromTemplate: noop,
    onNewProject: noop,
    onNewWorktree: noop,
    onSwitchWorktree: noop,
    onRename: noop,
    onDuplicate: noop,
    onMoveToTrash: noop,
    onCloseActiveTabOrWindow: noop,
    onRevealInFinder: noop,
    onSendToAi: noop,
    onCopyFullPath: noop,
    onCopyRelativePath: noop,
    showHiddenFilesChecked: false,
    onToggleShowHiddenFiles: noop,
    showOkFoldersChecked: false,
    onToggleShowOkFolders: noop,
    showOnlyMarkdownFilesChecked: false,
    onToggleShowOnlyMarkdownFiles: noop,
    showSkillsSectionChecked: false,
    onToggleShowSkillsSection: noop,
    sidebarVisible: true,
    onToggleSidebar: noop,
    docPanelVisible: true,
    onToggleDocPanel: noop,
    terminalVisible: true,
    onToggleTerminal: noop,
    onNewTerminal: noop,
    onKillTerminal: noop,
    onNewTerminalWindow: noop,
    terminalLive: true,
    canExpandAll: true,
    canCollapseAll: true,
    onExpandAll: noop,
    onCollapseAll: noop,
    spellCheckEnabled: true,
    onToggleSpellCheck: noop,
  };
}

interface Leaf {
  label: string;
  role?: string;
  accelerator?: string;
}

/** Recurse the template, collecting actionable leaves (skip separators, disabled
 *  placeholders, and submenu parents — which contribute their children). */
function collectLeaves(items: readonly MenuTemplateItem[], out: Leaf[]): void {
  for (const item of items) {
    if (item.type === 'separator') continue;
    const sub = item.submenu;
    if (Array.isArray(sub)) {
      collectLeaves(sub, out);
      continue;
    }
    if (item.enabled === false) continue; // disabled placeholder (e.g. "No recent projects")
    const accelerator = typeof item.accelerator === 'string' ? item.accelerator : undefined;
    if (item.role) {
      out.push({
        label: typeof item.label === 'string' ? item.label : '',
        role: item.role,
        accelerator,
      });
      continue;
    }
    if (typeof item.label === 'string') {
      out.push({ label: item.label, accelerator });
    }
  }
}

/** Strip the trailing platform ellipsis the native menu appends at call time. */
function normalizeLabel(label: string): string {
  return label.replace(/…$/, '').trim();
}

function collectLeavesForPlatform(platform: NodeJS.Platform): Leaf[] {
  const original = process.platform;
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  try {
    const leaves: Leaf[] = [];
    collectLeaves(buildMenuTemplate(makeFullDeps()), leaves);
    return leaves;
  } finally {
    Object.defineProperty(process, 'platform', { value: original, configurable: true });
  }
}

describe('command-menu parity ratchet', () => {
  test('Ratchet A: every OkMenuAction id is classified palette-command or app-reserved', () => {
    const untracked = OK_MENU_ACTIONS.filter(
      (id) => !PALETTE_COMMAND_IDS.has(id) && !APP_RESERVED_IDS.has(id),
    );
    expect(untracked).toEqual([]);
  });

  test('Ratchet A: every classified id is a real OkMenuAction (no stale entries)', () => {
    const known = new Set<string>(OK_MENU_ACTIONS);
    const stale = [...PALETTE_COMMAND_IDS, ...APP_RESERVED_IDS.keys()].filter(
      (id) => !known.has(id),
    );
    expect(stale).toEqual([]);
  });

  test('Ratchet B: every actionable menu leaf is classified across both platforms', () => {
    const leaves = [...collectLeavesForPlatform('darwin'), ...collectLeavesForPlatform('win32')];
    const untracked = leaves.filter((leaf) => {
      if (leaf.role) return !OS_ROLE_EXEMPT.has(leaf.role);
      const label = normalizeLabel(leaf.label);
      return !PALETTE_COMMAND_LABELS.has(label) && !APP_RESERVED_LABELS.has(label);
    });
    expect(untracked.map((l) => l.role ?? normalizeLabel(l.label))).toEqual([]);
  });

  test('Ratchet B sanity: the sweep actually found the backfilled leaves', () => {
    const labels = new Set(collectLeavesForPlatform('darwin').map((l) => normalizeLabel(l.label)));
    // A few representative backfilled palette leaves must be present, or the sweep is inert.
    // makeFullDeps sets the panels visible, so the state-aware View toggle
    // renders its "Hide …" variant.
    expect(labels.has('Check for updates')).toBe(true);
    expect(labels.has('Move to Trash')).toBe(true);
    expect(labels.has('Hide sidebar')).toBe(true);
    expect(labels.has('New Terminal')).toBe(true);
  });

  // ─── Ratchet D: menu accelerator ↔ keyboard-shortcut registry parity ────────
  // Commands with BOTH a native-menu accelerator AND a keyboard-shortcuts.ts
  // binding must agree. Guards the live drift between menu.ts's hand-typed
  // accelerators and the shortcut registry (they share no import); the id-spaces
  // differ, so this map bridges menu label → shortcut id.
  const MENU_SHORTCUT_PAIRS: Array<{ menuLabel: string; shortcutId: KeyboardShortcutId }> = [
    { menuLabel: 'New file', shortcutId: 'new-item' },
    { menuLabel: 'New folder', shortcutId: 'new-folder' },
    { menuLabel: 'Switch project', shortcutId: 'switch-project' },
    { menuLabel: 'Open folder', shortcutId: 'open-folder' },
    { menuLabel: 'Duplicate', shortcutId: 'file-tree-duplicate' },
    { menuLabel: 'Move to Trash', shortcutId: 'file-tree-delete' },
    { menuLabel: 'Settings', shortcutId: 'settings' },
    { menuLabel: 'Hide sidebar', shortcutId: 'toggle-files-sidebar' },
    { menuLabel: 'Hide document panel', shortcutId: 'toggle-document-panel' },
    { menuLabel: 'Hide Terminal', shortcutId: 'toggle-terminal-panel' },
  ];

  // Canonical token set — order-insensitive; treats Cmd/Ctrl as MOD and
  // Delete/Backspace as one key, so the Electron accelerator string and the
  // display-glyph binding compare equal when they mean the same chord.
  function chordTokens(s: string): string {
    const tokens = new Set<string>();
    if (/CmdOrCtrl|Cmd|Ctrl|⌘|⌃/.test(s)) tokens.add('MOD');
    if (/Shift|⇧/.test(s)) tokens.add('SHIFT');
    if (/Alt|Option|⌥/.test(s)) tokens.add('ALT');
    let base = s.replace(/CmdOrCtrl|Cmd|Ctrl|Shift|Alt|Option/g, '').replace(/[⌘⌃⇧⌥+\s]/g, '');
    if (/^(Delete|Backspace|⌫)$/i.test(base)) base = 'DEL';
    tokens.add(`KEY:${base.toUpperCase()}`);
    return [...tokens].sort().join(',');
  }

  test('Ratchet D: menu accelerators agree with the keyboard-shortcut registry', () => {
    const accelByLabel = new Map<string, string>();
    for (const leaf of collectLeavesForPlatform('darwin')) {
      if (leaf.accelerator) accelByLabel.set(normalizeLabel(leaf.label), leaf.accelerator);
    }
    const mismatches: Array<{ menuLabel: string; accelerator?: string; shortcut: string }> = [];
    for (const { menuLabel, shortcutId } of MENU_SHORTCUT_PAIRS) {
      const accelerator = accelByLabel.get(menuLabel);
      const shortcut = formatShortcut(shortcutId, 'mac');
      if (accelerator === undefined || chordTokens(accelerator) !== chordTokens(shortcut)) {
        mismatches.push({ menuLabel, accelerator, shortcut });
      }
    }
    expect(mismatches).toEqual([]);
  });

  // Exactly one bridge.onMenuAction listener (the bus forwarder) — no subscriber
  // may double-fire alongside it.
  test('FR3: the bus forwarder is the only bridge.onMenuAction listener', () => {
    const appSrc = join(import.meta.dir, '..', '..', 'src');
    const migrated = [
      'components/FileSidebar.tsx',
      'components/EditorArea.tsx',
      'components/EditorPane.tsx',
      'components/TerminalSessionsHost.tsx',
      'components/ProjectSwitcher.tsx',
      'components/CreateProjectMenuTrigger.tsx',
      'components/ReportBugMenuTrigger.tsx',
      'components/NavigatorApp.tsx',
      'editor/DocumentContext.tsx',
    ];
    for (const rel of migrated) {
      const source = readFileSync(join(appSrc, rel), 'utf8');
      // No migrated subscriber may still listen on the bridge directly (that
      // would double-fire alongside the forwarder); each attaches to the bus.
      expect({ file: rel, listensOnBridge: source.includes('.onMenuAction(') }).toEqual({
        file: rel,
        listensOnBridge: false,
      });
      expect(source.includes('subscribeLocalMenuAction')).toBe(true);
    }
    // The bus module owns exactly one bridge.onMenuAction call — the forwarder.
    const busSource = readFileSync(join(appSrc, 'lib/local-menu-action-bus.ts'), 'utf8');
    expect(busSource.split('.onMenuAction(').length - 1).toBe(1);
  });

  // Repo-wide guard: exactly one production `.onMenuAction(` call site — the bus
  // forwarder. Unlike the hand-maintained `migrated` allowlist above, this walks
  // all of src, so a NEW subscriber that listens on the bridge directly (a
  // double-fire) turns this red without being added to any list.
  test('FR3: exactly one production bridge.onMenuAction call site (the bus forwarder)', () => {
    const appSrc = join(import.meta.dir, '..', '..', 'src');
    const isTestLike = (name: string) => /\.(test|test-helper)\.[cm]?tsx?$/.test(name);
    const callSites: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!/\.[cm]?tsx?$/.test(entry.name) || isTestLike(entry.name)) continue;
        if (readFileSync(full, 'utf8').includes('.onMenuAction(')) {
          callSites.push(relative(appSrc, full));
        }
      }
    };
    walk(appSrc);
    expect(callSites.sort()).toEqual(['lib/local-menu-action-bus.ts']);
  });
});

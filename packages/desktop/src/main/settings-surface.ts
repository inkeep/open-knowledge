export type SettingsWindowKind = 'editor' | 'navigator' | 'note' | 'terminal' | 'other';

export function resolveSettingsWindowKind<TWindow>(
  win: TWindow,
  deps: {
    isDestroyed: (win: TWindow) => boolean;
    isNavigator: (win: TWindow) => boolean;
    getEditorContext: (win: TWindow) => object | null | undefined;
    getNoteContext: (win: TWindow) => object | undefined;
    getTerminalContext: (win: TWindow) => object | undefined;
  },
): SettingsWindowKind {
  if (deps.isDestroyed(win)) return 'other';
  if (deps.isNavigator(win)) return 'navigator';
  if (deps.getTerminalContext(win)) return 'terminal';
  if (deps.getNoteContext(win)) return 'note';
  return deps.getEditorContext(win) ? 'editor' : 'other';
}

export interface SettingsSurfaceDeps<TWindow> {
  kindOf: (win: TWindow) => SettingsWindowKind;
  getFocusedWindow: () => TWindow | null;
  getAllWindows: () => readonly TWindow[];
}

export type SettingsSection = 'account';

export type SettingsSurfaceOptions =
  | { origin?: 'user' | 'deep-link'; editorOnly?: false; section?: never }
  | { origin?: 'user'; editorOnly: true; section?: SettingsSection };

export interface OpenSettingsSurfaceDeps<TWindow> extends SettingsSurfaceDeps<TWindow> {
  showEditor: (win: TWindow, section?: SettingsSection) => void;
  showNavigator: (win: TWindow | null) => boolean;
  openNavigator: () => void;
  onEditorRequired: (win: TWindow | null) => void;
}

export type SettingsSurfaceTarget<TWindow> =
  | { kind: 'editor'; window: TWindow }
  | { kind: 'navigator'; window: TWindow }
  | { kind: 'none' };

export function resolveSettingsSurface<TWindow>(
  explicit: TWindow | null,
  deps: SettingsSurfaceDeps<TWindow>,
  options: SettingsSurfaceOptions = {},
): SettingsSurfaceTarget<TWindow> {
  const editorOnly = options.editorOnly === true;
  const asHost = (win: TWindow | null): SettingsSurfaceTarget<TWindow> | null => {
    if (win == null) return null;
    const kind = deps.kindOf(win);
    if (kind === 'editor') return { kind, window: win };
    if (kind === 'navigator' && !editorOnly) return { kind, window: win };
    return null;
  };

  const direct = asHost(explicit) ?? asHost(deps.getFocusedWindow());
  if (direct) return direct;

  const all = deps.getAllWindows();
  const editor = all.find((win) => deps.kindOf(win) === 'editor');
  if (editor !== undefined) return { kind: 'editor', window: editor };
  if (!editorOnly) {
    const navigator = all.find((win) => deps.kindOf(win) === 'navigator');
    if (navigator !== undefined) return { kind: 'navigator', window: navigator };
  }
  return { kind: 'none' };
}

export function openSettingsSurface<TWindow>(
  explicit: TWindow | null,
  deps: OpenSettingsSurfaceDeps<TWindow>,
  options: SettingsSurfaceOptions = {},
): void {
  const target = resolveSettingsSurface(explicit, deps, options);
  if (target.kind === 'editor') {
    deps.showEditor(target.window, options.section);
  } else if (options.origin === 'deep-link') {
    deps.openNavigator();
  } else if (target.kind === 'navigator') {
    deps.showNavigator(target.window);
  } else if (options.editorOnly) {
    deps.openNavigator();
    deps.onEditorRequired(explicit ?? deps.getFocusedWindow());
  } else if (deps.showNavigator(null)) {
    deps.openNavigator();
  }
}

export function settingsHash(section?: SettingsSection): string {
  if (section === undefined) return '#settings';
  return `#settings/${section}`;
}

export function settingsHashScript(section?: SettingsSection): string {
  return `window.location.hash = ${JSON.stringify(settingsHash(section))}; undefined`;
}

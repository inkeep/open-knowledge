/**
 * Entry resolution + theme resolution for the React uninstall renderer window
 * (`packages/app/uninstall.html`).
 *
 * Kept free of `electron` imports so the resolution logic is unit-testable in
 * the node tier; `index.ts` owns the `BrowserWindow` construction and passes
 * the process-shaped inputs in.
 */

import { join } from 'node:path';

/** Appearance the uninstall renderer paints its FIRST frame in. */
export type UninstallWindowTheme = 'light' | 'dark';

/**
 * Query key carrying the main-resolved theme to `uninstall.html`. Its inline
 * head script reads this key synchronously and adds the `dark` class before
 * the body parses, so the first painted frame is already correct.
 *
 * The uninstall window is a distinct `file://` document and cannot read the
 * editor renderer's persisted next-themes value, so main is the only party
 * that can answer "which theme". Keep in sync with the reader in
 * `packages/app/uninstall.html` — the contract is covered by
 * `tests/main/uninstall-window-theme-stamp.test.ts`, which executes that
 * script against a URL built from `resolveUninstallEntryTarget`.
 */
const UNINSTALL_THEME_QUERY_KEY = 'theme';

const UNINSTALL_HTML = 'uninstall.html';

/**
 * Where the uninstall renderer is loaded from. `url` is the electron-vite dev
 * server; `file` is a built bundle, whose `query` must be passed through to
 * `loadFile` so it survives into `location.search`.
 */
export type UninstallEntryTarget =
  | { readonly kind: 'url'; readonly url: string }
  | { readonly kind: 'file'; readonly path: string; readonly query: Record<string, string> };

export interface UninstallEntryDeps {
  /** electron-vite dev-server origin (`process.env.ELECTRON_RENDERER_URL`), or null. */
  readonly devServerUrl: string | null;
  /** `app.isPackaged`. */
  readonly isPackaged: boolean;
  /** `process.resourcesPath`. */
  readonly resourcesPath: string;
  /** `__dirname` of the running main bundle (`out/main`). */
  readonly mainDir: string;
}

/**
 * Resolve the uninstall window's theme from main-readable state.
 *
 * `nativeTheme.shouldUseDarkColors` is the right input rather than a raw OS
 * read: the editor renderer pushes the user's chosen theme into main through
 * `ok:theme:set-source`, so this resolves the APP's current appearance — a
 * user running the app in light mode on a dark OS gets a light uninstall
 * window. With no editor window opened this session the source is still
 * `'system'` and the value degrades to the OS preference, which is the
 * closest answer available: `themeSource` is deliberately not persisted (see
 * `theme-handler.ts`), so no other main-readable record of the app's theme
 * exists.
 */
export function resolveUninstallWindowTheme(shouldUseDarkColors: boolean): UninstallWindowTheme {
  return shouldUseDarkColors ? 'dark' : 'light';
}

/**
 * Whether closing the OS window on a notice CONFIRMS it (vs cancels).
 *
 * A one-button notice is an acknowledgement (`cancelLabel` absent) with no
 * "cancel" answer, so closing it proceeds; a two-button notice is a question
 * (`cancelLabel` present) whose safe answer is cancel, so a close cancels. This
 * gate is irreversible on the destructive confirm screen — a stray ⌘W or
 * window-manager close must not uninstall — so it lives here as a pure,
 * always-on-tested helper rather than only inline in the window closure, where
 * an inversion (`!== undefined`) would compile clean and ship green, reachable
 * only by the opt-in `OK_DESKTOP_E2E_SMOKE` E2E.
 */
export function noticeCloseIsConfirm(spec: { readonly cancelLabel?: string }): boolean {
  return spec.cancelLabel === undefined;
}

/**
 * Resolve where to load `uninstall.html` from, mirroring the three-way split
 * `index.ts` uses for `index.html`: dev server when electron-vite exports one,
 * `<Resources>/app/` in a packaged build (electron-builder copies
 * `packages/cli/dist/public/` there), and `out/renderer/` when running the
 * unpackaged build directly with no dev server.
 */
export function resolveUninstallEntryTarget(
  deps: UninstallEntryDeps,
  theme: UninstallWindowTheme,
): UninstallEntryTarget {
  if (deps.devServerUrl !== null && deps.devServerUrl !== '') {
    const origin = deps.devServerUrl.replace(/\/+$/, '');
    return {
      kind: 'url',
      url: `${origin}/${UNINSTALL_HTML}?${UNINSTALL_THEME_QUERY_KEY}=${theme}`,
    };
  }
  return {
    kind: 'file',
    path: deps.isPackaged
      ? join(deps.resourcesPath, 'app', UNINSTALL_HTML)
      : join(deps.mainDir, '..', 'renderer', UNINSTALL_HTML),
    query: { [UNINSTALL_THEME_QUERY_KEY]: theme },
  };
}

/** The `BrowserWindow` load surface, narrowed to what entry loading needs. */
export interface UninstallEntryLoaderLike {
  loadURL(url: string): Promise<void>;
  loadFile(filePath: string, options?: { query?: Record<string, string> }): Promise<void>;
}

/**
 * Load a resolved entry target. `loadFile` (not `loadURL` over a hand-built
 * `file://` string) is what keeps the packaged path working: it resolves the
 * path per-platform and encodes the query for us.
 */
export function loadUninstallEntry(
  loader: UninstallEntryLoaderLike,
  target: UninstallEntryTarget,
): Promise<void> {
  return target.kind === 'url'
    ? loader.loadURL(target.url)
    : loader.loadFile(target.path, { query: target.query });
}

import { join } from 'node:path';

export type UninstallWindowTheme = 'light' | 'dark';

const UNINSTALL_THEME_QUERY_KEY = 'theme';

const UNINSTALL_HTML = 'uninstall.html';

export type UninstallEntryTarget =
  | { readonly kind: 'url'; readonly url: string }
  | { readonly kind: 'file'; readonly path: string; readonly query: Record<string, string> };

export interface UninstallEntryDeps {
  readonly devServerUrl: string | null;
  readonly isPackaged: boolean;
  readonly resourcesPath: string;
  readonly mainDir: string;
}

export function resolveUninstallWindowTheme(shouldUseDarkColors: boolean): UninstallWindowTheme {
  return shouldUseDarkColors ? 'dark' : 'light';
}

export function noticeCloseIsConfirm(spec: { readonly cancelLabel?: string }): boolean {
  return spec.cancelLabel === undefined;
}

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

export interface UninstallEntryLoaderLike {
  loadURL(url: string): Promise<void>;
  loadFile(filePath: string, options?: { query?: Record<string, string> }): Promise<void>;
}

export function loadUninstallEntry(
  loader: UninstallEntryLoaderLike,
  target: UninstallEntryTarget,
): Promise<void> {
  return target.kind === 'url'
    ? loader.loadURL(target.url)
    : loader.loadFile(target.path, { query: target.query });
}

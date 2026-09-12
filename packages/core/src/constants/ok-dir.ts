export const OK_DIR = '.ok';

export const OK_PROJECT_MARKER = '.ok/config.yml';

export const LOCAL_DIR = 'local';

export const SAVED_THEMES_DIRNAME = 'themes';

export const OK_BIN_DIRNAME = 'bin';

export function posixOkManagedBinDir(homeDir: string): string {
  const base = homeDir.replace(/\/+/g, '/').replace(/\/+$/, '');
  return `${base}/${OK_DIR}/${OK_BIN_DIRNAME}`;
}

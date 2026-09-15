export const OK_DIR = '.ok';

export const OK_PROJECT_MARKER = '.ok/config.yml';

export const LOCAL_DIR = 'local';

export const WORKTREES_DIRNAME = 'worktrees';

export const SAVED_THEMES_DIRNAME = 'themes';

export const OK_BIN_DIRNAME = 'bin';

export const OK_MACHINE_LOCAL_ROOT_FILES = [
  'principal.json',
  'state.json',
  'server.lock',
  'ui.lock',
  'sync-state.json',
  'conflicts.json',
  'last-spawn-error.log',
] as const;

export const OK_ACTIVE_MACHINE_LOCAL_ROOT_DIRS = [LOCAL_DIR, WORKTREES_DIRNAME] as const;

export const OK_MACHINE_LOCAL_ROOT_DIRS = [
  ...OK_ACTIVE_MACHINE_LOCAL_ROOT_DIRS,
  'cache',
  'tmp',
] as const;

export type OkMachineLocalRootDir = (typeof OK_MACHINE_LOCAL_ROOT_DIRS)[number];

export type OkMachineLocalRootFile = (typeof OK_MACHINE_LOCAL_ROOT_FILES)[number];

const activeMachineLocalRootDirs: ReadonlySet<string> = new Set(OK_ACTIVE_MACHINE_LOCAL_ROOT_DIRS);

export const OK_LEGACY_MACHINE_LOCAL_ROOT_DIRS: readonly OkMachineLocalRootDir[] =
  OK_MACHINE_LOCAL_ROOT_DIRS.filter((name) => !activeMachineLocalRootDirs.has(name));

export function posixOkManagedBinDir(homeDir: string): string {
  const base = homeDir.replace(/\/+/g, '/').replace(/\/+$/, '');
  return `${base}/${OK_DIR}/${OK_BIN_DIRNAME}`;
}

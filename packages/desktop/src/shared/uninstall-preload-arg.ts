export const UNINSTALL_PRELOAD_ARG = '--ok-uninstall=1';

export function isUninstallPreload(argv: readonly string[]): boolean {
  return argv.includes(UNINSTALL_PRELOAD_ARG);
}

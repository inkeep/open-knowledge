/**
 * The argv flag main sets on the self-uninstall window so the preload knows to
 * expose `okUninstall` instead of the editor's `okDesktop` bridge.
 *
 * Lives in `shared/` because it is a main↔preload contract with both halves in
 * this package: main passes it through `webPreferences.additionalArguments`,
 * preload reads it off `process.argv`. Same `--ok-*` convention as the editor
 * windows' bound config.
 */

export const UNINSTALL_PRELOAD_ARG = '--ok-uninstall=1';

export function isUninstallPreload(argv: readonly string[]): boolean {
  return argv.includes(UNINSTALL_PRELOAD_ARG);
}

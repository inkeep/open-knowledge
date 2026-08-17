/**
 * Host capability gates shared by the settings shell and body.
 *
 * These two files have to agree: the shell decides whether a sidebar item and
 * its search entry exist, the body decides whether the matching block renders.
 * When they were separate copies of the same expression, a search result could
 * point at a block that never mounts (or a rendered block could be unreachable
 * from search) with nothing but a comment holding them together. Reading both
 * from here makes disagreement unrepresentable.
 *
 * Evaluated per call rather than at module load: the Electron preload attaches
 * `window.okDesktop` after the bundle is parsed, and tests stub it per case.
 */

/** The Electron preload bridge is present, so desktop-only surfaces exist. */
export function isOkDesktopHost(): boolean {
  return typeof window !== 'undefined' && window.okDesktop != null;
}

/**
 * The docked terminal is pty-backed, and node-pty is not bundled on every
 * platform, so a desktop host is necessary but not sufficient.
 */
export function isTerminalSettingsAvailable(): boolean {
  return isOkDesktopHost() && window.okDesktop?.config.ptyAvailable === true;
}

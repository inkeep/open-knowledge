export function isOkDesktopHost(): boolean {
  return typeof window !== 'undefined' && window.okDesktop != null;
}

export function isTerminalSettingsAvailable(): boolean {
  return isOkDesktopHost() && window.okDesktop?.config.ptyAvailable === true;
}

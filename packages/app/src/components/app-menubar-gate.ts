export function shouldShowAppMenubar(): boolean {
  if (typeof window === 'undefined') return false;
  const bridge = window.okDesktop;
  return (
    bridge != null &&
    bridge.menu != null &&
    bridge.platform !== 'darwin' &&
    bridge.config?.mode !== 'note'
  );
}

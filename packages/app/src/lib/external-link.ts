import { isSafeNavigationUrl } from '@/editor/safe-navigation-url';

export function dispatchExternalLinkClick(e: { preventDefault: () => void }, url: string): void {
  const openExternal = window.okDesktop?.shell?.openExternal;
  if (!openExternal) return;
  e.preventDefault();
  void openExternal(url).catch((err: unknown) => {
    console.warn('[external-link] openExternal failed', url, err);
  });
}

interface OpenExternalUrlDeps {
  readonly okDesktop?: { shell?: { openExternal?: (url: string) => Promise<void> } };
  readonly openWindow?: (url: string, target: string, features: string) => unknown;
}

export function openExternalUrl(url: string, deps: OpenExternalUrlDeps = {}): void {
  if (!isSafeNavigationUrl(url)) {
    console.warn('[external-link] blocked non-safe scheme', url);
    return;
  }
  const globalBridge = typeof window !== 'undefined' ? window.okDesktop : undefined;
  const okDesktop = 'okDesktop' in deps ? deps.okDesktop : globalBridge;
  const openExternal = okDesktop?.shell?.openExternal;
  if (openExternal) {
    void openExternal(url).catch((err: unknown) => {
      console.warn('[external-link] openExternal failed', url, err);
    });
    return;
  }
  const globalOpen = typeof window !== 'undefined' ? window.open.bind(window) : undefined;
  const openWindow = deps.openWindow ?? globalOpen;
  openWindow?.(url, '_blank', 'noopener,noreferrer');
}

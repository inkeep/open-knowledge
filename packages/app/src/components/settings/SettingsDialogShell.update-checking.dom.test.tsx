import { act, cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterAll, afterEach, describe, expect, test, vi } from 'vitest';

type WindowGlobals = { MutationObserver?: typeof MutationObserver; NodeFilter?: typeof NodeFilter };
type GlobalWithDomShims = typeof globalThis &
  WindowGlobals & { window?: WindowGlobals; ResizeObserver?: unknown };
const globalWithDomShims = globalThis as GlobalWithDomShims;
if (
  globalWithDomShims.MutationObserver === undefined &&
  globalWithDomShims.window?.MutationObserver !== undefined
) {
  globalWithDomShims.MutationObserver = globalWithDomShims.window.MutationObserver;
}
if (
  globalWithDomShims.NodeFilter === undefined &&
  globalWithDomShims.window?.NodeFilter !== undefined
) {
  globalWithDomShims.NodeFilter = globalWithDomShims.window.NodeFilter;
}
if (globalWithDomShims.ResizeObserver === undefined) {
  class NoopResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  globalWithDomShims.ResizeObserver = NoopResizeObserver;
}

vi.doMock('@/components/settings/SettingsDialogBodyLazy', () => ({
  SettingsDialogBodyLazy: () => <div data-testid="settings-body-probe" />,
}));

vi.doMock('@/components/ui/dialog', () => ({
  Dialog: ({ children, open }: { children?: ReactNode; open?: boolean }) =>
    open ? <div role="dialog">{children}</div> : null,
  DialogContent: ({ children, ...props }: { children?: ReactNode; [key: string]: unknown }) => (
    <div {...props}>{children}</div>
  ),
  DialogDescription: ({ children }: { children?: ReactNode }) => <p>{children}</p>,
  DialogTitle: ({ children, id }: { children?: ReactNode; id?: string }) => (
    <h2 id={id}>{children}</h2>
  ),
}));

vi.doMock('@/components/ui/skeleton', () => ({
  Skeleton: ({ className }: { className?: string }) => <div className={className} />,
}));

vi.doMock('@/editor/DocumentContext', () => ({
  useDocumentContext: () => ({ collabUrl: 'ws://test.invalid' }),
}));

vi.doMock('@/lib/config-provider', () => ({
  useConfigContext: () => ({
    userBinding: null,
    userSynced: false,
    okignoreBinding: null,
    okignoreSynced: false,
  }),
}));

vi.doMock('@/lib/handoff/use-claude-desktop-integration', () => ({
  useClaudeDesktopIntegration: () => ({ desktopPresent: false }),
}));

type ManualCheckListener = (info: { phase: 'started' | 'settled' }) => void;
let manualCheckListener: ManualCheckListener | null = null;
const unsubscribe = () => () => {};
(window as unknown as { okDesktop?: unknown }).okDesktop = {
  appVersion: '1.2.3',
  config: { ptyAvailable: false },
  shell: { openExternal: () => Promise.resolve() },
  onUpdateDownloaded: unsubscribe,
  onUpdateRelaunching: unsubscribe,
  onUpdateFetchingLatest: unsubscribe,
  onUpdateRelaunchFailed: unsubscribe,
  onWhatsNew: unsubscribe,
  onWhatsNewDismissed: unsubscribe,
  onUpdateStuckHint: unsubscribe,
  onUpdateManualCheck: (listener: ManualCheckListener) => {
    manualCheckListener = listener;
    return () => {};
  },
  update: {
    relaunchNow: () => Promise.resolve(),
    checkNow: () => Promise.resolve(),
    dismissWhatsNew: () => Promise.resolve(),
  },
  state: {
    query: () => Promise.resolve({ channel: 'latest', schemaIncompatibility: null }),
    resetIncompatible: () => Promise.resolve(),
  },
};

const { installUpdateNoticesBridge } = await import('@/lib/update-notices-store');
const { SettingsDialogShell } = await import('./SettingsDialogShell');
installUpdateNoticesBridge();

describe('SettingsDialogShell sidebar update-check status', () => {
  afterEach(() => {
    act(() => manualCheckListener?.({ phase: 'settled' }));
    cleanup();
  });
  afterAll(() => {
    Reflect.deleteProperty(window, 'okDesktop');
  });

  test('shows Checking for updates while a manual check runs and clears it when the check settles', () => {
    render(<SettingsDialogShell open={true} onOpenChange={() => {}} />);
    expect(screen.getByTestId('settings-sidebar-version').textContent).toBe(
      'v1.2.3 About & updates',
    );
    const status = screen.getByTestId('settings-sidebar-update-checking');
    expect(status.getAttribute('role')).toBe('status');
    expect(status.textContent).toBe('');

    act(() => manualCheckListener?.({ phase: 'started' }));
    expect(screen.getByTestId('settings-sidebar-update-checking')).toBe(status);
    expect(status.textContent).toBe('Checking for updates…');

    act(() => manualCheckListener?.({ phase: 'settled' }));
    expect(screen.getByTestId('settings-sidebar-update-checking')).toBe(status);
    expect(status.textContent).toBe('');
  });

  test('a check already running when Settings opens shows at once', () => {
    act(() => manualCheckListener?.({ phase: 'started' }));
    render(<SettingsDialogShell open={true} onOpenChange={() => {}} />);
    expect(screen.getByTestId('settings-sidebar-update-checking').textContent).toBe(
      'Checking for updates…',
    );
  });
});

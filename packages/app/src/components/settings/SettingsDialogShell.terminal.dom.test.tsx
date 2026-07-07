/**
 * The Settings → Terminal nav item is desktop-only: the docked terminal has no
 * web host, so its per-project revoke toggle must only be reachable under the
 * Electron preload (`window.okDesktop`).
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';

mock.module('@inkeep/open-knowledge-core', () => ({
  SHOW_INSTALL_SKILL: false,
}));

mock.module('@lingui/react/macro', () => ({
  Trans: ({ children }: { children?: ReactNode }) => <>{children}</>,
  useLingui: () => ({
    t: (strings: TemplateStringsArray | string, ...values: unknown[]) => {
      if (typeof strings === 'string') return strings;
      return strings.reduce(
        (text, chunk, index) =>
          `${text}${chunk}${index < values.length ? String(values[index]) : ''}`,
        '',
      );
    },
  }),
}));

mock.module('@/components/settings/SettingsDialogBodyLazy', () => ({
  SettingsDialogBodyLazy: () => <div data-testid="settings-body-probe" />,
}));

mock.module('@/components/ui/dialog', () => ({
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

mock.module('@/components/ui/skeleton', () => ({
  Skeleton: ({ className }: { className?: string }) => <div className={className} />,
}));

mock.module('@/editor/DocumentContext', () => ({
  useDocumentContext: () => ({ collabUrl: 'ws://test.invalid' }),
}));

mock.module('@/lib/config-provider', () => ({
  useConfigContext: () => ({
    userBinding: null,
    userSynced: false,
    okignoreBinding: null,
    okignoreSynced: false,
  }),
}));

mock.module('@/lib/handoff/use-claude-desktop-integration', () => ({
  useClaudeDesktopIntegration: () => ({ desktopPresent: false }),
}));

const { SettingsDialogShell } = await import('./SettingsDialogShell');

function setDesktopHost(present: boolean) {
  const w = window as unknown as { okDesktop?: unknown };
  if (present) w.okDesktop = {};
  else {
    w.okDesktop = undefined;
  }
}

describe('SettingsDialogShell terminal nav item (desktop-only)', () => {
  beforeEach(() => setDesktopHost(false));
  afterEach(() => {
    cleanup();
    setDesktopHost(false);
  });

  test('shows the Terminal section under the Electron host', () => {
    setDesktopHost(true);
    render(<SettingsDialogShell open={true} onOpenChange={() => {}} />);
    expect(screen.getByTestId('settings-sidebar-item-terminal')).not.toBeNull();
  });

  test('hides the Terminal section on the web host (no okDesktop bridge)', () => {
    setDesktopHost(false);
    render(<SettingsDialogShell open={true} onOpenChange={() => {}} />);
    expect(screen.queryByTestId('settings-sidebar-item-terminal')).toBeNull();
  });
});

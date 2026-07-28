/**
 * The Settings → Terminal nav item is desktop-only: the docked terminal has no
 * web host, so its per-project revoke toggle must only be reachable under the
 * Electron preload (`window.okDesktop`).
 */

import * as actualLinguiMacro from '@lingui/react/macro';
import { cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.doMock('@inkeep/open-knowledge-core', () => ({
  SHOW_INSTALL_SKILL: false,
  MARKDOWNLINT_RULE_CATALOG: [],
}));

vi.doMock('@lingui/react/macro', () => ({
  ...actualLinguiMacro,
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

const { SettingsDialogShell } = await import('./SettingsDialogShell');

function setDesktopHost(present: boolean, opts: { ptyAvailable?: boolean } = {}) {
  const w = window as unknown as { okDesktop?: unknown };
  if (present) {
    // The Terminal section additionally gates on the host's pty capability
    // (`config.ptyAvailable`, false on win/linux where node-pty isn't
    // bundled) — model the capable macOS host by default.
    w.okDesktop = { config: { ptyAvailable: opts.ptyAvailable ?? true } };
  } else {
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

  test('hides the Terminal section on a pty-less Electron host (win/linux)', () => {
    setDesktopHost(true, { ptyAvailable: false });
    render(<SettingsDialogShell open={true} onOpenChange={() => {}} />);
    expect(screen.queryByTestId('settings-sidebar-item-terminal')).toBeNull();
  });
});

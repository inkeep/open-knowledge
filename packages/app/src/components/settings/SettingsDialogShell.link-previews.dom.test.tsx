/**
 * The Settings → Link previews nav item is hidden on the packaged file://
 * renderer: a file: page's POST /api/link-preview carries Origin: null, which
 * the route's anti-proxy gate rejects by design
 * (packages/server/src/link-preview/request-gate.ts), so external link
 * previews can never render there. Every other host (web, ok ui, and the DEV
 * desktop renderer on http://localhost — a loopback Origin the gate passes)
 * keeps the item.
 *
 * jsdom's window.location is unforgeable, so the test stubs the
 * `isFileProtocolPage` helper seam instead — the same mock.module capability
 * faking the terminal desktop-only test uses for the Electron bridge.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';

let fileProtocolPage = false;

mock.module('@/lib/file-protocol-page', () => ({
  isFileProtocolPage: () => fileProtocolPage,
}));

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

describe('SettingsDialogShell link-previews nav item (no file:// renderer)', () => {
  beforeEach(() => {
    fileProtocolPage = false;
  });
  afterEach(() => {
    cleanup();
    fileProtocolPage = false;
  });

  test('hides the Link previews section on a file: page (packaged desktop)', () => {
    fileProtocolPage = true;
    render(<SettingsDialogShell open={true} onOpenChange={() => {}} />);
    expect(screen.queryByTestId('settings-sidebar-item-link-previews')).toBeNull();
  });

  test('shows the Link previews section on http(s) hosts (web, dev desktop)', () => {
    fileProtocolPage = false;
    render(<SettingsDialogShell open={true} onOpenChange={() => {}} />);
    expect(screen.getByTestId('settings-sidebar-item-link-previews')).not.toBeNull();
  });
});

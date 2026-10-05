import { cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { createServedBindingLog } from '@/test-utils/served-binding.test-helper';

const servedCore = createServedBindingLog();

vi.doMock('@inkeep/open-knowledge-core/constants/feature-flags', () =>
  servedCore.serve('@inkeep/open-knowledge-core/constants/feature-flags', {
    SHOW_INSTALL_SKILL: false,
  }),
);

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
  useClaudeDesktopIntegration: () => ({
    desktopPresent: true,
  }),
}));

const { SettingsDialogShell } = await import('./SettingsDialogShell');

describe('SettingsDialogShell install-skill feature gate', () => {
  afterEach(() => {
    cleanup();
  });

  test('hides the Claude Desktop integration when the install-skill flag is off', () => {
    render(<SettingsDialogShell open={true} onOpenChange={() => {}} />);

    expect(screen.queryByTestId('settings-sidebar-item-claude-desktop')).toBeNull();
    expect(screen.queryByText('Integrations')).toBeNull();
  });

  test('the Claude Desktop integration is hidden because the feature-flag replacement serves the install-skill flag off', () => {
    const since = servedCore.mark();
    render(<SettingsDialogShell open={true} onOpenChange={() => {}} />);

    expect(screen.getByTestId('settings-sidebar-item-preferences')).toBeTruthy();
    expect(screen.queryByTestId('settings-sidebar-item-claude-desktop')).toBeNull();
    expect(
      servedCore.readersOf(
        '@inkeep/open-knowledge-core/constants/feature-flags',
        'SHOW_INSTALL_SKILL',
        since,
      ),
    ).toEqual(['components/settings/SettingsDialogShell.tsx']);
  });
});

import * as actualLinguiMacro from '@lingui/react/macro';
import { cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';

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
});

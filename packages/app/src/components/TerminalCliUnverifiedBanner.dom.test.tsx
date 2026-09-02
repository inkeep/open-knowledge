import * as actualLinguiMacro from '@lingui/react/macro';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';

vi.doMock('@lingui/react/macro', () => ({
  ...actualLinguiMacro,
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.reduce((acc, part, index) => `${acc}${part}${values[index] ?? ''}`, ''),
  }),
}));

const { TerminalCliUnverifiedBanner } = await import('./TerminalCliUnverifiedBanner');

describe('TerminalCliUnverifiedBanner', () => {
  afterEach(() => {
    cleanup();
  });

  test('names the brand + binary without claiming absence, as an announced status strip', () => {
    render(<TerminalCliUnverifiedBanner cli="codex" onDismiss={() => {}} />);

    expect(screen.getByText(/Couldn't verify that Codex \(codex\) is available/)).toBeTruthy();
    expect(screen.queryByText(/isn't installed/)).toBeNull();

    const banner = screen.getByTestId('terminal-cli-unverified-banner');
    expect(banner.getAttribute('role')).toBe('status');
  });

  test('renders the registry binary for a CLI whose bin differs from its id', () => {
    render(<TerminalCliUnverifiedBanner cli="cursor" onDismiss={() => {}} />);

    expect(
      screen.getByText(/Couldn't verify that Cursor \(cursor-agent\) is available/),
    ).toBeTruthy();
  });

  test('the dismiss control fires onDismiss', async () => {
    const onDismiss = vi.fn(() => {});
    render(<TerminalCliUnverifiedBanner cli="claude" onDismiss={onDismiss} />);

    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});

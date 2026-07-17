import { afterEach, describe, expect, mock, test } from 'bun:test';
import { cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { renderLinguiTemplate } from '@/test-utils/lingui-mock';

let channel: 'beta' | 'latest' | null = null;

import * as actualLinguiMacro from '@lingui/react/macro';

mock.module('@lingui/react/macro', () => ({
  ...actualLinguiMacro,
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
  useLingui: () => ({ t: renderLinguiTemplate }),
}));

mock.module('@/hooks/use-update-channel', () => ({
  useUpdateChannel: () => ({ channel }),
}));

async function renderBetaBadge(className?: string) {
  const { BetaBadge } = await import('./BetaBadge');
  return render(<BetaBadge className={className} />);
}

describe('BetaBadge runtime behavior', () => {
  afterEach(() => {
    cleanup();
    channel = null;
  });

  test('exports the component', async () => {
    const mod = await import('./BetaBadge');
    expect(typeof mod.BetaBadge).toBe('function');
  });

  test('renders nothing while the channel is null or latest', async () => {
    channel = null;
    const { rerender } = await renderBetaBadge();
    expect(screen.queryByTestId('beta-badge')).toBeNull();

    channel = 'latest';
    const { BetaBadge } = await import('./BetaBadge');
    rerender(<BetaBadge />);
    expect(screen.queryByTestId('beta-badge')).toBeNull();
  });

  test('renders an accessible secondary badge for the beta channel', async () => {
    channel = 'beta';
    await renderBetaBadge('ml-2');

    const badge = screen.getByTestId('beta-badge');
    expect(badge.textContent).toBe('BETA');
    expect(badge.getAttribute('aria-label')).toBe('Beta channel');
    expect(badge.getAttribute('data-slot')).toBe('badge');
    expect(badge.getAttribute('data-variant')).toBe('secondary');
    expect(badge.classList.contains('ml-2')).toBe(true);
  });
});

import { cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { renderLinguiTemplate } from '@/test-utils/lingui-mock';

vi.doMock('@lingui/react/macro', () => ({
  useLingui: () => ({ t: renderLinguiTemplate }),
}));

// Tooltip is decorative chrome; pass its parts through so the badge renders
// without a TooltipProvider ancestor.
vi.doMock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

function setOkDesktop(value: { instanceLabel: string | null } | undefined): void {
  (window as unknown as { okDesktop?: { instanceLabel: string | null } }).okDesktop = value;
}

async function renderInstanceBadge(className?: string) {
  const { InstanceBadge } = await import('./InstanceBadge');
  return render(<InstanceBadge className={className} />);
}

describe('InstanceBadge runtime behavior', () => {
  afterEach(() => {
    cleanup();
    setOkDesktop(undefined);
  });

  test('renders nothing without a desktop host (web / CLI distribution)', async () => {
    setOkDesktop(undefined);
    await renderInstanceBadge();
    expect(screen.queryByTestId('instance-badge')).toBeNull();
  });

  test('renders nothing when the host reports no instance label (default install)', async () => {
    setOkDesktop({ instanceLabel: null });
    await renderInstanceBadge();
    expect(screen.queryByTestId('instance-badge')).toBeNull();
  });

  test('renders the branch label for a named parallel instance', async () => {
    setOkDesktop({ instanceLabel: 'theming-as-plugin' });
    await renderInstanceBadge('ml-1');

    const badge = screen.getByTestId('instance-badge');
    expect(badge.textContent).toContain('theming-as-plugin');
    expect(badge.getAttribute('aria-label')).toBe('Dev instance: theming-as-plugin');
    expect(badge.getAttribute('data-variant')).toBe('secondary');
    expect(badge.classList.contains('ml-1')).toBe(true);
  });
});

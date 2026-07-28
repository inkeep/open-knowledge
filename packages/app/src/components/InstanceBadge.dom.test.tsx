import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { renderLinguiTemplate } from '@/test-utils/lingui-mock';

vi.doMock('@lingui/react/macro', () => ({
  useLingui: () => ({ t: renderLinguiTemplate }),
}));

function setOkDesktop(value: { instanceLabel: string | null } | undefined): void {
  (window as unknown as { okDesktop?: { instanceLabel: string | null } }).okDesktop = value;
}

async function renderInstanceBadge(className?: string) {
  const { InstanceBadge } = await import('./InstanceBadge');
  return render(
    <TooltipProvider>
      <InstanceBadge className={className} />
    </TooltipProvider>,
  );
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

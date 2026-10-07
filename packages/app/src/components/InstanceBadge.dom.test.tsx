import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { renderLinguiTemplate } from '@/test-utils/lingui-mock';

vi.doMock('@lingui/react/macro', () => ({
  useLingui: () => ({ t: renderLinguiTemplate }),
}));

function setOkDesktop(
  value: { instanceLabel: string | null; appVersion?: string } | undefined,
): void {
  (window as unknown as { okDesktop?: unknown }).okDesktop = value;
}

function expectAnnouncedInPlaceOfLabel(badge: HTMLElement, label: string, announced: string) {
  const announcement = within(badge).getByText(announced);
  expect(announcement.classList.contains('sr-only')).toBe(true);
  expect(announcement.closest('[aria-hidden="true"]')).toBeNull();
  expect(within(badge).getByText(label).getAttribute('aria-hidden')).toBe('true');
}

async function renderInstanceBadge(className?: string) {
  const { InstanceBadge } = await import('./InstanceBadge');
  return render(
    <TooltipProvider delayDuration={0}>
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
    expectAnnouncedInPlaceOfLabel(badge, 'theming-as-plugin', 'App instance: theming-as-plugin');
    expect(badge.getAttribute('data-variant')).toBe('secondary');
    expect(badge.classList.contains('ml-1')).toBe(true);
  });

  test('is a static label, not something that looks clickable', async () => {
    setOkDesktop({ instanceLabel: 'Cloud', appVersion: '0.81.5' });
    await renderInstanceBadge();

    const badge = screen.getByTestId('instance-badge');
    expect(badge.tagName).toBe('SPAN');
    expect(badge.getAttribute('role')).toBeNull();
    expect(badge.querySelector('svg')).toBeNull();
    expect(badge.classList.contains('cursor-default')).toBe(true);
  });

  test('its tooltip names the build and its version', async () => {
    setOkDesktop({ instanceLabel: 'Cloud', appVersion: '0.81.5' });
    await renderInstanceBadge();

    await userEvent.hover(screen.getByTestId('instance-badge'));
    const tooltip = await screen.findByRole('tooltip');
    expect(tooltip.textContent).toContain('Cloud build, v0.81.5.');
    expect(tooltip.textContent).toContain('kept separate from other OpenKnowledge apps');
  });

  test('announces the build and its version to assistive tech', async () => {
    setOkDesktop({ instanceLabel: 'Cloud', appVersion: '0.81.5' });
    await renderInstanceBadge();

    expectAnnouncedInPlaceOfLabel(
      screen.getByTestId('instance-badge'),
      'Cloud',
      'App instance: Cloud, v0.81.5',
    );
  });

  test('a keyboard user reaches the build and its version without hovering', async () => {
    setOkDesktop({ instanceLabel: 'Cloud', appVersion: '0.81.5' });
    await renderInstanceBadge();

    await userEvent.tab();
    expect(document.activeElement).toBe(screen.getByTestId('instance-badge'));
    expect(await screen.findByRole('tooltip', { name: /^Cloud build, v0\.81\.5\./ })).toBeTruthy();
  });

  test('treats the 0.0.0 placeholder version as unknown', async () => {
    setOkDesktop({ instanceLabel: 'Cloud', appVersion: '0.0.0' });
    await renderInstanceBadge();

    const badge = screen.getByTestId('instance-badge');
    expectAnnouncedInPlaceOfLabel(badge, 'Cloud', 'App instance: Cloud');
    await userEvent.hover(badge);
    const tooltip = await screen.findByRole('tooltip');
    expect(tooltip.textContent).toContain('Cloud build.');
    expect(tooltip.textContent).not.toContain('0.0.0');
  });

  test('its tooltip leaves the version out when the host does not report one', async () => {
    setOkDesktop({ instanceLabel: 'Cloud' });
    await renderInstanceBadge();

    await userEvent.hover(screen.getByTestId('instance-badge'));
    const tooltip = await screen.findByRole('tooltip');
    expect(tooltip.textContent).toContain('Cloud build.');
    expect(tooltip.textContent).not.toContain('undefined');
  });
});

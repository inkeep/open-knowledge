import * as actualLinguiMacro from '@lingui/react/macro';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { renderLinguiTemplate } from '@/test-utils/lingui-mock';

vi.doMock('@lingui/react/macro', () => ({
  ...actualLinguiMacro,
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
  useLingui: () => ({ t: renderLinguiTemplate }),
}));

type BadgeProps = { problemCount?: number; problemMessages?: readonly string[] };

async function renderButton(props: BadgeProps = {}) {
  const { AddPropertiesButton } = await import('./AddPropertiesButton');
  const onAddProperty = vi.fn();
  render(
    <TooltipProvider>
      <AddPropertiesButton onAddProperty={onAddProperty} {...props} />
    </TooltipProvider>,
  );
  return { onAddProperty };
}

describe('AddPropertiesButton frontmatter badge', () => {
  afterEach(() => cleanup());

  test('renders no badge when there are no frontmatter problems', async () => {
    await renderButton();
    expect(screen.queryByTestId('add-properties-problem-badge')).toBeNull();
  });

  test('renders the count when frontmatter problems exist', async () => {
    await renderButton({ problemCount: 2 });
    expect(screen.getByTestId('add-properties-problem-badge').textContent).toBe('2');
  });

  test('carries the count in the accessible name, not only the visual badge', async () => {
    await renderButton({ problemCount: 1 });
    expect(screen.getByRole('button').getAttribute('aria-label')).toMatch(
      /1 required property missing/,
    );
    expect(screen.getByTestId('add-properties-problem-badge').getAttribute('aria-hidden')).toBe(
      'true',
    );
  });

  test('caps the badge label so a large count stays legible', async () => {
    await renderButton({ problemCount: 42 });
    expect(screen.getByTestId('add-properties-problem-badge').textContent).toBe('9+');
    expect(screen.getByRole('button').getAttribute('aria-label')).toMatch(
      /42 required properties missing/,
    );
  });

  test('still opens the add-property form when badged', async () => {
    const { onAddProperty } = await renderButton({ problemCount: 3 });
    await userEvent.click(screen.getByRole('button'));
    expect(onAddProperty).toHaveBeenCalledTimes(1);
  });

  test('lists each missing-property message in the tooltip', async () => {
    const user = userEvent.setup();
    await renderButton({
      problemCount: 2,
      problemMessages: [
        'Frontmatter property "status" is required',
        'Frontmatter property "owner" is required',
      ],
    });
    await user.hover(screen.getByRole('button'));
    const tooltip = await screen.findByRole('tooltip');
    expect(tooltip.textContent).toContain('Frontmatter property "status" is required');
    expect(tooltip.textContent).toContain('Frontmatter property "owner" is required');
  });

  test('tells the user the button acts on the problems it reports', async () => {
    const user = userEvent.setup();
    await renderButton({
      problemCount: 1,
      problemMessages: ['Frontmatter property "status" is required'],
    });
    await user.hover(screen.getByRole('button'));
    const tooltip = await screen.findByRole('tooltip');
    expect(tooltip.textContent).toMatch(/click to add/i);
  });
});

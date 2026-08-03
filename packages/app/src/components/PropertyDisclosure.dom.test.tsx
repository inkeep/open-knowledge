/**
 * The Properties disclosure carries two independent counts: how many properties
 * the document has, and how many of them violate its schema. These pin that they
 * stay distinct — a single recolored number would answer the first question
 * while appearing to answer the second.
 */

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

async function renderDisclosure(
  props: { count?: number; problemCount?: number; problemMessages?: readonly string[] } = {},
) {
  const { PropertyDisclosure } = await import('./PropertyDisclosure');
  render(
    <TooltipProvider>
      <PropertyDisclosure title="Properties" {...props}>
        <div>rows</div>
      </PropertyDisclosure>
    </TooltipProvider>,
  );
}

describe('PropertyDisclosure schema-problem badge', () => {
  afterEach(() => cleanup());

  test('shows no problem badge when every property is valid', async () => {
    await renderDisclosure({ count: 4 });
    expect(screen.queryByTestId('property-problem-badge')).toBeNull();
  });

  test('shows the problem count beside the property count, not instead of it', async () => {
    await renderDisclosure({ count: 4, problemCount: 2 });
    expect(screen.getByTestId('property-problem-badge').textContent).toBe('2');
    // The property count survives — both numbers are on screen and they differ.
    expect(screen.getByText('4')).toBeTruthy();
  });

  test('names the problem count for assistive tech', async () => {
    await renderDisclosure({ count: 3, problemCount: 1 });
    // The name lives on the focusable trigger, not the decorative badge inside it.
    expect(screen.getByTestId('property-problem-badge-trigger').getAttribute('aria-label')).toMatch(
      /1 property does not match the schema/,
    );
    expect(screen.getByTestId('property-problem-badge').getAttribute('aria-hidden')).toBe('true');
  });

  test('pluralizes the accessible name', async () => {
    await renderDisclosure({ count: 5, problemCount: 3 });
    expect(screen.getByTestId('property-problem-badge-trigger').getAttribute('aria-label')).toMatch(
      /3 properties do not match the schema/,
    );
  });

  test('caps the badge label, matching its sibling on the toolbar', async () => {
    await renderDisclosure({ count: 4, problemCount: 42 });
    expect(screen.getByTestId('property-problem-badge').textContent).toBe('9+');
    // The true count still reaches assistive tech uncapped.
    expect(screen.getByTestId('property-problem-badge-trigger').getAttribute('aria-label')).toMatch(
      /42 properties do not match the schema/,
    );
  });

  test('renders a problem badge even when the property count is hidden', async () => {
    // `count` renders nothing at 0; the problem badge must not ride on it.
    await renderDisclosure({ count: 0, problemCount: 1 });
    expect(screen.getByTestId('property-problem-badge').textContent).toBe('1');
  });

  test('surfaces the messages on keyboard focus, not just hover', async () => {
    // The badge used to sit INSIDE the collapsible trigger button, where it
    // could never take focus (HTML forbids interactive content inside a
    // button), so the per-message detail was mouse-only.
    const user = userEvent.setup();
    await renderDisclosure({
      count: 4,
      problemCount: 1,
      problemMessages: ['status is not one of the allowed values'],
    });
    const trigger = screen.getByTestId('property-problem-badge-trigger');
    await user.tab();
    await user.tab();
    expect(document.activeElement).toBe(trigger);
    const tooltip = await screen.findByRole('tooltip');
    expect(tooltip.textContent).toContain('status is not one of the allowed values');
  });

  test('lists each schema-violation message in the badge tooltip', async () => {
    // The badge number is the pointer; the tooltip carries which properties are
    // wrong. Dropping the message list would silently reduce it to nothing.
    const user = userEvent.setup();
    await renderDisclosure({
      count: 4,
      problemCount: 2,
      problemMessages: ['status is not one of the allowed values', 'owner must be a string'],
    });
    await user.hover(screen.getByTestId('property-problem-badge'));
    const tooltip = await screen.findByRole('tooltip');
    expect(tooltip.textContent).toContain('status is not one of the allowed values');
    expect(tooltip.textContent).toContain('owner must be a string');
  });
});

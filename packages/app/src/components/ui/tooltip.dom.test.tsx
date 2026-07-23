import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { act } from 'react';
import { afterEach, describe, expect, test } from 'vitest';
import {
  expectVisualClassTokens,
  expectVisualClassTokensAbsent,
} from '@/test-utils/visual-contract';

const UPSTREAM_MOTION_TOKENS = [
  'data-[side=bottom]:slide-in-from-top-2',
  'data-[side=left]:slide-in-from-right-2',
  'data-[side=right]:slide-in-from-left-2',
  'data-[side=top]:slide-in-from-bottom-2',
  'data-[state=delayed-open]:animate-in',
  'data-[state=delayed-open]:fade-in-0',
  'data-[state=delayed-open]:zoom-in-95',
  'data-open:animate-in',
  'data-open:fade-in-0',
  'data-open:zoom-in-95',
  'data-closed:animate-out',
  'data-closed:fade-out-0',
  'data-closed:zoom-out-95',
] as const;

const A11Y_OPT_IN_TOKENS = [
  'motion-reduce:data-open:animate-none',
  'motion-reduce:data-closed:animate-none',
  'motion-reduce:data-[state=delayed-open]:animate-none',
  'motion-reduce:duration-0',
] as const;

const SNAPPY_TOKENS = [
  'transition-[opacity,scale]',
  'ease-(--ease-out-strong)',
  'starting:opacity-0',
  'starting:scale-95',
  'data-closed:duration-0',
  'duration-100',
  'FORKED FROM radix-nova',
] as const;

async function renderOpenTooltip() {
  const { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } = await import('./tooltip');

  await act(async () => {
    render(
      <TooltipProvider>
        <Tooltip open={true}>
          <TooltipTrigger asChild>
            <button type="button">Target</button>
          </TooltipTrigger>
          <TooltipContent forceMount={true}>Tooltip body</TooltipContent>
        </Tooltip>
      </TooltipProvider>,
    );
    await Promise.resolve();
  });
}

describe('Tooltip runtime contracts', () => {
  afterEach(() => cleanup());

  test('exports the full Tooltip API surface', async () => {
    const mod = await import('./tooltip');
    for (const name of ['Tooltip', 'TooltipContent', 'TooltipProvider', 'TooltipTrigger']) {
      expect(typeof (mod as Record<string, unknown>)[name]).toBe('function');
    }
  });

  test('default provider delay opens the first hover without waiting for a timer', async () => {
    const { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } = await import('./tooltip');
    const user = userEvent.setup();

    render(
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <button type="button">Target</button>
          </TooltipTrigger>
          <TooltipContent>Tooltip body</TooltipContent>
        </Tooltip>
      </TooltipProvider>,
    );

    await user.hover(screen.getByRole('button', { name: 'Target' }));
    await Promise.resolve();

    expect(screen.getByRole('tooltip').textContent).toBe('Tooltip body');
  });

  test('content carries delayed-open motion and reduced-motion opt-in at runtime', async () => {
    await renderOpenTooltip();

    const content = document.querySelector('[data-slot="tooltip-content"]');
    expect(content).toBeTruthy();
    const className = content?.getAttribute('class') ?? '';

    expectVisualClassTokens(className, [
      ...UPSTREAM_MOTION_TOKENS,
      'origin-(--radix-tooltip-content-transform-origin)',
      ...A11Y_OPT_IN_TOKENS,
    ]);
  });

  test('snappy transition tier does not return', async () => {
    await renderOpenTooltip();

    const className =
      document.querySelector('[data-slot="tooltip-content"]')?.getAttribute('class') ?? '';

    expectVisualClassTokensAbsent(className, SNAPPY_TOKENS);
  });
});

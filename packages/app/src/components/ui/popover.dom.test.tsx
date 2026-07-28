import { cleanup, render } from '@testing-library/react';
import { act } from 'react';
import { afterEach, describe, expect, test } from 'vitest';
import {
  expectVisualClassTokens,
  expectVisualClassTokensAbsent,
} from '@/test-utils/visual-contract';

const A11Y_OPT_IN = [
  'motion-reduce:data-open:animate-none',
  'motion-reduce:data-closed:animate-none',
  'motion-reduce:duration-0',
] as const;

const SNAPPY_TOKENS = [
  'transition-[opacity,scale]',
  'ease-(--ease-out-strong)',
  'starting:opacity-0',
  'starting:scale-95',
  'data-closed:duration-0',
  'FORKED FROM radix-nova',
] as const;

async function renderPopoverContent() {
  const { Popover, PopoverContent, PopoverTrigger } = await import('./popover');

  await act(async () => {
    render(
      <Popover open={true}>
        <PopoverTrigger>Open</PopoverTrigger>
        <PopoverContent forceMount={true}>Popover body</PopoverContent>
      </Popover>,
    );
    await Promise.resolve();
  });
}

describe('Popover runtime class contracts', () => {
  afterEach(() => cleanup());

  test('exports the full Popover API surface', async () => {
    const mod = await import('./popover');
    for (const name of ['Popover', 'PopoverAnchor', 'PopoverContent', 'PopoverTrigger']) {
      expect(typeof (mod as Record<string, unknown>)[name]).toBe('function');
    }
  });

  test('content carries upstream keyframe motion and reduced-motion opt-in at runtime', async () => {
    await renderPopoverContent();

    const content = document.querySelector('[data-slot="popover-content"]');
    expect(content).toBeTruthy();
    const className = content?.getAttribute('class') ?? '';

    expectVisualClassTokens(className, [
      'duration-100',
      'data-open:animate-in',
      'data-open:fade-in-0',
      'data-open:zoom-in-95',
      'data-closed:animate-out',
      'data-closed:fade-out-0',
      'data-closed:zoom-out-95',
      'data-[side=bottom]:slide-in-from-top-2',
      'data-[side=left]:slide-in-from-right-2',
      'data-[side=right]:slide-in-from-left-2',
      'data-[side=top]:slide-in-from-bottom-2',
      'origin-(--radix-popover-content-transform-origin)',
      ...A11Y_OPT_IN,
    ]);
  });

  test('snappy transition tier and long-form state animation drift do not return', async () => {
    await renderPopoverContent();

    const className =
      document.querySelector('[data-slot="popover-content"]')?.getAttribute('class') ?? '';

    expectVisualClassTokensAbsent(className, SNAPPY_TOKENS);
    expect(className).not.toMatch(/data-\[state=(?:open|closed)\]:(?:animate|fade|zoom|slide)/);
  });
});

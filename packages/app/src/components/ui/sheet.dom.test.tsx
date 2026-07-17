import { afterEach, describe, expect, mock, test } from 'bun:test';
import * as actualLinguiMacro from '@lingui/react/macro';
import { cleanup, render } from '@testing-library/react';
import type { ReactNode } from 'react';
import {
  expectVisualClassTokens,
  expectVisualClassTokensAbsent,
} from '@/test-utils/visual-contract';

mock.module('@lingui/react/macro', () => ({
  ...actualLinguiMacro,
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

const OVERLAY_A11Y_OPT_IN = [
  'motion-reduce:data-open:animate-none',
  'motion-reduce:data-closed:animate-none',
  'motion-reduce:duration-0',
] as const;

const CONTENT_A11Y_OPT_IN = [
  'motion-reduce:transition-none',
  'motion-reduce:duration-0',
  'motion-reduce:data-open:animate-none',
  'motion-reduce:data-closed:animate-none',
] as const;

const CONTENT_SIDES = ['bottom', 'left', 'right', 'top'] as const;

async function renderSheetContent(side: (typeof CONTENT_SIDES)[number] = 'right') {
  const { Sheet, SheetContent, SheetDescription, SheetTitle } = await import('./sheet');

  render(
    <Sheet open={true}>
      <SheetContent forceMount={true} side={side} showCloseButton={false}>
        <SheetTitle>Sheet title</SheetTitle>
        <SheetDescription>Sheet description</SheetDescription>
        Body
      </SheetContent>
    </Sheet>,
  );
}

describe('Sheet runtime class contracts', () => {
  afterEach(() => cleanup());

  test('exports the full Sheet API surface', async () => {
    const mod = await import('./sheet');
    for (const name of [
      'Sheet',
      'SheetClose',
      'SheetContent',
      'SheetDescription',
      'SheetFooter',
      'SheetHeader',
      'SheetTitle',
      'SheetTrigger',
    ]) {
      expect(typeof (mod as Record<string, unknown>)[name]).toBe('function');
    }
  });

  test('overlay carries fade keyframes and reduced-motion opt-in at runtime', async () => {
    await renderSheetContent();

    const overlay = document.querySelector('[data-slot="sheet-overlay"]');
    expect(overlay).toBeTruthy();
    const className = overlay?.getAttribute('class') ?? '';

    expectVisualClassTokens(className, [
      'duration-100',
      'data-open:animate-in',
      'data-open:fade-in-0',
      'data-closed:animate-out',
      'data-closed:fade-out-0',
      ...OVERLAY_A11Y_OPT_IN,
    ]);
  });

  test.each(CONTENT_SIDES)('content side=%s carries hybrid motion contract', async (side) => {
    await renderSheetContent(side);

    const content = document.querySelector('[data-slot="sheet-content"]');
    expect(content).toBeTruthy();
    expect(content?.getAttribute('data-side')).toBe(side);
    const className = content?.getAttribute('class') ?? '';

    expectVisualClassTokens(className, [
      'transition duration-200 ease-in-out',
      'data-open:animate-in',
      'data-open:fade-in-0',
      `data-[side=${side}]:data-open:slide-in-from-${side}-10`,
      'data-closed:animate-out',
      'data-closed:fade-out-0',
      `data-[side=${side}]:data-closed:slide-out-to-${side}-10`,
      ...CONTENT_A11Y_OPT_IN,
    ]);
  });

  test('snappy transition tier does not return on runtime surfaces', async () => {
    await renderSheetContent();

    const surfaces = [
      ...document.querySelectorAll('[data-slot="sheet-overlay"], [data-slot="sheet-content"]'),
    ]
      .map((el) => el.getAttribute('class') ?? '')
      .join(' ');

    expectVisualClassTokensAbsent(surfaces, [
      'transition-[opacity,scale]',
      'ease-(--ease-out-strong)',
      'starting:opacity-0',
      'starting:scale-95',
      'data-closed:duration-0',
      'FORKED FROM radix-nova',
    ]);
  });
});

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

const A11Y_OPT_IN = [
  'motion-reduce:data-open:animate-none',
  'motion-reduce:data-closed:animate-none',
  'motion-reduce:duration-0',
] as const;

const SNAPPY_TOKENS = [
  'transition-[opacity,scale]',
  'transition-opacity',
  'ease-(--ease-out-strong)',
  'starting:opacity-0',
  'starting:scale-95',
  'data-closed:duration-0',
] as const;

async function renderDialogContent() {
  const { Dialog, DialogContent, DialogDescription, DialogTitle } = await import('./dialog');

  render(
    <Dialog open={true}>
      <DialogContent showCloseButton={false}>
        <DialogTitle>Dialog title</DialogTitle>
        <DialogDescription>Dialog description</DialogDescription>
        Body
      </DialogContent>
    </Dialog>,
  );
}

describe('Dialog runtime class contracts', () => {
  afterEach(() => cleanup());

  test('exports the full Dialog API surface', async () => {
    const mod = await import('./dialog');
    for (const name of [
      'Dialog',
      'DialogBody',
      'DialogClose',
      'DialogContent',
      'DialogDescription',
      'DialogFooter',
      'DialogHeader',
      'DialogOverlay',
      'DialogPortal',
      'DialogTitle',
      'DialogTrigger',
    ]) {
      expect(typeof (mod as Record<string, unknown>)[name]).toBe('function');
    }
  });

  test('overlay carries drag opt-out, fade motion, and reduced-motion opt-in', async () => {
    await renderDialogContent();

    const overlay = document.querySelector('[data-slot="dialog-overlay"]');
    expect(overlay).toBeTruthy();
    const className = overlay?.getAttribute('class') ?? '';
    expectVisualClassTokens(className, [
      'duration-100',
      'data-open:animate-in',
      'data-open:fade-in-0',
      'data-closed:animate-out',
      'data-closed:fade-out-0',
      '[-webkit-app-region:no-drag]',
      ...A11Y_OPT_IN,
    ]);
  });

  test('content is centered, drag-safe, and uses zoom/fade motion without slides', async () => {
    await renderDialogContent();

    const content = document.querySelector('[data-slot="dialog-content"]');
    expect(content).toBeTruthy();
    const className = content?.getAttribute('class') ?? '';
    expectVisualClassTokens(className, [
      'top-1/2',
      '-translate-y-1/2',
      'left-1/2',
      '-translate-x-1/2',
      'max-h-[calc(100dvh-2rem)]',
      'duration-100',
      'data-open:animate-in',
      'data-open:fade-in-0',
      'data-open:zoom-in-95',
      'data-closed:animate-out',
      'data-closed:fade-out-0',
      'data-closed:zoom-out-95',
      '[-webkit-app-region:no-drag]',
      ...A11Y_OPT_IN,
    ]);
    expectVisualClassTokensAbsent(className, ['slide-in-from']);
  });

  test('snappy transition tier does not return on runtime surfaces', async () => {
    await renderDialogContent();

    const surfaces = [
      ...document.querySelectorAll('[data-slot="dialog-overlay"], [data-slot="dialog-content"]'),
    ]
      .map((el) => el.getAttribute('class') ?? '')
      .join(' ');

    expectVisualClassTokensAbsent(surfaces, SNAPPY_TOKENS);
  });
});

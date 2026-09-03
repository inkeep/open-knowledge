import * as actualLinguiMacro from '@lingui/react/macro';
import { cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  expectVisualClassTokens,
  expectVisualClassTokensAbsent,
} from '@/test-utils/visual-contract';

vi.doMock('@lingui/react/macro', () => ({
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

describe('Dialog window-drag band', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  test('renders no drag strip and no extra clearance off the desktop host', async () => {
    await renderDialogContent();

    expect(screen.queryByTestId('dialog-drag-strip')).toBeNull();
    expectVisualClassTokens(
      document.querySelector('[data-slot="dialog-content"]')?.getAttribute('class'),
      ['max-h-[calc(100dvh-2rem)]'],
    );
  });

  test('restores the title-bar drag band, between the overlay and the dialog', async () => {
    vi.stubGlobal('okDesktop', {});
    await renderDialogContent();

    const strip = screen.getByTestId('dialog-drag-strip');
    const overlay = document.querySelector('[data-slot="dialog-overlay"]');
    const content = document.querySelector('[data-slot="dialog-content"]');

    expectVisualClassTokens(strip.getAttribute('class'), [
      '[-webkit-app-region:drag]',
      'pointer-events-none',
      'h-12',
      'z-50',
    ]);
    expect(overlay?.compareDocumentPosition(strip)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(content?.compareDocumentPosition(strip)).toBe(Node.DOCUMENT_POSITION_PRECEDING);
    expect(strip.hasAttribute('data-electron-drag')).toBe(true);
    expect(strip.getAttribute('aria-hidden')).toBe('true');
  });

  test('clamps the dialog clear of the band on the desktop host', async () => {
    vi.stubGlobal('okDesktop', {});
    await renderDialogContent();

    const className =
      document.querySelector('[data-slot="dialog-content"]')?.getAttribute('class') ?? '';
    expectVisualClassTokens(className, ['max-h-[calc(100dvh-6rem)]']);
    expectVisualClassTokensAbsent(className, ['max-h-[calc(100dvh-2rem)]']);
  });

  test('a Dialog hosting an AlertDialog yields two distinct strips', async () => {
    vi.stubGlobal('okDesktop', {});
    const { Dialog, DialogContent, DialogTitle } = await import('./dialog');
    const { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogTitle } = await import(
      './alert-dialog'
    );

    render(
      <Dialog open={true}>
        <DialogContent showCloseButton={false}>
          <DialogTitle>Outer</DialogTitle>
          <AlertDialog open={true}>
            <AlertDialogContent>
              <AlertDialogTitle>Inner</AlertDialogTitle>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
            </AlertDialogContent>
          </AlertDialog>
        </DialogContent>
      </Dialog>,
    );

    const outer = screen.getByTestId('dialog-drag-strip');
    const inner = screen.getByTestId('alert-dialog-drag-strip');
    expect(outer).not.toBe(inner);
  });

  test('a caller max-h still wins over the clearance clamp', async () => {
    vi.stubGlobal('okDesktop', {});
    const { Dialog, DialogContent, DialogTitle } = await import('./dialog');

    render(
      <Dialog open={true}>
        <DialogContent showCloseButton={false} className="max-h-[20rem]">
          <DialogTitle>Dialog title</DialogTitle>
        </DialogContent>
      </Dialog>,
    );

    const className =
      document.querySelector('[data-slot="dialog-content"]')?.getAttribute('class') ?? '';
    expectVisualClassTokens(className, ['max-h-[20rem]']);
    expectVisualClassTokensAbsent(className, ['max-h-[calc(100dvh-6rem)]']);
  });
});

describe('Dialog footer typography', () => {
  afterEach(() => cleanup());

  async function renderFooter(children: ReactNode) {
    const { Dialog, DialogContent, DialogFooter, DialogTitle } = await import('./dialog');

    render(
      <Dialog open={true}>
        <DialogContent showCloseButton={false}>
          <DialogTitle>Dialog title</DialogTitle>
          <DialogFooter>{children}</DialogFooter>
        </DialogContent>
      </Dialog>,
    );
  }

  test('the footer carries the treatment for every button it contains', async () => {
    const { Button } = await import('./button');
    await renderFooter(<Button variant="outline">Cancel</Button>);

    expectVisualClassTokens(
      document.querySelector('[data-slot="dialog-footer"]')?.getAttribute('class'),
      [
        '[&_button]:font-mono',
        '[&_button]:uppercase',
        '[&_[data-slot=button]]:font-mono',
        '[&_[data-slot=button]]:uppercase',
      ],
    );
  });

  test('footer choices do not re-declare the treatment the footer already supplies', async () => {
    const { Button } = await import('./button');
    await renderFooter(
      <>
        <Button variant="outline">Cancel</Button>
        <Button variant="ghost">Back</Button>
      </>,
    );

    for (const label of ['Cancel', 'Back']) {
      expectVisualClassTokensAbsent(screen.getByText(label).getAttribute('class'), [
        'font-mono',
        'uppercase',
      ]);
    }
  });

  test('a DialogClose wrapping a button leans on the footer rather than its own classes', async () => {
    const { DialogClose } = await import('./dialog');
    const { Button } = await import('./button');
    await renderFooter(
      <DialogClose asChild>
        <Button variant="outline">Dismiss</Button>
      </DialogClose>,
    );

    const button = screen.getByText('Dismiss');
    expect(button.tagName).toBe('BUTTON');
    expectVisualClassTokensAbsent(button.getAttribute('class'), ['font-mono', 'uppercase']);
  });

  test('the built-in close affordance leans on the footer rather than its own classes', async () => {
    const { Dialog, DialogContent, DialogFooter, DialogTitle } = await import('./dialog');

    render(
      <Dialog open={true}>
        <DialogContent showCloseButton={false}>
          <DialogTitle>Dialog title</DialogTitle>
          <DialogFooter showCloseButton />
        </DialogContent>
      </Dialog>,
    );

    expectVisualClassTokensAbsent(screen.getByText('Close').getAttribute('class'), [
      'font-mono',
      'uppercase',
    ]);
  });
});

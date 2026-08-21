/**
 * DOM-substrate tests for AlertDialog.
 *
 * This primitive exists for one reason: a destructive confirmation must not be
 * dismissible by an accidental pointer gesture. Every assertion below is either
 * that property, or one of the properties the confirmation dialogs built on top
 * of it depend on.
 *
 * Several tests render a plain `Dialog` alongside as a control. Without one, a
 * "did not dismiss" assertion passes just as happily when the synthetic gesture
 * never reached Radix at all, which is the failure mode that makes this whole
 * file worthless.
 */

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { expectVisualClassTokens } from '@/test-utils/visual-contract';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogBody,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from './alert-dialog';
import { Button } from './button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './dialog';

afterEach(cleanup);

const A11Y_OPT_IN = [
  'motion-reduce:data-open:animate-none',
  'motion-reduce:data-closed:animate-none',
  'motion-reduce:duration-0',
] as const;

function renderAlert({
  onOpenChange = () => {},
  footer,
}: {
  onOpenChange?: (open: boolean) => void;
  footer?: React.ReactNode;
} = {}) {
  render(
    <AlertDialog open onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete the thing</AlertDialogTitle>
          <AlertDialogDescription>This cannot be undone.</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogBody>
          <p>a body slot</p>
        </AlertDialogBody>
        <AlertDialogFooter>
          {footer ?? <AlertDialogCancel>Cancel</AlertDialogCancel>}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>,
  );
}

/**
 * Radix registers its outside-pointerdown listener inside a zero-delay timeout,
 * so the gesture that opened a layer cannot immediately close it again. A test
 * that dispatches an outside gesture before that tick elapses reaches no
 * listener at all, and every "did not dismiss" assertion downstream of it
 * passes for the wrong reason.
 */
async function armOutsideDismissal() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function renderPlainDialog(onOpenChange: (open: boolean) => void) {
  render(
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogTitle>Delete the thing</DialogTitle>
        <DialogDescription>This cannot be undone.</DialogDescription>
      </DialogContent>
    </Dialog>,
  );
}

describe('AlertDialog module surface', () => {
  test('exports the full API surface', async () => {
    const mod = await import('./alert-dialog');
    for (const name of [
      'AlertDialog',
      'AlertDialogAction',
      'AlertDialogBody',
      'AlertDialogCancel',
      'AlertDialogContent',
      'AlertDialogDescription',
      'AlertDialogFooter',
      'AlertDialogHeader',
      'AlertDialogOverlay',
      'AlertDialogPortal',
      'AlertDialogTitle',
      'AlertDialogTrigger',
    ]) {
      expect(typeof (mod as Record<string, unknown>)[name]).toBe('function');
    }
  });
});

describe('AlertDialog semantics', () => {
  test('announces as an alertdialog rather than a plain dialog', () => {
    renderAlert();

    expect(screen.getByRole('alertdialog')).toBeTruthy();
  });

  test('carries an accessible name and description from its title and description slots', () => {
    renderAlert();

    const content = screen.getByRole('alertdialog');
    const labelledBy = content.getAttribute('aria-labelledby');
    const describedBy = content.getAttribute('aria-describedby');

    expect(labelledBy && document.getElementById(labelledBy)?.textContent).toBe('Delete the thing');
    expect(describedBy && document.getElementById(describedBy)?.textContent).toBe(
      'This cannot be undone.',
    );
  });

  test('renders no corner close affordance, unlike the Dialog it replaces', () => {
    renderAlert();

    expect(screen.queryByRole('button', { name: 'Close' })).toBeNull();

    // Control: the same query finds Dialog's close-X, so the assertion above is
    // about AlertDialog and not about a query that never matches anything.
    cleanup();
    renderPlainDialog(() => {});

    expect(screen.getByRole('button', { name: 'Close' })).toBeTruthy();
  });

  test('renders body-slot children inside the scrollable region', () => {
    renderAlert();

    const body = document.querySelector('[data-slot="alert-dialog-body"]');

    expect(body?.textContent).toBe('a body slot');
  });
});

describe('AlertDialog dismissal', () => {
  test('an outside pointer gesture does not dismiss it', async () => {
    const onOpenChange = vi.fn();
    renderAlert({ onOpenChange });
    await armOutsideDismissal();

    fireEvent.pointerDown(document.body);
    fireEvent.click(document.body);

    expect(onOpenChange).not.toHaveBeenCalled();
  });

  test('the same outside gesture does dismiss a plain Dialog', async () => {
    // The control for the test above. If this ever stops dismissing, the
    // synthetic gesture has stopped reaching Radix and the "does not dismiss"
    // assertion has quietly become vacuous.
    const onOpenChange = vi.fn();
    renderPlainDialog(onOpenChange);
    await armOutsideDismissal();

    fireEvent.pointerDown(document.body);
    fireEvent.click(document.body);

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  test('Escape still dismisses, because it reads as Cancel', () => {
    const onOpenChange = vi.fn();
    renderAlert({ onOpenChange });

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

describe('AlertDialog focus', () => {
  test('opening moves focus to the cancel choice, not the confirming one', async () => {
    renderAlert({
      footer: (
        <>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction>Delete</AlertDialogAction>
        </>
      ),
    });

    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }));
    });
  });
});

describe('AlertDialog footer choices', () => {
  test('activating the cancel choice closes the dialog', () => {
    const onOpenChange = vi.fn();
    renderAlert({ onOpenChange });

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  test('activating the action choice closes the dialog immediately', () => {
    // The reason both confirmation dialogs keep a plain Button for their
    // destructive action: they await a request and report progress in the
    // button's own label, which an immediate close would tear down.
    const onOpenChange = vi.fn();
    renderAlert({
      onOpenChange,
      footer: (
        <>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction>Delete</AlertDialogAction>
        </>
      ),
    });

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  test('a plain Button in the footer leaves the dialog open', () => {
    const onOpenChange = vi.fn();
    const onDelete = vi.fn();
    renderAlert({
      onOpenChange,
      footer: (
        <>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <Button variant="destructive" onClick={onDelete}>
            Delete
          </Button>
        </>
      ),
    });

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByRole('alertdialog')).toBeTruthy();
  });

  test('a disabled cancel choice does not close the dialog', () => {
    // Both consumers disable Cancel while their action is in flight.
    const onOpenChange = vi.fn();
    renderAlert({
      onOpenChange,
      footer: <AlertDialogCancel disabled>Cancel</AlertDialogCancel>,
    });

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(onOpenChange).not.toHaveBeenCalled();
  });
});

describe('AlertDialog surface classes', () => {
  test('overlay opts out of the OS drag region and of animation under reduced motion', () => {
    renderAlert();

    const overlay = document.querySelector('[data-slot="alert-dialog-overlay"]');

    expectVisualClassTokens(overlay?.getAttribute('class'), [
      '[-webkit-app-region:no-drag]',
      ...A11Y_OPT_IN,
    ]);
  });

  test('content opts out of the OS drag region and of animation under reduced motion', () => {
    renderAlert();

    expectVisualClassTokens(screen.getByRole('alertdialog').getAttribute('class'), [
      '[-webkit-app-region:no-drag]',
      'max-h-[calc(100dvh-2rem)]',
      ...A11Y_OPT_IN,
    ]);
  });

  test('renders no drag strip off the desktop host', () => {
    renderAlert();

    expect(screen.queryByTestId('alert-dialog-drag-strip')).toBeNull();
  });

  test('restores the title-bar drag band, between the overlay and the dialog', () => {
    vi.stubGlobal('okDesktop', {});
    try {
      renderAlert();

      const strip = screen.getByTestId('alert-dialog-drag-strip');
      const overlay = document.querySelector('[data-slot="alert-dialog-overlay"]');
      const content = screen.getByRole('alertdialog');

      expectVisualClassTokens(strip.getAttribute('class'), [
        '[-webkit-app-region:drag]',
        'pointer-events-none',
        'z-50',
      ]);
      // The ordering IS the contract: after the overlay so it beats the no-drag
      // blanket, before the content so a viewport-tall dialog's own close X and
      // heading stay clickable rather than becoming drag region.
      expect(overlay?.compareDocumentPosition(strip)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
      expect(content.compareDocumentPosition(strip)).toBe(Node.DOCUMENT_POSITION_PRECEDING);
      // Opts into the globals.css rule that suspends drag under an open popper.
      expect(strip.hasAttribute('data-electron-drag')).toBe(true);
      expect(strip.getAttribute('aria-hidden')).toBe('true');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test('caller className composes with the base classes rather than replacing them', () => {
    render(
      <AlertDialog open>
        <AlertDialogContent className="sm:max-w-md">
          <AlertDialogTitle>Title</AlertDialogTitle>
          <AlertDialogDescription>Description</AlertDialogDescription>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
        </AlertDialogContent>
      </AlertDialog>,
    );

    expectVisualClassTokens(screen.getByRole('alertdialog').getAttribute('class'), [
      'sm:max-w-md',
      '[-webkit-app-region:no-drag]',
    ]);
  });
});

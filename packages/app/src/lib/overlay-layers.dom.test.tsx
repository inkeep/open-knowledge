/**
 * Pins `isOverlayLayerOpen` against the DOM the real Radix primitives emit.
 *
 * The predicate is a selector probe, so its correctness is entirely a claim
 * about what Radix renders. These tests render each primitive for real rather
 * than asserting against hand-built markup — a Radix upgrade that renames
 * `data-state` or drops the popper wrapper fails here instead of silently
 * disarming every app-global shortcut gate that depends on it.
 *
 * The negative cases matter as much as the positive ones: a tooltip and a
 * collapsible both carry an "open" notion, and suppressing shortcuts for
 * either would be an over-reach.
 */

import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { Collapsible, CollapsibleContent } from '@/components/ui/collapsible';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem } from '@/components/ui/dropdown-menu';
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { isOverlayLayerOpen } from './overlay-layers';

afterEach(cleanup);

describe('isOverlayLayerOpen', () => {
  test('false with nothing open', () => {
    render(<div>plain content</div>);

    expect(isOverlayLayerOpen()).toBe(false);
  });

  test('true while a modal dialog is open', async () => {
    render(
      <Dialog open>
        <DialogContent>
          <DialogTitle>Overlay</DialogTitle>
          <DialogDescription>Overlay body</DialogDescription>
        </DialogContent>
      </Dialog>,
    );
    await waitFor(() => expect(screen.getByRole('dialog')).not.toBeNull());

    expect(isOverlayLayerOpen()).toBe(true);
  });

  test('false once the dialog closes', async () => {
    const view = render(
      <Dialog open>
        <DialogContent>
          <DialogTitle>Overlay</DialogTitle>
          <DialogDescription>Overlay body</DialogDescription>
        </DialogContent>
      </Dialog>,
    );
    await waitFor(() => expect(screen.getByRole('dialog')).not.toBeNull());

    view.rerender(
      <Dialog open={false}>
        <DialogContent>
          <DialogTitle>Overlay</DialogTitle>
          <DialogDescription>Overlay body</DialogDescription>
        </DialogContent>
      </Dialog>,
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    expect(isOverlayLayerOpen()).toBe(false);
  });

  test('true while a dropdown menu is open', async () => {
    render(
      <DropdownMenu open>
        <DropdownMenuContent>
          <DropdownMenuItem>Item</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    );
    await waitFor(() => expect(screen.getByRole('menu')).not.toBeNull());

    expect(isOverlayLayerOpen()).toBe(true);
  });

  test('true while a popover is open', async () => {
    render(
      <Popover open>
        <PopoverTrigger>Open</PopoverTrigger>
        <PopoverContent>Popover body</PopoverContent>
      </Popover>,
    );
    await waitFor(() => expect(screen.getByText('Popover body')).not.toBeNull());

    expect(isOverlayLayerOpen()).toBe(true);
  });

  test('false while a tooltip is showing — a tooltip takes no focus', async () => {
    render(
      <TooltipProvider>
        <Tooltip open>
          <TooltipTrigger>Trigger</TooltipTrigger>
          <TooltipContent>Tooltip body</TooltipContent>
        </Tooltip>
      </TooltipProvider>,
    );
    await waitFor(() => expect(screen.getAllByText('Tooltip body').length).toBeGreaterThan(0));

    expect(isOverlayLayerOpen()).toBe(false);
  });

  test('false while a layer that leaves focus outside itself is open', async () => {
    // The shape the InteractionLayer's chip prop-panel uses: a Radix Popover
    // opened by pointerover that prevents `onOpenAutoFocus`, so the caret stays
    // in the document. Treating that as owning the keyboard would make every
    // global shortcut depend on where the mouse is resting.
    render(
      <Popover open>
        <PopoverAnchor>
          <span />
        </PopoverAnchor>
        <PopoverContent
          data-ok-declines-keyboard=""
          onOpenAutoFocus={(event) => event.preventDefault()}
        >
          Hover panel body
        </PopoverContent>
      </Popover>,
    );
    await waitFor(() => expect(screen.getByText('Hover panel body')).not.toBeNull());

    expect(isOverlayLayerOpen()).toBe(false);
  });

  test('true while a dialog is open even with focus fallen back to the body', async () => {
    // Focus can sit on `<body>` with a modal wide open — a programmatic blur, or
    // a focused node removed before the focus scope heals it. Ownership must not
    // depend on that, or the shortcut goes straight back to the app underneath.
    render(
      <Dialog open>
        <DialogContent>
          <DialogTitle>Overlay</DialogTitle>
          <DialogDescription>Overlay body</DialogDescription>
        </DialogContent>
      </Dialog>,
    );
    await waitFor(() => expect(screen.getByRole('dialog')).not.toBeNull());

    act(() => (document.activeElement as HTMLElement | null)?.blur());
    expect(document.activeElement).toBe(document.body);

    expect(isOverlayLayerOpen()).toBe(true);
  });

  test('an Escape handler can read the layer capture-phase, or bail on defaultPrevented', async () => {
    // The two arms the helper's contract offers Escape handlers, pinned against
    // a real dismissable layer. `GraphPanel` / `TimelineDiffPane` / the sidebar
    // take the capture arm; `AgentDiffPane` / `FindReplaceController` take the
    // defaultPrevented one. A Radix change that stopped cancelling Escape, or
    // that moved its dismissal ahead of window capture, breaks this.
    render(
      <Dialog open>
        <DialogContent>
          <DialogTitle>Overlay</DialogTitle>
          <DialogDescription>Overlay body</DialogDescription>
        </DialogContent>
      </Dialog>,
    );
    await waitFor(() => expect(screen.getByRole('dialog')).not.toBeNull());

    let sawLayerInCapture: boolean | null = null;
    let cancelledByBubble: boolean | null = null;
    const onCapture = () => {
      sawLayerInCapture = isOverlayLayerOpen();
    };
    const onBubble = (event: Event) => {
      cancelledByBubble = event.defaultPrevented;
    };
    window.addEventListener('keydown', onCapture, { capture: true });
    window.addEventListener('keydown', onBubble);

    try {
      act(() => {
        document.body.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
        );
      });
    } finally {
      window.removeEventListener('keydown', onCapture, { capture: true });
      window.removeEventListener('keydown', onBubble);
    }

    expect(sawLayerInCapture).toBe(true);
    expect(cancelledByBubble).toBe(true);
  });

  test('false while a collapsible is expanded — inline disclosure, not a layer', async () => {
    render(
      <Collapsible open>
        <CollapsibleContent>Collapsible body</CollapsibleContent>
      </Collapsible>,
    );
    await waitFor(() => expect(screen.getByText('Collapsible body')).not.toBeNull());

    expect(isOverlayLayerOpen()).toBe(false);
  });
});

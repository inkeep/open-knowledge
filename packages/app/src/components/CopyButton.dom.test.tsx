/**
 * RTL behavioral tests for the shared `CopyButton`.
 *
 * Covers the copy→check affordance the link PropPanels and the ShareButton
 * popover rely on:
 *   - default mount shows "Copy"; a successful clipboard write flips it to
 *     "Copied!" (and the injected writer receives `copyContent`)
 *   - `initialCopied` mounts already in the "Copied!" state (the ShareButton
 *     success path opens the popover right after the click-time copy)
 *   - a refused clipboard write leaves the icon as "Copy" (the catch path is
 *     exercised through a real rejecting writer, not a mocked throw)
 *
 * The clipboard boundary is injected via the `clipboardWrite` prop so these
 * assertions never depend on `navigator.clipboard` being present in jsdom.
 *
 * Substrate: jsdom via `bun run test:dom`.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

// CopyButton mounts a Radix Tooltip (focus-scope) which reaches for DOM globals
// the shared jsdom-preload does not expose. Hoist the needed shims — same
// pattern as `ShareButton.dom.test.tsx`.
type WindowGlobals = { NodeFilter?: typeof NodeFilter };
type GlobalWithDomShims = typeof globalThis &
  WindowGlobals & { window?: WindowGlobals; ResizeObserver?: unknown };
const globalWithDomShims = globalThis as GlobalWithDomShims;
if (
  globalWithDomShims.NodeFilter === undefined &&
  globalWithDomShims.window?.NodeFilter !== undefined
) {
  globalWithDomShims.NodeFilter = globalWithDomShims.window.NodeFilter;
}
if (globalWithDomShims.ResizeObserver === undefined) {
  class NoopResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  globalWithDomShims.ResizeObserver = NoopResizeObserver;
}

const { CopyButton } = await import('./CopyButton');
const { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } = await import(
  '@/components/ui/tooltip'
);
const { Button } = await import('@/components/ui/button');

function renderCopyButton(props: Parameters<typeof CopyButton>[0]) {
  return render(
    <TooltipProvider>
      <CopyButton {...props} />
    </TooltipProvider>,
  );
}

describe('CopyButton', () => {
  beforeEach(() => {
    // Default the clipboard to absent so a test that forgets to inject a writer
    // exercises the real default-path guard rather than a leaked global.
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      configurable: true,
      value: undefined,
    });
  });
  afterEach(() => {
    cleanup();
  });

  test('leaving Copy for a flush neighbor hands the tooltip off', async () => {
    // Pins `disableHoverableContent`: without it, leaving the trigger arms the
    // grace polygon and sets the provider's in-transit flag before the
    // neighbor's trigger sees its first pointermove, so the neighbor's tooltip
    // never opens on that move. The prop produces no DOM difference at rest,
    // so this hand-off is the only honest place to catch its deletion.
    const user = userEvent.setup();
    render(
      <TooltipProvider>
        <CopyButton copyContent="x" ariaLabel="Copy message" />
        <Tooltip>
          <TooltipTrigger asChild>
            <Button type="button" size="icon-xs" variant="ghost" aria-label="Edit" />
          </TooltipTrigger>
          <TooltipContent>Edit</TooltipContent>
        </Tooltip>
      </TooltipProvider>,
    );

    await user.hover(screen.getByRole('button', { name: 'Copy message' }));
    await user.hover(screen.getByRole('button', { name: 'Edit' }));

    expect(screen.getByRole('tooltip').textContent).toBe('Edit');
  });

  test('mounts in the Copy state by default', () => {
    renderCopyButton({ copyContent: 'https://openknowledge.ai/d/Share123' });

    expect(screen.getByRole('button', { name: 'Copy' })).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'Copied!' })).toBeNull();
  });

  test('a successful copy flips the icon to Copied! and writes the content', async () => {
    const writes: string[] = [];
    renderCopyButton({
      copyContent: 'https://openknowledge.ai/d/Share123',
      clipboardWrite: (text) => {
        writes.push(text);
        return Promise.resolve();
      },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Copied!' })).not.toBeNull();
    });
    expect(writes).toEqual(['https://openknowledge.ai/d/Share123']);
  });

  test('initialCopied mounts already in the Copied! state', () => {
    renderCopyButton({
      copyContent: 'https://openknowledge.ai/d/Share123',
      initialCopied: true,
      clipboardWrite: () => Promise.resolve(),
    });

    expect(screen.getByRole('button', { name: 'Copied!' })).not.toBeNull();
  });

  test('a refused clipboard write leaves the icon as Copy', async () => {
    renderCopyButton({
      copyContent: 'https://openknowledge.ai/d/Share123',
      clipboardWrite: () => Promise.reject(new Error('permission denied')),
    });

    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));

    // Drain the writer's promise chain (resolve → rejected → reject handler).
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(screen.getByRole('button', { name: 'Copy' })).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'Copied!' })).toBeNull();
  });
});

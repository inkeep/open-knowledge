import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import * as sonner from 'sonner';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { formatShortcutBinding, formatShortcutBindingLabel } from '@/lib/keyboard-shortcuts';
import type { ShareTargetInput } from '@/lib/share/run-share-action';

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

vi.doMock('@/hooks/use-git-sync-status', () => ({
  useGitSyncStatusDetailed: () => ({
    status: { hasRemote: true },
    fetchError: null,
  }),
}));

vi.doMock('@/lib/config-provider', () => ({
  useConfigContext: () => ({ projectLocalBinding: { patch: () => ({ ok: true }) } }),
}));

const { ShareButton } = await import('./ShareButton');
const { TooltipProvider } = await import('@/components/ui/tooltip');

function renderShareButton(input: ShareTargetInput | null) {
  return render(
    <TooltipProvider>
      <ShareButton input={input} onClickWhenNoRemote={() => {}} />
    </TooltipProvider>,
  );
}

describe('ShareButton', () => {
  beforeEach(() => {
    if (typeof window !== 'undefined') window.location.hash = '';
    Reflect.deleteProperty(globalThis, 'okDesktop');
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      configurable: true,
      value: undefined,
    });
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            ok: true,
            shareUrl: 'https://openknowledge.ai/d/Share123',
            sharedUrl: 'https://github.com/inkeep/open-knowledge/blob/main/docs/readme.md',
            branch: 'main',
          }),
          { status: 200 },
        ),
      ),
    ) as never;
  });
  afterEach(() => {
    cleanup();
  });

  test('renders an enabled button for a folder target', () => {
    renderShareButton({ kind: 'folder', folderRelativePath: 'guides' });

    const button = screen.getByRole('button', { name: 'Share folder' });
    expect(button).not.toBeNull();
    expect((button as HTMLButtonElement).disabled).toBe(false);
  });

  test('renders an enabled button for a doc target', () => {
    renderShareButton({ kind: 'doc', docName: 'notes' });

    const button = screen.getByRole('button', { name: 'Share doc' });
    expect(button).not.toBeNull();
    expect((button as HTMLButtonElement).disabled).toBe(false);
  });

  test('renders a DISABLED button (not absent) when input is null', () => {
    renderShareButton(null);

    const button = screen.queryByTestId('share-button');
    expect(button).not.toBeNull();
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  test('opens the share popover with the link + copied state on a successful auto-copy', async () => {
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn(() => Promise.resolve()) },
    });
    renderShareButton({ kind: 'doc', docName: 'docs/readme' });

    fireEvent.click(screen.getByRole('button', { name: 'Share doc' }));

    await waitFor(() => {
      expect(screen.getByTestId('share-button-popover')).not.toBeNull();
    });
    const input = screen.getByLabelText('Share URL') as HTMLInputElement;
    expect(input.value).toBe('https://openknowledge.ai/d/Share123');
    expect(screen.getByRole('button', { name: 'Copied!' })).not.toBeNull();
  });

  test('swallows only the clipboard toast when the popover already carries the link', async () => {
    const errorToast = vi.spyOn(sonner.toast, 'error');
    renderShareButton({ kind: 'doc', docName: 'docs/readme' });

    fireEvent.click(screen.getByRole('button', { name: 'Share doc' }));
    await waitFor(() => {
      expect(screen.getByTestId('share-button-popover')).not.toBeNull();
    });

    expect(errorToast).not.toHaveBeenCalled();
    errorToast.mockRestore();
  });

  test('still raises a toast for a failure the popover does not explain', async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({ ok: false, error: 'detached-head' }))),
    ) as never;
    const errorToast = vi.spyOn(sonner.toast, 'error');
    renderShareButton({ kind: 'doc', docName: 'docs/readme' });

    fireEvent.click(screen.getByRole('button', { name: 'Share doc' }));

    await waitFor(() => {
      expect(errorToast).toHaveBeenCalledTimes(1);
    });
    errorToast.mockRestore();
  });

  test('surfaces a manual-copy URL when clipboard write fails after constructing a share link', async () => {
    renderShareButton({ kind: 'doc', docName: 'docs/readme' });

    fireEvent.click(screen.getByRole('button', { name: 'Share doc' }));

    await waitFor(() => {
      expect(screen.getByTestId('share-button-popover')).not.toBeNull();
    });
    const input = screen.getByLabelText('Share URL') as HTMLInputElement;
    expect(input.value).toBe('https://openknowledge.ai/d/Share123');
    expect(screen.getByRole('button', { name: 'Copy' })).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'Copied!' })).toBeNull();
    const copyBinding = { mac: '⌘ C', windowsLinux: 'Ctrl C' };
    const copyKeycap = screen
      .getByTestId('share-button-popover')
      .querySelector('[data-slot="kbd"]');
    expect(copyKeycap?.textContent).toBe(formatShortcutBinding(copyBinding));
    expect(copyKeycap?.getAttribute('aria-label')).toBe(formatShortcutBindingLabel(copyBinding));
    expect(globalThis.fetch).toHaveBeenCalledWith('/api/share/construct-url', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'doc', docPath: 'docs/readme.md' }),
    });
  });

  test('threads an absent freshness from the response into a warning row', async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            ok: true,
            shareUrl: 'https://openknowledge.ai/d/Share123',
            sharedUrl: 'https://github.com/inkeep/open-knowledge/blob/main/docs/readme.md',
            branch: 'main',
            freshness: 'absent',
          }),
          { status: 200 },
        ),
      ),
    ) as never;
    renderShareButton({ kind: 'doc', docName: 'docs/readme' });

    fireEvent.click(screen.getByRole('button', { name: 'Share doc' }));

    await waitFor(() => {
      expect(screen.getByTestId('share-button-popover')).not.toBeNull();
    });
    expect(screen.getByTestId('share-freshness-row').textContent).toContain(
      "This doc isn't on GitHub yet",
    );
  });

  test('renders no warning row when the response reports current freshness', async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            ok: true,
            shareUrl: 'https://openknowledge.ai/d/Share123',
            sharedUrl: 'https://github.com/inkeep/open-knowledge/blob/main/docs/readme.md',
            branch: 'main',
            freshness: 'current',
          }),
          { status: 200 },
        ),
      ),
    ) as never;
    renderShareButton({ kind: 'doc', docName: 'docs/readme' });

    fireEvent.click(screen.getByRole('button', { name: 'Share doc' }));

    await waitFor(() => {
      expect(screen.getByTestId('share-button-popover')).not.toBeNull();
    });
    expect(screen.queryByTestId('share-freshness-row')).toBeNull();
  });
});

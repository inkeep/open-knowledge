/**
 * RTL behavioral tests for `ShareButton`.
 *
 * The load-bearing regression: ShareButton used to `return null` on a
 * folder/empty/asset view (the old `if (!activeDocName) return null` self-gate),
 * which made the affordance vanish. It now ALWAYS renders a shadcn Button and
 * only DISABLES the trigger when `input === null` — mirroring the
 * OpenInAgentMenu always-render-but-disable contract. These tests pin the
 * rendered + enabled/disabled state across the three input shapes:
 *
 *   - folder target  → button present + ENABLED
 *   - doc target     → button present + ENABLED
 *   - null input     → button present + DISABLED (NOT absent)
 *
 * Click-dispatch coverage lives in `run-share-action.test.ts` (every side
 * effect is injectable there); this file stays focused on render + enabled
 * state so it doesn't re-test the orchestration helper through the UI.
 *
 * `useGitSyncStatusDetailed` is mocked to report a remote so the click path
 * (when exercised) routes through the construct-url branch rather than the
 * no-remote wizard — but the render assertions don't depend on it.
 *
 * Substrate: jsdom via `bun run test:dom`.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ShareTargetInput } from '@/lib/share/run-share-action';

// ShareButton mounts a Radix Tooltip + Popover (focus-scope) which reach for
// DOM globals the shared jsdom-preload does not expose. Hoist the needed shims
// — same pattern as `CloneDialog.dom.test.tsx`.
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

// Stub the sync-status hook so the button reads a remote without mounting the
// CC1 subscription / fetch path. `hasRemote: true` routes a click through the
// construct-url branch instead of `onClickWhenNoRemote`.
mock.module('@/hooks/use-git-sync-status', () => ({
  useGitSyncStatusDetailed: () => ({
    status: { hasRemote: true },
    fetchError: null,
  }),
}));

// The freshness warning row inside the popover reads the project-local config
// binding (for its "Enable auto-sync" gate). Stub the context so mounting the
// popover doesn't require a full <ConfigProvider>.
mock.module('@/lib/config-provider', () => ({
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
    globalThis.fetch = mock(() =>
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
    // The key regression guard: the button must stay in the DOM and merely
    // disable on a folder/empty/asset view — never return null.
    renderShareButton(null);

    const button = screen.queryByTestId('share-button');
    expect(button).not.toBeNull();
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  test('opens the share popover with the link + copied state on a successful auto-copy', async () => {
    // A resolving navigator.clipboard makes the auto-copy succeed, so the
    // popover opens in success mode rather than the manual-copy fallback.
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      configurable: true,
      value: { writeText: mock(() => Promise.resolve()) },
    });
    renderShareButton({ kind: 'doc', docName: 'docs/readme' });

    fireEvent.click(screen.getByRole('button', { name: 'Share doc' }));

    await waitFor(() => {
      expect(screen.getByTestId('share-button-popover')).not.toBeNull();
    });
    const input = screen.getByLabelText('Share URL') as HTMLInputElement;
    expect(input.value).toBe('https://openknowledge.ai/d/Share123');
    // The copy button opens in the just-copied (check) state, reflecting the
    // auto-copy that already happened at click time.
    expect(screen.getByRole('button', { name: 'Copied!' })).not.toBeNull();
  });

  test('surfaces a manual-copy URL when clipboard write fails after constructing a share link', async () => {
    renderShareButton({ kind: 'doc', docName: 'docs/readme' });

    fireEvent.click(screen.getByRole('button', { name: 'Share doc' }));

    await waitFor(() => {
      expect(screen.getByTestId('share-button-popover')).not.toBeNull();
    });
    const input = screen.getByLabelText('Share URL') as HTMLInputElement;
    expect(input.value).toBe('https://openknowledge.ai/d/Share123');
    // The auto-copy was refused, so nothing was copied — the copy button must
    // open in the "Copy" state, not "Copied!". Guards against an inverted
    // `initialCopied` (which keys off `autoCopyFailed`).
    expect(screen.getByRole('button', { name: 'Copy' })).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'Copied!' })).toBeNull();
    expect(globalThis.fetch).toHaveBeenCalledWith('/api/share/construct-url', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'doc', docPath: 'docs/readme.md' }),
    });
  });

  test('threads an absent freshness from the response into a warning row', async () => {
    globalThis.fetch = mock(() =>
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
    // The mocked status reports a remote with sync off, so an absent target is
    // the strong dead-link cell.
    expect(screen.getByTestId('share-freshness-row').textContent).toContain(
      "This doc isn't on GitHub yet",
    );
  });

  test('renders no warning row when the response reports current freshness', async () => {
    globalThis.fetch = mock(() =>
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

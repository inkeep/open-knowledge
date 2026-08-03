/**
 * Pin the read-only viewers' "Open file" handoff.
 *
 * The failure this guards: the affordance used to be a bare `<a href>` pointing
 * at the very `/api/asset-text` URL whose failure produced the pane. Clicking it
 * was a top-level navigation, so the browser (and, in the desktop shell, the
 * whole BrowserWindow) left the single-page app and rendered the raw API
 * response — for a 404 or 413 that is an empty body, i.e. a window with nothing
 * in it and no in-app way back.
 *
 * Two properties are asserted here, both behavioral:
 *   1. The control is not a same-origin `<a>` into `/api/*`, and activating it
 *      reaches the desktop asset bridge with the project-relative FILE path.
 *   2. A 404 renders no affordance at all — there is no file to hand over.
 *
 * Runs under the jsdom DOM tier.
 */

import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const { TextViewer } = await import('./TextViewer.tsx');
const { MermaidFileViewer } = await import('./MermaidFileViewer.tsx');

/** Non-OK response of the given status; the viewer throws before reading a body. */
function mockFetchStatus(status: number): typeof globalThis.fetch {
  return (() =>
    Promise.resolve({
      ok: false,
      status,
      text: async () => '',
    } as Response)) as typeof globalThis.fetch;
}

type OpenAssetSpy = ReturnType<typeof vi.fn>;

/**
 * Install a minimal desktop bridge so the real `dispatchAssetClick` takes its
 * Electron branch. Exercising the shipped dispatcher (rather than stubbing it)
 * is what makes this a proof that the click reaches `shell.openAsset`.
 */
function installDesktopBridge(): OpenAssetSpy {
  const openAsset = vi.fn(async (_: string) => ({ ok: true }) as const);
  (window as unknown as { okDesktop: unknown }).okDesktop = {
    shell: { openAsset, revealAsset: vi.fn(async (_: string) => ({ ok: true }) as const) },
  };
  return openAsset;
}

async function findErrorPane(container: HTMLElement, attr: string): Promise<void> {
  await waitFor(() => {
    expect(container.querySelector(`[${attr}-state="error"]`)).not.toBeNull();
  });
}

function openFileControl(container: HTMLElement): HTMLElement | null {
  return container.querySelector('[data-testid="viewer-open-file"]');
}

describe('viewer error pane — "Open file" handoff', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = mockFetchStatus(413);
  });

  afterEach(() => {
    cleanup();
    globalThis.fetch = originalFetch;
    delete (window as unknown as { okDesktop?: unknown }).okDesktop;
  });

  test('413 offers the handoff, and it is not an anchor into /api/*', async () => {
    installDesktopBridge();
    const { container } = render(
      <TextViewer
        src="/api/asset-text?path=logs/huge.csv"
        assetPath="logs/huge.csv"
        fileName="huge.csv"
        extension="csv"
      />,
    );
    await findErrorPane(container, 'data-text-viewer');

    const control = openFileControl(container);
    expect(control).not.toBeNull();
    // The defect shape: a same-frame navigation to the API surface.
    expect(container.querySelector('a[href*="/api/"]')).toBeNull();
    expect(control?.closest('a')).toBeNull();
  });

  test('activating the handoff opens the FILE through the desktop bridge', async () => {
    const openAsset = installDesktopBridge();
    const { container } = render(
      <TextViewer
        src="/api/asset-text?path=logs/huge.csv"
        assetPath="logs/huge.csv"
        fileName="huge.csv"
        extension="csv"
      />,
    );
    await findErrorPane(container, 'data-text-viewer');

    fireEvent.click(openFileControl(container) as HTMLElement);

    await waitFor(() => {
      expect(openAsset).toHaveBeenCalledTimes(1);
    });
    // The project-relative path, NOT the /api/asset-text URL that just failed.
    expect(openAsset).toHaveBeenCalledWith('logs/huge.csv');
  });

  test('web host (no desktop bridge) opens a new tab instead of navigating', async () => {
    const openSpy = vi.fn(() => null);
    const originalOpen = window.open;
    window.open = openSpy as unknown as typeof window.open;
    try {
      const { container } = render(
        <TextViewer
          src="/api/asset-text?path=logs/huge.csv"
          assetPath="logs/huge.csv"
          fileName="huge.csv"
          extension="csv"
        />,
      );
      await findErrorPane(container, 'data-text-viewer');
      fireEvent.click(openFileControl(container) as HTMLElement);
      await waitFor(() => {
        expect(openSpy).toHaveBeenCalledTimes(1);
      });
      expect(openSpy.mock.calls[0]?.[1]).toBe('_blank');
      // The regression was the URL, not the mechanism: the old anchor pointed at
      // the `/api/asset-text` request that had just failed. Pin the byte-serving
      // endpoint and the file it addresses, so re-wiring the target back to the
      // failed URL cannot pass on `_blank` alone.
      const openedUrl = String(openSpy.mock.calls[0]?.[0] ?? '');
      expect(openedUrl).toContain('/api/asset?');
      expect(openedUrl).not.toContain('/api/asset-text');
      expect(openedUrl).toContain(encodeURIComponent('logs/huge.csv'));
    } finally {
      window.open = originalOpen;
    }
  });

  test('404 renders no handoff — the file does not exist', async () => {
    installDesktopBridge();
    globalThis.fetch = mockFetchStatus(404);
    const { container } = render(
      <TextViewer
        src="/api/asset-text?path=logs/gone.csv"
        assetPath="logs/gone.csv"
        fileName="gone.csv"
        extension="csv"
      />,
    );
    await findErrorPane(container, 'data-text-viewer');

    expect(openFileControl(container)).toBeNull();
    expect(container.textContent ?? '').toContain('could not be found');
  });

  test('415 (binary) keeps the handoff — a real file is on disk', async () => {
    installDesktopBridge();
    globalThis.fetch = mockFetchStatus(415);
    const { container } = render(
      <TextViewer
        src="/api/asset-text?path=logs/blob.bin"
        assetPath="logs/blob.bin"
        fileName="blob.bin"
        extension="bin"
      />,
    );
    await findErrorPane(container, 'data-text-viewer');

    expect(openFileControl(container)).not.toBeNull();
  });

  test('a transport failure keeps the handoff - nothing refuted the file', async () => {
    installDesktopBridge();
    globalThis.fetch = (() =>
      Promise.reject(new Error('Network error'))) as typeof globalThis.fetch;
    const { container } = render(
      <TextViewer
        src="/api/asset-text?path=logs/huge.csv"
        assetPath="logs/huge.csv"
        fileName="huge.csv"
        extension="csv"
      />,
    );
    await findErrorPane(container, 'data-text-viewer');

    // The request never completed, so no status reached the hook and nothing
    // proved the file absent. Only a confirmed 404 suppresses the affordance.
    expect(openFileControl(container)).not.toBeNull();
  });

  test('loader-backed sources (skill bundles) never offer the handoff', async () => {
    installDesktopBridge();
    const { container } = render(
      <TextViewer
        loadText={async () => ({ ok: false, status: 413 })}
        fileName="script.py"
        extension="py"
      />,
    );
    await findErrorPane(container, 'data-text-viewer');

    // No content-dir path exists for a skill bundle file, so there is nothing
    // the OS handoff could address.
    expect(openFileControl(container)).toBeNull();
  });

  test('web fallback for a .mmd targets the endpoint that actually serves it', async () => {
    // `.mmd` is deliberately absent from ASSET_EXTENSIONS: the serve allowlist
    // does not admit it, so `/api/asset` answers 404 and only the ungated
    // byte path returns the file. Pointing the web handoff at an endpoint that
    // provably cannot serve the file makes it a guaranteed dead end.
    const openSpy = vi.fn(() => null);
    const originalOpen = window.open;
    window.open = openSpy as unknown as typeof window.open;
    try {
      const { container } = render(
        <MermaidFileViewer
          src="/api/asset-text?path=diagrams/huge.mmd"
          assetPath="diagrams/huge.mmd"
          fileName="huge.mmd"
          extension="mmd"
        />,
      );
      await findErrorPane(container, 'data-mermaid-file-viewer');
      fireEvent.click(openFileControl(container) as HTMLElement);
      await waitFor(() => {
        expect(openSpy).toHaveBeenCalledTimes(1);
      });
      const openedUrl = String(openSpy.mock.calls[0]?.[0] ?? '');
      expect(openedUrl).toContain('/api/asset-text?');
      expect(openedUrl).toContain(encodeURIComponent('diagrams/huge.mmd'));
    } finally {
      window.open = originalOpen;
    }
  });

  test('the mermaid file viewer shares the same handoff behavior', async () => {
    const openAsset = installDesktopBridge();
    const { container } = render(
      <MermaidFileViewer
        src="/api/asset-text?path=diagrams/flow.mmd"
        assetPath="diagrams/flow.mmd"
        fileName="flow.mmd"
        extension="mmd"
      />,
    );
    await findErrorPane(container, 'data-mermaid-file-viewer');

    expect(container.querySelector('a[href*="/api/"]')).toBeNull();
    fireEvent.click(openFileControl(container) as HTMLElement);
    await waitFor(() => {
      expect(openAsset).toHaveBeenCalledWith('diagrams/flow.mmd');
    });
  });
});

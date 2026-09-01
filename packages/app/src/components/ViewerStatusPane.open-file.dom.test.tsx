import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const { TextViewer } = await import('./TextViewer.tsx');
const { MermaidFileViewer } = await import('./MermaidFileViewer.tsx');

function mockFetchStatus(status: number): typeof globalThis.fetch {
  return (() =>
    Promise.resolve({
      ok: false,
      status,
      text: async () => '',
    } as Response)) as typeof globalThis.fetch;
}

type OpenAssetSpy = ReturnType<typeof vi.fn>;

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

    expect(openFileControl(container)).toBeNull();
  });

  test('web fallback for a .mmd targets the endpoint that actually serves it', async () => {
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

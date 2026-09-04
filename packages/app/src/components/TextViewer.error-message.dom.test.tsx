import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';

const { TextViewer } = await import('./TextViewer.tsx');

function mockFetchStatus(status: number): typeof globalThis.fetch {
  return (() =>
    Promise.resolve({
      ok: false,
      status,
      text: async () => '',
    } as Response)) as typeof globalThis.fetch;
}

describe('TextViewer — human-readable load errors', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    cleanup();
    globalThis.fetch = originalFetch;
  });

  test('413 renders a size-limit explanation, not a bare status code', async () => {
    globalThis.fetch = mockFetchStatus(413);
    const { container } = render(
      <TextViewer
        src="/api/asset-text?path=fishing-log/Morning_Activity.gpx"
        assetPath="fishing-log/Morning_Activity.gpx"
        fileName="Morning_Activity.gpx"
        extension="gpx"
      />,
    );
    await waitFor(() => {
      expect(container.querySelector('[data-text-viewer-state="error"]')).not.toBeNull();
    });
    const text = container.textContent ?? '';
    expect(text).toContain('too large to open in the built-in text editor');
    expect(text).toContain('1 MB limit');
    expect(text).not.toContain('HTTP 413');
  });

  test('404 renders a not-found explanation', async () => {
    globalThis.fetch = mockFetchStatus(404);
    const { container } = render(
      <TextViewer
        src="/api/asset-text?path=gone.csv"
        assetPath="gone.csv"
        fileName="gone.csv"
        extension="csv"
      />,
    );
    await waitFor(() => {
      expect(container.querySelector('[data-text-viewer-state="error"]')).not.toBeNull();
    });
    expect(container.textContent ?? '').toContain('could not be found');
  });

  test('an unmapped status keeps the diagnostic code for debuggability', async () => {
    globalThis.fetch = mockFetchStatus(503);
    const { container } = render(
      <TextViewer
        src="/api/asset-text?path=weird.bin"
        assetPath="weird.bin"
        fileName="weird.bin"
        extension="bin"
      />,
    );
    await waitFor(() => {
      expect(container.querySelector('[data-text-viewer-state="error"]')).not.toBeNull();
    });
    const text = container.textContent ?? '';
    expect(text).toContain('Something went wrong opening this file');
    expect(text).toContain('HTTP 503');
  });
});

/**
 * Pin the human-readable error mapping in `TextViewer`. When
 * `/api/asset-text` answers with a non-OK status, the viewer must render a
 * plain-language explanation — not a bare "HTTP 413" status code.
 *
 * The 413 case is load-bearing: it's exactly what a user hits when opening
 * a large GPX / CSV / log file through "View as text"
 * (the server caps the text-viewer response at 1 MiB). Before this mapping
 * the pane showed only "Failed to load file (HTTP 413)", which is opaque to
 * anyone not reading the source.
 *
 * Runs under `bun run test:dom` (jsdom substrate).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { cleanup, render, waitFor } from '@testing-library/react';

const { TextViewer } = await import('./TextViewer.tsx');

/** Stub `fetch` with a resolved non-OK response of the given status. The
 *  viewer throws on `!resp.ok` before touching the body, so an empty
 *  `text()` is sufficient. */
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
    // The opaque code the old message surfaced must be gone.
    expect(text).not.toContain('HTTP 413');
  });

  test('404 renders a not-found explanation', async () => {
    globalThis.fetch = mockFetchStatus(404);
    const { container } = render(
      <TextViewer src="/api/asset-text?path=gone.csv" fileName="gone.csv" extension="csv" />,
    );
    await waitFor(() => {
      expect(container.querySelector('[data-text-viewer-state="error"]')).not.toBeNull();
    });
    expect(container.textContent ?? '').toContain('could not be found');
  });

  test('an unmapped status keeps the diagnostic code for debuggability', async () => {
    globalThis.fetch = mockFetchStatus(503);
    const { container } = render(
      <TextViewer src="/api/asset-text?path=weird.bin" fileName="weird.bin" extension="bin" />,
    );
    await waitFor(() => {
      expect(container.querySelector('[data-text-viewer-state="error"]')).not.toBeNull();
    });
    const text = container.textContent ?? '';
    expect(text).toContain('Something went wrong opening this file');
    expect(text).toContain('HTTP 503');
  });
});

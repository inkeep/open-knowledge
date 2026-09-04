/**
 * Pin the `mediaKind === 'text'` dispatch in `AssetPreview`. Cases:
 *
 *   1. Natural default — extensions in `SIDEBAR_TEXT_EXTENSIONS` (json /
 *      toml) parse through `mediaKindForSidebarAssetExtension` as
 *      `'text'`, and the preview pane mounts the `TextViewer` rather
 *      than the generic "Open file" fallback.
 *   2. Text-viewer fallback set — `.base` / `.canvas` also resolve to
 *      `mediaKind:'text'` via the separate fallback set and mount the
 *      TextViewer directly (no chooser).
 *   3. Override path — the user clicks "View as text"
 *      from the fallback pane (e.g. a `.zip` / `.yaml` / `.DS_Store`).
 *      The local `forceText` state flips and the same preview pane
 *      re-renders through the text branch.
 *   4. Negative control — `mediaKind: null` on an unknown extension
 *      shows the fallback, which offers "Open file" (dispatched via
 *      dispatchAssetClick, not a raw anchor) and "View as text". The
 *      "Open file" must NOT be a raw <a href="/api/asset">
 *      same-frame navigation — that would surface a 415/404 error envelope
 *      as the page content.
 *
 * Runs under `bun run test:dom` (jsdom substrate per precedent #43).
 */

import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';

const dispatchAssetClickStub = vi.fn(async () => {});
vi.doMock('@/editor/asset-dispatch', () => ({
  dispatchAssetClick: dispatchAssetClickStub,
}));

vi.doMock('@/lib/config-provider', () => ({
  useConfigContext: () => ({
    merged: null,
    projectLocalBinding: null,
  }),
}));

const { AssetPreview } = await import('./AssetPreview.tsx');

describe('AssetPreview — text-viewer dispatch', () => {
  afterEach(() => {
    cleanup();
    dispatchAssetClickStub.mockClear();
  });

  test('mediaKind=text on a json asset mounts TextViewer (not the fallback)', () => {
    const { container } = render(<AssetPreview assetPath="docs/sample.json" mediaKind="text" />);
    expect(container.querySelector('[data-text-viewer]')).not.toBeNull();
    expect(container.querySelector('[data-text-viewer-extension="json"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="asset-preview-open-as-text"]')).toBeNull();
  });

  test('mediaKind=text mounts TextViewer for .base (Obsidian Bases)', () => {
    const { container } = render(
      <AssetPreview assetPath="vault/Characters.base" mediaKind="text" />,
    );
    expect(container.querySelector('[data-text-viewer]')).not.toBeNull();
    expect(container.querySelector('[data-text-viewer-extension="base"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="asset-preview-open-as-text"]')).toBeNull();
  });

  test('mediaKind=text mounts TextViewer for .canvas (Obsidian Canvas)', () => {
    const { container } = render(<AssetPreview assetPath="vault/Board.canvas" mediaKind="text" />);
    expect(container.querySelector('[data-text-viewer]')).not.toBeNull();
    expect(container.querySelector('[data-text-viewer-extension="canvas"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="asset-preview-open-as-text"]')).toBeNull();
  });

  test('fallback pane has no raw <a href="/api/asset"> same-frame nav (FR2)', () => {
    const { container } = render(<AssetPreview assetPath="docs/data.zip" mediaKind={null} />);
    expect(container.querySelector('a[href*="/api/asset"]')).toBeNull();
    expect(container.querySelector('[data-testid="asset-preview-open-as-text"]')).not.toBeNull();
    expect(container.querySelector('[data-text-viewer]')).toBeNull();
  });

  test('"Open file" button calls dispatchAssetClick (not window navigation)', () => {
    const { container } = render(<AssetPreview assetPath="docs/report.docx" mediaKind={null} />);
    const openFileBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      /open file/i.test(b.textContent ?? ''),
    );
    expect(openFileBtn).not.toBeNull();
    fireEvent.click(openFileBtn as HTMLButtonElement);
    expect(dispatchAssetClickStub).toHaveBeenCalledTimes(1);
    expect(dispatchAssetClickStub.mock.calls[0]?.[0]).toMatchObject({
      url: expect.stringContaining('/api/asset?path='),
      projectRelPath: 'docs/report.docx',
      ext: 'docx',
    });
  });

  test('clicking "View as text" flips into the text branch', () => {
    const { container } = render(<AssetPreview assetPath="docs/report.pdf" mediaKind={null} />);
    const btn = container.querySelector(
      '[data-testid="asset-preview-open-as-text"]',
    ) as HTMLButtonElement | null;
    expect(btn).not.toBeNull();
    fireEvent.click(btn as HTMLButtonElement);
    expect(container.querySelector('[data-text-viewer]')).not.toBeNull();
    expect(container.querySelector('[data-text-viewer-extension="pdf"]')).not.toBeNull();
  });
});

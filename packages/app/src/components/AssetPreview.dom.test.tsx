/**
 * RTL behavioral tests for AssetPreview's loading-state contract. Sibling to
 * Image.dom.test.tsx — both surfaces consume the same shared `LoadingImage`
 * primitive, so the testids (`image-loading-skeleton` / `image-slot`) are
 * shared by design; distinct testids would fragment the contract for one
 * underlying primitive.
 *
 * Pins the no-intrinsic-dimensions branch: AssetPreview passes neither
 * `width` nor `height`, so the slot reserves space via an `aspect-[16/9]`
 * className rather than inline `style.width` / `style.aspectRatio` — that's
 * why test 2 below pins className, where Image.dom.test.tsx test 2 pins style.
 * The reservation is released post-load (test 3) so the consumer's
 * `object-contain / max-h-full` styling can govern the image's natural shape;
 * keeping the 16:9 class forever would letterbox portrait assets in the
 * sidebar — a regression vs. the bare `<img object-contain>` it replaces.
 *
 * Runs under `bun run test:dom` (jsdom substrate per precedent #43).
 */

import * as actualLinguiMacro from '@lingui/react/macro';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { renderLinguiTemplate } from '@/test-utils/lingui-mock';
import {
  expectVisualClassTokens,
  expectVisualClassTokensAbsent,
} from '@/test-utils/visual-contract';

vi.doMock('@lingui/react/macro', () => ({
  ...actualLinguiMacro,
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
  useLingui: () => ({ t: renderLinguiTemplate }),
}));

let mergedConfig: { appearance?: { sidebar?: { showOnlyMarkdownFiles?: boolean } } } | null = null;
vi.doMock('@/lib/config-provider', () => ({
  useConfigContext: () => ({
    merged: mergedConfig,
    projectLocalSynced: true,
    projectLocalBinding: null,
  }),
}));

vi.doMock('@/editor/components/Pdf', () => ({
  Pdf: (props: { src?: string; title?: string; fillContainer?: boolean }) => (
    <div data-testid="pdf-stub" data-src={props.src} data-fill={String(!!props.fillContainer)}>
      pdf:{props.title ?? ''}
    </div>
  ),
}));

const { AssetPreview } = await import('./AssetPreview');

describe('AssetPreview — image loading-state placeholder (PRD-6638)', () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    consoleErrorSpy.mockRestore();
    consoleWarnSpy.mockRestore();
  });

  test('renders a loading-state placeholder before the <img>.load event fires', () => {
    render(<AssetPreview assetPath="assets/cat.png" mediaKind="image" />);

    const skeleton = screen.queryByTestId('image-loading-skeleton');
    expect(skeleton).not.toBeNull();
  });

  test('reserves layout space via fallback aspect-[16/9] className when no intrinsic dimensions are supplied', () => {
    render(<AssetPreview assetPath="assets/cat.png" mediaKind="image" />);

    const slot = screen.queryByTestId('image-slot') as HTMLElement | null;
    expect(slot).not.toBeNull();
    expectVisualClassTokens(slot?.className, ['aspect-[16/9]']);
  });

  test('removes the placeholder and releases the aspect-ratio constraint after the inner <img>.load event fires', () => {
    const { container } = render(<AssetPreview assetPath="assets/cat.png" mediaKind="image" />);

    expect(screen.queryByTestId('image-loading-skeleton')).not.toBeNull();

    const img = container.querySelector('img');
    expect(img).not.toBeNull();
    fireEvent.load(img as HTMLImageElement);

    expect(screen.queryByTestId('image-loading-skeleton')).toBeNull();

    const slotAfterLoad = screen.queryByTestId('image-slot') as HTMLElement | null;
    expect(slotAfterLoad).not.toBeNull();
    expectVisualClassTokensAbsent(slotAfterLoad?.className, ['aspect-[16/9]']);
  });

  test('renders an <audio> player for mediaKind="audio"', () => {
    const { container } = render(<AssetPreview assetPath="assets/song.mp3" mediaKind="audio" />);
    expect(container.querySelector('audio')).not.toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('video')).toBeNull();
    expect(container.querySelector('a[href]')).toBeNull();
  });

  test('dispatches to <Pdf fillContainer> for mediaKind="pdf"', () => {
    const { container } = render(<AssetPreview assetPath="assets/paper.pdf" mediaKind="pdf" />);
    const pdf = container.querySelector('[data-testid="pdf-stub"]') as HTMLElement | null;
    expect(pdf).not.toBeNull();
    expect(pdf?.dataset.src).toContain('paper.pdf');
    expect(pdf?.dataset.fill).toBe('true');
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('video')).toBeNull();
    expect(container.querySelector('audio')).toBeNull();
  });

  test('renders the "Open file" fallback for mediaKind=null', () => {
    const { container } = render(<AssetPreview assetPath="assets/data.csv" mediaKind={null} />);
    const openFileBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      /open file/i.test(b.textContent ?? ''),
    );
    expect(openFileBtn).not.toBeNull();
    expect(container.querySelector('a[href*="/api/asset"]')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('audio')).toBeNull();
    expect(container.querySelector('video')).toBeNull();
    expect(container.querySelector('[data-testid="pdf-stub"]')).toBeNull();
  });

  test('restores the placeholder when assetPath changes (sidebar asset switching)', () => {
    const { container, rerender } = render(
      <AssetPreview assetPath="assets/a.png" mediaKind="image" />,
    );

    const firstImg = container.querySelector('img');
    fireEvent.load(firstImg as HTMLImageElement);
    expect(screen.queryByTestId('image-loading-skeleton')).toBeNull();

    rerender(<AssetPreview assetPath="assets/b.png" mediaKind="image" />);

    expect(screen.queryByTestId('image-loading-skeleton')).not.toBeNull();
    const slot = screen.queryByTestId('image-slot') as HTMLElement | null;
    expectVisualClassTokens(slot?.className, ['aspect-[16/9]']);
  });
});

describe('AssetPreview — not-in-sidebar indicator', () => {
  beforeEach(() => {
    mergedConfig = {};
  });

  afterEach(() => cleanup());

  test('a visible asset renders no indicator', () => {
    render(<AssetPreview assetPath="assets/data.csv" mediaKind={null} />);
    expect(screen.queryByTestId('not-in-sidebar-indicator')).toBeNull();
  });

  test('a dot-path asset names the hidden-files toggle above the preview', () => {
    render(<AssetPreview assetPath=".scratch/data.csv" mediaKind={null} />);
    expect(screen.queryByTestId('not-in-sidebar-indicator')).not.toBeNull();
    expect(screen.queryByTestId('not-in-sidebar-flip-hidden-files')).not.toBeNull();
    expect(screen.queryByTestId('not-in-sidebar-flip-only-markdown')).toBeNull();
  });

  test('only-markdown mode names its toggle for a visible non-markdown asset', () => {
    mergedConfig = { appearance: { sidebar: { showOnlyMarkdownFiles: true } } };
    render(<AssetPreview assetPath="assets/data.csv" mediaKind={null} />);
    expect(screen.queryByTestId('not-in-sidebar-flip-only-markdown')).not.toBeNull();
    expect(screen.queryByTestId('not-in-sidebar-flip-hidden-files')).toBeNull();
    expect(screen.queryByTestId('asset-preview-open-as-text')).not.toBeNull();
  });
});

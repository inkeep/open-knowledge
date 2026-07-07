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
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import {
  expectVisualClassTokens,
  expectVisualClassTokensAbsent,
} from '@/test-utils/visual-contract';

// `<Pdf>` lazy-loads pdfjs-dist via `await import()` inside an effect and
// uses `ResizeObserver` synchronously during render to compute fit-width /
// fit-height base scale. jsdom provides neither, and booting pdfjs in a
// node test is gratuitous when the contract being tested is
// `AssetPreview` dispatch (does the right branch get picked), not Pdf's
// internals. Replace with a marker that lets the structural assertion
// pin `mediaKind="pdf"` → Pdf-branch chosen without mounting the real
// component. Sibling `Pdf.dom.test.tsx` (per `bun run test:dom`'s
// substrate) is the right place for Pdf's internal coverage.
mock.module('@/editor/components/Pdf', () => ({
  Pdf: (props: { src?: string; title?: string; fillContainer?: boolean }) => (
    <div data-testid="pdf-stub" data-src={props.src} data-fill={String(!!props.fillContainer)}>
      pdf:{props.title ?? ''}
    </div>
  ),
}));

const { AssetPreview } = await import('./AssetPreview');

describe('AssetPreview — image loading-state placeholder (PRD-6638)', () => {
  let consoleErrorSpy: ReturnType<typeof spyOn>;
  let consoleWarnSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    consoleErrorSpy = spyOn(console, 'error').mockImplementation(() => {});
    consoleWarnSpy = spyOn(console, 'warn').mockImplementation(() => {});
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
    // Behavioral pin (no-intrinsic-dimensions branch): the slot reserves
    // space via the Tailwind `aspect-[16/9]` class rather than inline
    // `style.width` / `style.aspectRatio`. AssetPreview passes no width /
    // height (sidebar layout is flex-constrained via slotClassName / className
    // overrides), so the LoadingImage primitive falls through to the
    // className fallback path.
    expectVisualClassTokens(slot?.className, ['aspect-[16/9]']);
  });

  test('removes the placeholder and releases the aspect-ratio constraint after the inner <img>.load event fires', () => {
    const { container } = render(<AssetPreview assetPath="assets/cat.png" mediaKind="image" />);

    // Sanity precondition: skeleton present pre-load (the test above pins
    // this independently; re-checking here makes the swap assertion read
    // as a delta and produces a clearer failure when only the swap is broken).
    expect(screen.queryByTestId('image-loading-skeleton')).not.toBeNull();

    const img = container.querySelector('img');
    expect(img).not.toBeNull();
    fireEvent.load(img as HTMLImageElement);

    expect(screen.queryByTestId('image-loading-skeleton')).toBeNull();

    // Post-load: the slot must release the 16:9 aspect-ratio class so the
    // consumer's `object-contain / max-h-full` styling can govern the image's
    // natural shape. Without this, portrait assets in the sidebar would be
    // permanently letterboxed inside a forced 16:9 box — a regression vs. the
    // bare `<img object-contain>` AssetPreview replaced.
    const slotAfterLoad = screen.queryByTestId('image-slot') as HTMLElement | null;
    expect(slotAfterLoad).not.toBeNull();
    expectVisualClassTokensAbsent(slotAfterLoad?.className, ['aspect-[16/9]']);
  });

  test('renders an <audio> player for mediaKind="audio"', () => {
    // Audio branch added when `.mp3` / `.wav` / etc. were promoted to
    // sidebar-renderable. Pins the dispatch: not <img>, not <video>, not
    // the generic "Open file" fallback.
    const { container } = render(<AssetPreview assetPath="assets/song.mp3" mediaKind="audio" />);
    expect(container.querySelector('audio')).not.toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('video')).toBeNull();
    expect(container.querySelector('a[href]')).toBeNull();
  });

  test('dispatches to <Pdf fillContainer> for mediaKind="pdf"', () => {
    // PDF branch routes to the bundled `<Pdf>` component with
    // `fillContainer` so the route-level pane (not the inline 600px
    // default) governs height. The Pdf module is mocked at the top of
    // this file — see comment there for the rationale.
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
    // Generic fallback for types with no inline preview (zip, docx, csv, …).
    // "Open file" is a button that dispatches via dispatchAssetClick —
    // NOT a raw <a href="/api/asset"> same-frame nav (that would render
    // the API's error envelope as the page for non-allowlisted extensions).
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
    // Sidebar switching between assets is the primary AssetPreview use case
    // and exercises the no-intrinsic-dimensions reset path independently of
    // Image.tsx's intrinsic-dimensions tests. Without `useLayoutEffect([src])`
    // the previous asset's loaded state would leak into the new one and the
    // skeleton would never reappear during the switch.
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

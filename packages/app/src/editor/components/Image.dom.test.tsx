/**
 * Tier-3 RTL behavioral tests for the Image component's loading-state contract
 * embedded images must render a loading-state placeholder that
 * reserves the layout slot until the inner <img>.load event fires, then swap to
 * the real <img>. Without this contract the rendered DOM transitions through a
 * "empty / 0×0 box → bytes arrive → reflow" sequence — the symptom the
 * reporter observed in the WYSIWYG editor.
 *
 * Invocation via `bun run test:dom`; jsdom substrate per precedent #43.
 * Sibling: DocumentErrorBoundary.dom.test.tsx, FileTree.selection-mirror.dom.test.tsx.
 *
 * Selector contract:
 *   - data-testid="image-loading-skeleton" — the loading-state element. Distinct
 *     from shadcn Skeleton's default data-slot="skeleton" so the Image surface
 *     stays queryable independent of any other Skeleton on the page.
 *   - data-testid="image-slot" — the layout-reserving wrapper carrying the
 *     intrinsic dimensions as inline style (style.width + style.aspectRatio).
 *     Inline `style` is the only path that resolves under jsdom AND supports
 *     dynamic numeric dimensions (Tailwind's `w-[400px]` would not resolve in
 *     jsdom's computed style and cannot be authored statically for arbitrary
 *     author-supplied widths in any case).
 *
 * Mocking discipline: react-medium-image-zoom IS mocked as a
 * pass-through wrapper. The wrap is orthogonal to the loading-state contract,
 * and the real <Zoom> attaches a ResizeObserver on mount — jsdom doesn't ship
 * ResizeObserver, so a real render throws `ReferenceError: ResizeObserver is
 * not defined` from inside RTL's act bridge before any of our assertions run.
 * The pass-through preserves the inner <img> shape (which IS under test) and
 * defeats the infrastructure noise without changing what the Image component
 * promises its callers.
 */
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { expectVisualClassTokens } from '@/test-utils/visual-contract';

mock.module('react-medium-image-zoom', () => ({
  default: ({ children }: { children: React.ReactNode }) => children,
}));

const { Image } = await import('./Image');

describe('Image — loading-state placeholder (PRD-6638)', () => {
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
    render(<Image src="/assets/cat.png" alt="" width={400} height={300} />);

    const skeleton = screen.queryByTestId('image-loading-skeleton');
    expect(skeleton).not.toBeNull();
  });

  test('reserves layout space matching intrinsic width/height before load', () => {
    render(<Image src="/assets/cat.png" alt="" width={400} height={300} />);

    const slot = screen.queryByTestId('image-slot') as HTMLElement | null;
    expect(slot).not.toBeNull();
    // Behavioral pin: the slot reserves dimensions matching the intrinsic
    // image size, so the document does not reflow when bytes arrive. Inline
    // `style` is the only viable implementation (see file-level comment).
    expect(slot?.style.width).toBe('400px');
    expect(slot?.style.aspectRatio).toBe('400 / 300');
  });

  test('reserves layout space when width/height are passed as numeric strings (MDX descriptor path)', () => {
    // MDX attribute values arrive as strings — Image.tsx's coerceDimension
    // helper converts "400" → 400 so hasIntrinsicDimensions returns true and
    // the slot reserves the precise aspect ratio via inline style. Without
    // the coercion, the slot would silently fall through to the
    // aspect-[16/9] className fallback — a degraded version of the layout
    // shift this fix exists to prevent.
    render(<Image src="/assets/cat.png" alt="" width="400" height="300" />);

    const slot = screen.queryByTestId('image-slot') as HTMLElement | null;
    expect(slot).not.toBeNull();
    expect(slot?.style.width).toBe('400px');
    expect(slot?.style.aspectRatio).toBe('400 / 300');
  });

  test('falls back to aspect-[16/9] when width is a non-numeric string (e.g. "100%")', () => {
    // coerceDimension's passthrough branch: when an MDX descriptor delivers a
    // non-numeric string (e.g. "100%", "auto"), hasIntrinsicDimensions returns
    // false and the slot drops to the className fallback. A future refactor
    // that extracted a leading numeric prefix (parseInt("100%") → 100) would
    // silently produce a slot of width: 100px with an incorrect aspect ratio;
    // this test pins the fallback path so that regression would surface.
    render(<Image src="/assets/cat.png" alt="" width="100%" height={300} />);

    const slot = screen.queryByTestId('image-slot') as HTMLElement | null;
    expect(slot).not.toBeNull();
    expect(slot?.style.width).toBeFalsy();
    expectVisualClassTokens(slot?.className, ['aspect-[16/9]']);
  });

  test('removes the placeholder after the inner <img>.load event fires', () => {
    const { container } = render(<Image src="/assets/cat.png" alt="" width={400} height={300} />);

    // Sanity precondition: skeleton present pre-load (the test above pins
    // this independently; re-checking here makes the swap assertion read
    // as a delta and produces a clearer failure when only the swap is broken).
    expect(screen.queryByTestId('image-loading-skeleton')).not.toBeNull();

    const img = container.querySelector('img');
    expect(img).not.toBeNull();
    fireEvent.load(img as HTMLImageElement);

    expect(screen.queryByTestId('image-loading-skeleton')).toBeNull();
  });

  test('dismisses placeholder when the image is already complete at mount (covers cached-success and cached-failure)', () => {
    // Cached images may have `complete=true` at first paint and the `load`
    // event may not re-fire after React commits — the skeleton would stay
    // visible forever and the <img> stuck at opacity-0. This covers both
    // cached-success (`complete=true, naturalWidth>0`) and cached-failure
    // (`complete=true, naturalWidth=0`) because the SUT treats `complete`
    // alone as the terminal-state signal — `naturalWidth` is intentionally
    // not consulted (so cached failures whose `onerror` won't re-fire still
    // dismiss the skeleton, letting the browser's native broken-image
    // indicator become visible).
    // jsdom's preload doesn't expose HTMLImageElement on globalThis, so
    // reach through `window` to override the prototype getters.
    const ImgProto = (window as Window).HTMLImageElement.prototype;
    const prevComplete = Object.getOwnPropertyDescriptor(ImgProto, 'complete');
    Object.defineProperty(ImgProto, 'complete', { configurable: true, get: () => true });

    try {
      render(<Image src="/assets/cat.png" alt="" width={400} height={300} />);

      expect(screen.queryByTestId('image-loading-skeleton')).toBeNull();
    } finally {
      if (prevComplete) {
        Object.defineProperty(ImgProto, 'complete', prevComplete);
      } else {
        Reflect.deleteProperty(ImgProto, 'complete');
      }
    }
  });

  test('removes the placeholder after the inner <img>.error event fires (broken image)', () => {
    // Without an onError handler the <img> stays at opacity-0 forever — a
    // regression from default <img> behavior where the browser shows its
    // native broken-image indicator. Screen readers also stay parked on
    // aria-busy="true" with no way to distinguish "still loading" from
    // "permanently broken". Dismissing the skeleton on error lets the
    // browser's broken-image indicator become visible.
    const { container } = render(
      <Image src="/missing-asset.png" alt="" width={400} height={300} />,
    );

    expect(screen.queryByTestId('image-loading-skeleton')).not.toBeNull();

    const img = container.querySelector('img');
    expect(img).not.toBeNull();
    fireEvent.error(img as HTMLImageElement);

    expect(screen.queryByTestId('image-loading-skeleton')).toBeNull();
  });

  test('restores the placeholder when src changes (e.g. AssetPreview switching assets)', () => {
    // AssetPreview re-renders the same LoadingImage instance with a new
    // assetPath/src when the sidebar selection changes. Without resetting
    // `loaded` on src-change, the new image renders at opacity-100 with no
    // skeleton and then reflows when bytes arrive.
    const { container, rerender } = render(
      <Image src="/assets/a.png" alt="" width={400} height={300} />,
    );

    const firstImg = container.querySelector('img');
    fireEvent.load(firstImg as HTMLImageElement);
    expect(screen.queryByTestId('image-loading-skeleton')).toBeNull();

    rerender(<Image src="/assets/b.png" alt="" width={400} height={300} />);

    expect(screen.queryByTestId('image-loading-skeleton')).not.toBeNull();
  });
});

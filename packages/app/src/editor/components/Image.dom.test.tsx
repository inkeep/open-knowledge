/**
 * Tier-3 RTL behavioral tests for the Image component's loading-state contract
 * embedded images must render a loading-state placeholder that
 * reserves the layout slot until the inner <img>.load event fires, then swap to
 * the real <img>. Without this contract the rendered DOM transitions through a
 * "empty / 0×0 box → bytes arrive → reflow" sequence — the symptom the
 * reporter observed in the WYSIWYG editor.
 *
 * Invocation via `pnpm run test:dom`; jsdom substrate per precedent #43.
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

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { expectVisualClassTokens } from '@/test-utils/visual-contract';

vi.doMock('react-medium-image-zoom', () => ({
  default: ({ children }: { children: React.ReactNode }) => children,
}));

// The project inventory that feeds target-existence classification is a
// fetched-from-`/api/documents` boundary; stub it here (null = no provider, the
// same "unknown" state a portal/renderToString render sees). Only the fields
// the classifier reads are supplied.
type StubPageList = { assetPaths: Set<string>; filePaths: Set<string>; loading: boolean };
let currentPageList: StubPageList | null = null;
vi.doMock('@/components/PageListContext', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/PageListContext')>();
  return {
    ...actual,
    useOptionalPageList: () =>
      currentPageList as unknown as ReturnType<typeof actual.useOptionalPageList>,
  };
});

beforeEach(() => {
  currentPageList = null;
});

const { Image } = await import('./Image');

describe('Image — loading-state placeholder (PRD-6638)', () => {
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

  test('dismisses placeholder when the image is already complete at mount', () => {
    // Cached images may have `complete=true` at first paint and the `load`
    // event may not re-fire after React commits — the skeleton would stay
    // visible forever and the <img> stuck at opacity-0. The SUT treats
    // `complete` alone as the terminal-state signal; `naturalWidth` is
    // NOT consulted at mount (it can't distinguish a failed fetch from a
    // dimensionless SVG, so onError is the only unambiguous error signal
    // and cached-broken images fall through to the browser's default
    // broken-image glyph).
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

  test('broken image always renders role=img + aria-label (alt="" no longer silences)', () => {
    // alt="" at this layer conflates the WCAG decorative opt-in with the
    // "no alt authored" case (Image.tsx coerces `props.alt ?? ''`, and
    // `![](/x.png)` markdown reaches here with alt=''). Announcing on
    // both is the safer default — otherwise broken no-alt-authored
    // images fall silent to assistive tech.
    const { container } = render(<Image src="/missing.png" alt="" width={400} height={300} />);
    fireEvent.error(container.querySelector('img') as HTMLImageElement);
    const slot = screen.getByTestId('image-slot');
    expect(slot.getAttribute('data-image-error')).toBe('true');
    // Placeholder overlay carries the ARIA — the slot's img is kept in
    // DOM (hidden) so consumers can still inspect src.
    const overlay = slot.querySelector('[role="img"]');
    expect(overlay).not.toBeNull();
    // No project inventory (currentPageList = null) → 'unknown' existence → a
    // load failure reads as undisplayable, never claiming the target is absent.
    expect(overlay?.getAttribute('aria-label')).toBe("Image couldn't be displayed: /missing.png");
    expect(slot.getAttribute('aria-hidden')).toBeNull();
    // Img stays mounted (hidden) so tests + walkers can still find its src.
    const img = slot.querySelector('img');
    expect(img).not.toBeNull();
    expect(img?.hasAttribute('hidden')).toBe(true);
    expect(img?.getAttribute('src')).toBe('/missing.png');
  });

  test('non-decorative broken image (alt="...") uses alt in the aria-label', () => {
    // Symmetric coverage: pin role=img + aria-label + no aria-hidden on
    // the alt-provided branch, so a future refactor can't silently drop
    // screen-reader semantics from either shape.
    const { container } = render(
      <Image src="/missing.png" alt="a cat photo" width={400} height={300} />,
    );
    fireEvent.error(container.querySelector('img') as HTMLImageElement);
    const slot = screen.getByTestId('image-slot');
    const overlay = slot.querySelector('[role="img"]');
    expect(overlay?.getAttribute('aria-label')).toBe("Image couldn't be displayed: a cat photo");
    expect(slot.getAttribute('aria-hidden')).toBeNull();
    // Img stays mounted (hidden) in the alt-provided branch too, so DOM
    // inspectors can still find src regardless of alt shape.
    const img = slot.querySelector('img');
    expect(img).not.toBeNull();
    expect(img?.hasAttribute('hidden')).toBe(true);
    expect(img?.getAttribute('src')).toBe('/missing.png');
  });

  test('renders a visible placeholder card after the inner <img>.error event fires (broken image)', () => {
    // The browser's default broken-image glyph is a 16x16 icon that reads as
    // "the block rendered empty" — the reporter's ask was for something
    // visible so the reader knows the asset is missing. Placeholder is a
    // <span> for the same phrasing-content reason the slot is (Image.tsx
    // wraps in <Zoom wrapElement="span">, and markdown lands <img> inside
    // <p> where <div> is forbidden).
    const { container } = render(
      <Image src="/missing-asset.png" alt="broken" width={400} height={300} />,
    );

    expect(screen.queryByTestId('image-loading-skeleton')).not.toBeNull();

    const img = container.querySelector('img');
    expect(img).not.toBeNull();
    fireEvent.error(img as HTMLImageElement);

    // Skeleton gone, placeholder overlay mounted, src surfaced for triage.
    expect(screen.queryByTestId('image-loading-skeleton')).toBeNull();
    const slot = screen.getByTestId('image-slot');
    expect(slot.getAttribute('data-image-error')).toBe('true');
    expect(slot.textContent).toContain("Image couldn't be displayed");
    expect(slot.textContent).toContain('/missing-asset.png');
    // Stays inline for phrasing-content compatibility with <p>.
    expect(slot.tagName).toBe('SPAN');
    // Img stays mounted (hidden) so DOM inspectors still find src.
    const imgAfterError = slot.querySelector('img');
    expect(imgAfterError).not.toBeNull();
    expect(imgAfterError?.getAttribute('src')).toBe('/missing-asset.png');
    expect(imgAfterError?.hasAttribute('hidden')).toBe(true);
  });

  test('error pill chrome is clipboard-opt-out; the mounted <img> is not', () => {
    // The pill is render-layer chrome. On WYSIWYG copy the clipboard walker
    // clones the rendered DOM — children marked with the opt-out attr are
    // stripped from the clone (walkPair), while the hidden <img> stays so
    // the relative-URL source-fallback classifier still sees the authored
    // src. Without the marker, "Image failed to load" plus the src text
    // paste into cross-app destinations as if they were document content.
    const { container } = render(
      <Image src="/missing-asset.png" alt="broken" width={400} height={300} />,
    );
    fireEvent.error(container.querySelector('img') as HTMLImageElement);

    const slot = screen.getByTestId('image-slot');
    const optOut = slot.querySelector('[data-clipboard-omit="true"]');
    expect(optOut).not.toBeNull();
    expect(optOut?.textContent).toContain("Image couldn't be displayed");
    const img = slot.querySelector('img');
    expect(img?.getAttribute('data-clipboard-omit')).toBeNull();
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

  test('src change after an error clears the error placeholder', () => {
    // The mount-time effect resets hasError on src change; without this,
    // an AssetPreview that hits a broken asset first would stay pinned on
    // the "Image failed to load" pill for every subsequent selection.
    const { container, rerender } = render(
      <Image src="/missing.png" alt="broken" width={400} height={300} />,
    );
    fireEvent.error(container.querySelector('img') as HTMLImageElement);
    expect(screen.getByTestId('image-slot').getAttribute('data-image-error')).toBe('true');

    rerender(<Image src="/assets/works.png" alt="works" width={400} height={300} />);
    // Placeholder cleared; back to the loading-state slot.
    expect(screen.getByTestId('image-slot').getAttribute('data-image-error')).toBeNull();
    // loaded was also reset — skeleton must reappear for the new src or
    // the '0x0 box → bytes arrive → reflow' layout shift would silently
    // recur when a broken image is followed by a good one.
    expect(screen.queryByTestId('image-loading-skeleton')).not.toBeNull();
    // hidden was also cleared — the <img> must be visible for the new src.
    // Pins the inverse of the error-state hidden-attr assertions above so
    // the recovery path can't silently regress.
    const imgAfterRecovery = screen.getByTestId('image-slot').querySelector('img');
    expect(imgAfterRecovery?.hasAttribute('hidden')).toBe(false);
  });
});

describe('Image — target-existence wiring (PRD-7860)', () => {
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

  function seedInventory(assetPaths: string[], filePaths: string[] = []) {
    currentPageList = {
      assetPaths: new Set(assetPaths),
      filePaths: new Set(filePaths),
      loading: false,
    };
  }

  test('a src the inventory does not contain renders "Image not found" with no load attempt', () => {
    seedInventory(['images/present.png']);
    render(<Image src="/images/ghost.png" alt="" />);

    const slot = screen.getByTestId('image-slot');
    expect(slot.getAttribute('data-image-error-kind')).toBe('not-found');
    expect(slot.querySelector('[role="img"]')?.getAttribute('aria-label')).toBe(
      'Image not found: /images/ghost.png',
    );
    // The authored src is still queryable on the hidden <img> for clipboard.
    const img = slot.querySelector('img');
    expect(img?.hasAttribute('hidden')).toBe(true);
    expect(img?.getAttribute('src')).toBe('/images/ghost.png');
  });

  test('a tracked src that loads shows the image with no placeholder', () => {
    seedInventory(['images/cat.png']);
    const { container } = render(<Image src="/images/cat.png" alt="" />);
    fireEvent.load(container.querySelector('img') as HTMLImageElement);

    const slot = screen.getByTestId('image-slot');
    expect(slot.getAttribute('data-image-error')).toBeNull();
    expect(slot.querySelector('[role="img"]')).toBeNull();
  });

  test('a tracked src that fails to display says "couldn\'t be displayed", not missing', () => {
    seedInventory(['images/cat.png']);
    const { container } = render(<Image src="/images/cat.png" alt="" />);
    fireEvent.error(container.querySelector('img') as HTMLImageElement);

    const slot = screen.getByTestId('image-slot');
    expect(slot.getAttribute('data-image-error-kind')).toBe('undisplayable');
    expect(slot.querySelector('[role="img"]')?.textContent).toContain("couldn't be displayed");
  });

  test('creating the target on disk heals "not found" to a fresh load', () => {
    seedInventory([]);
    const { rerender } = render(<Image src="/images/created.png" alt="" />);
    expect(screen.getByTestId('image-slot').getAttribute('data-image-error-kind')).toBe(
      'not-found',
    );

    // Target lands on disk → the next `/api/documents` snapshot lists it →
    // the oracle flips missing → exists on re-render.
    seedInventory(['images/created.png']);
    rerender(<Image src="/images/created.png" alt="" />);

    const slot = screen.getByTestId('image-slot');
    expect(slot.getAttribute('data-image-error')).toBeNull();
    expect(screen.queryByTestId('image-loading-skeleton')).not.toBeNull();
  });
});

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
    expect(slot?.style.width).toBe('400px');
    expect(slot?.style.aspectRatio).toBe('400 / 300');
  });

  test('reserves layout space when width/height are passed as numeric strings (MDX descriptor path)', () => {
    render(<Image src="/assets/cat.png" alt="" width="400" height="300" />);

    const slot = screen.queryByTestId('image-slot') as HTMLElement | null;
    expect(slot).not.toBeNull();
    expect(slot?.style.width).toBe('400px');
    expect(slot?.style.aspectRatio).toBe('400 / 300');
  });

  test('falls back to aspect-[16/9] when width is a non-numeric string (e.g. "100%")', () => {
    render(<Image src="/assets/cat.png" alt="" width="100%" height={300} />);

    const slot = screen.queryByTestId('image-slot') as HTMLElement | null;
    expect(slot).not.toBeNull();
    expect(slot?.style.width).toBeFalsy();
    expectVisualClassTokens(slot?.className, ['aspect-[16/9]']);
  });

  test('removes the placeholder after the inner <img>.load event fires', () => {
    const { container } = render(<Image src="/assets/cat.png" alt="" width={400} height={300} />);

    expect(screen.queryByTestId('image-loading-skeleton')).not.toBeNull();

    const img = container.querySelector('img');
    expect(img).not.toBeNull();
    fireEvent.load(img as HTMLImageElement);

    expect(screen.queryByTestId('image-loading-skeleton')).toBeNull();
  });

  test('dismisses placeholder when the image is already complete at mount', () => {
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
    const { container } = render(<Image src="/missing.png" alt="" width={400} height={300} />);
    fireEvent.error(container.querySelector('img') as HTMLImageElement);
    const slot = screen.getByTestId('image-slot');
    expect(slot.getAttribute('data-image-error')).toBe('true');
    const overlay = slot.querySelector('[role="img"]');
    expect(overlay).not.toBeNull();
    expect(overlay?.getAttribute('aria-label')).toBe("Image couldn't be displayed: /missing.png");
    expect(slot.getAttribute('aria-hidden')).toBeNull();
    const img = slot.querySelector('img');
    expect(img).not.toBeNull();
    expect(img?.hasAttribute('hidden')).toBe(true);
    expect(img?.getAttribute('src')).toBe('/missing.png');
  });

  test('non-decorative broken image (alt="...") uses alt in the aria-label', () => {
    const { container } = render(
      <Image src="/missing.png" alt="a cat photo" width={400} height={300} />,
    );
    fireEvent.error(container.querySelector('img') as HTMLImageElement);
    const slot = screen.getByTestId('image-slot');
    const overlay = slot.querySelector('[role="img"]');
    expect(overlay?.getAttribute('aria-label')).toBe("Image couldn't be displayed: a cat photo");
    expect(slot.getAttribute('aria-hidden')).toBeNull();
    const img = slot.querySelector('img');
    expect(img).not.toBeNull();
    expect(img?.hasAttribute('hidden')).toBe(true);
    expect(img?.getAttribute('src')).toBe('/missing.png');
  });

  test('renders a visible placeholder card after the inner <img>.error event fires (broken image)', () => {
    const { container } = render(
      <Image src="/missing-asset.png" alt="broken" width={400} height={300} />,
    );

    expect(screen.queryByTestId('image-loading-skeleton')).not.toBeNull();

    const img = container.querySelector('img');
    expect(img).not.toBeNull();
    fireEvent.error(img as HTMLImageElement);

    expect(screen.queryByTestId('image-loading-skeleton')).toBeNull();
    const slot = screen.getByTestId('image-slot');
    expect(slot.getAttribute('data-image-error')).toBe('true');
    expect(slot.textContent).toContain("Image couldn't be displayed");
    expect(slot.textContent).toContain('/missing-asset.png');
    expect(slot.tagName).toBe('SPAN');
    const imgAfterError = slot.querySelector('img');
    expect(imgAfterError).not.toBeNull();
    expect(imgAfterError?.getAttribute('src')).toBe('/missing-asset.png');
    expect(imgAfterError?.hasAttribute('hidden')).toBe(true);
  });

  test('error pill chrome is clipboard-opt-out; the mounted <img> is not', () => {
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
    const { container, rerender } = render(
      <Image src="/missing.png" alt="broken" width={400} height={300} />,
    );
    fireEvent.error(container.querySelector('img') as HTMLImageElement);
    expect(screen.getByTestId('image-slot').getAttribute('data-image-error')).toBe('true');

    rerender(<Image src="/assets/works.png" alt="works" width={400} height={300} />);
    expect(screen.getByTestId('image-slot').getAttribute('data-image-error')).toBeNull();
    expect(screen.queryByTestId('image-loading-skeleton')).not.toBeNull();
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

    seedInventory(['images/created.png']);
    rerender(<Image src="/images/created.png" alt="" />);

    const slot = screen.getByTestId('image-slot');
    expect(slot.getAttribute('data-image-error')).toBeNull();
    expect(screen.queryByTestId('image-loading-skeleton')).not.toBeNull();
  });
});

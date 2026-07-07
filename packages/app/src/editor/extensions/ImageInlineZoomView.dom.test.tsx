/**
 * Pins the Zoom-wrap contract for `ImageInlineZoomView` — inline `<img>`
 * gets click-to-enlarge with `wrapElement="span"`, `zoomMargin={20}`,
 * `zoomImg.sizes` cleared (descriptor-side `Image.tsx` parity). Sibling:
 * `Image.dom.test.tsx` pins the loading-skeleton contract for the
 * descriptor renderer.
 *
 * `@tiptap/react` is intentionally NOT module-mocked: `mock.module`
 * replaces the whole module and the patch survives Bun's `--isolate`
 * across files in the same `bun test` invocation (oven-sh/bun#12823-class
 * leakage). Sibling files lazily import `./image-inline-zoom` →
 * `ReactNodeViewRenderer` and explode with `Export named ... not found`.
 * The real `NodeViewWrapper` works fine in jsdom for standalone
 * `render()` — the inline-`<span>` choice IS the assertion.
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { cleanup, render } from '@testing-library/react';

mock.module('react-medium-image-zoom', () => ({
  default: ({
    children,
    wrapElement,
    zoomMargin,
    zoomImg,
  }: {
    children: React.ReactNode;
    wrapElement?: string;
    zoomMargin?: number;
    zoomImg?: { sizes?: string };
  }) => (
    <span
      data-zoom-mock
      data-wrap-element={wrapElement}
      data-zoom-margin={String(zoomMargin)}
      // Two-state channel: `'ABSENT'` when the `zoomImg` prop isn't
      // forwarded at all (would let the lightbox inherit the
      // thumbnail-scoped `sizes` — the UX regression this assertion
      // exists to catch), versus `String(zoomImg.sizes)` when it IS
      // forwarded (component currently passes `{ sizes: undefined }`,
      // which stringifies to `"undefined"` and clears the inherited
      // attribute). Optional chaining alone (`String(zoomImg?.sizes)`)
      // can't make this distinction — both code paths produce
      // `"undefined"`. The explicit `!== undefined` check is the
      // load-bearing gate.
      data-zoom-img-sizes={zoomImg !== undefined ? String(zoomImg.sizes) : 'ABSENT'}
    >
      {children}
    </span>
  ),
}));

const { ImageInlineZoomView } = await import('./ImageInlineZoomView');
const { setEditorDocName } = await import('./doc-context.ts');

function makeNode(
  attrs: { src?: string; alt?: string; title?: string },
  // The view resolves doc-relative `src` against the editor's docName
  // (parity with the block path's `media-render-props`). Tests that exercise
  // that resolution pass an `editor` stub registered via `setEditorDocName`;
  // tests that only care about the Zoom wrap / attr passthrough omit it.
  editor?: object,
) {
  // Minimal NodeViewProps shape — the view reads `node.attrs` + `editor`.
  // biome-ignore lint/suspicious/noExplicitAny: test stub
  return { node: { attrs }, editor } as any;
}

/** A throwaway object usable as a `getEditorDocName` WeakMap key. */
function makeEditorWithDocName(docName: string): object {
  const editor = {};
  // biome-ignore lint/suspicious/noExplicitAny: WeakMap key only — the view never calls editor methods
  setEditorDocName(editor as any, docName);
  return editor;
}

describe('ImageInlineZoomView — inline-image lightbox wrap', () => {
  afterEach(() => {
    // RTL leaves the previous test's render in the DOM by default;
    // per-test `document.querySelector('img')` would resolve to the prior
    // test's image. Bun's runner doesn't auto-cleanup.
    cleanup();
  });

  test('wraps the inline `<img>` in `<Zoom>` with descriptor-side parity args (wrapElement / zoomMargin / zoomImg.sizes)', () => {
    render(<ImageInlineZoomView {...makeNode({ src: '/a.png', alt: 'A', title: 't' })} />);
    const zoom = document.querySelector('[data-zoom-mock]');
    expect(zoom).not.toBeNull();
    expect(zoom?.getAttribute('data-wrap-element')).toBe('span');
    expect(zoom?.getAttribute('data-zoom-margin')).toBe('20');
    // Pin that `zoomImg={{ sizes: undefined }}` reached the Zoom call.
    // The mock's `'ABSENT'` sentinel (vs `String(zoomImg.sizes)`) means
    // a refactor that drops the `zoomImg` prop entirely would surface
    // `'ABSENT'` here — the lightbox would otherwise inherit the
    // thumbnail-scoped `sizes` and render at the wrong dimensions.
    expect(zoom?.getAttribute('data-zoom-img-sizes')).toBe('undefined');
  });

  test('outer NodeViewWrapper renders as `<span>` so inline images fit inside a `<p>` (HTML spec compliance)', () => {
    render(<ImageInlineZoomView {...makeNode({ src: '/a.png', alt: 'A' })} />);
    const wrapper = document.querySelector('[data-image-inline-zoom]');
    expect(wrapper).not.toBeNull();
    expect(wrapper?.tagName.toLowerCase()).toBe('span');
  });

  test('outer wrapper carries `data-clipboard-inline-leaf` so clipboard `findDescriptorRoot` skips it', () => {
    // Without this opt-out, the clipboard walker would match
    // `data-node-view-wrapper` and route serialization through the
    // descriptor-parent codepath — pre-PR clipboard behavior for inline
    // images relied on the direct `posAtDOM(<img>, 0)` path. Pin both
    // the attribute presence (the walker key) AND the value
    // ("image" — leaves room for future leaf kinds).
    render(<ImageInlineZoomView {...makeNode({ src: '/a.png', alt: 'A' })} />);
    const wrapper = document.querySelector('[data-image-inline-zoom]');
    expect(wrapper?.getAttribute('data-clipboard-inline-leaf')).toBe('image');
  });

  test('renders the inner `<img>` with src/alt/title passed through from PM attrs', () => {
    render(
      <ImageInlineZoomView
        {...makeNode({ src: '/assets/cat.png', alt: 'A cat', title: 'Hover' })}
      />,
    );
    const img = document.querySelector('img');
    expect(img).not.toBeNull();
    expect(img?.getAttribute('alt')).toBe('A cat');
    expect(img?.getAttribute('title')).toBe('Hover');
  });

  test('alt defaults to empty string when PM attrs has no alt — matches descriptor `Image.tsx` decorative-image contract', () => {
    render(<ImageInlineZoomView {...makeNode({ src: '/a.png' })} />);
    const img = document.querySelector('img');
    expect(img?.getAttribute('alt')).toBe('');
  });

  test('src passes through unchanged when `toDesktopAssetHref` is a no-op (server-absolute URL — non-desktop runtime)', () => {
    render(<ImageInlineZoomView {...makeNode({ src: '/assets/pic.png', alt: '' })} />);
    const img = document.querySelector('img');
    expect(img?.getAttribute('src')).toContain('/assets/pic.png');
  });

  // ── Doc-relative base resolution ──────────────────────────────
  // Inline `image` atoms resolve a doc-relative `src` against the document's
  // folder — the same resolution the block path applies via
  // `media-render-props`. Without it, the browser resolves the relative URL
  // against the hash-routed SPA root (`location.pathname === '/'`) and the
  // asset 404s. A node can hold a raw doc-relative `src` when it is authored /
  // edited client-side (WYSIWYG, paste) rather than server-baked at parse time.

  test('resolves a `./`-relative inline src against the document folder, not the SPA root', () => {
    const editor = makeEditorWithDocName('fishing-log/2026-05-16-wind-river-springer');
    render(
      <ImageInlineZoomView {...makeNode({ src: './assets/cat.jpg', alt: 'A cat' }, editor)} />,
    );
    const img = document.querySelector('img');
    expect(img?.getAttribute('src')).toBe('/fishing-log/assets/cat.jpg');
  });

  test('resolves a `../`-relative inline src against the document folder', () => {
    const editor = makeEditorWithDocName('fishing-log/2026/spring/log');
    render(<ImageInlineZoomView {...makeNode({ src: '../../assets/cat.jpg' }, editor)} />);
    const img = document.querySelector('img');
    expect(img?.getAttribute('src')).toBe('/fishing-log/assets/cat.jpg');
  });

  test('leaves a server-absolute src untouched even with a docName (idempotent)', () => {
    const editor = makeEditorWithDocName('fishing-log/2026-05-16-wind-river-springer');
    render(<ImageInlineZoomView {...makeNode({ src: '/fishing-log/assets/cat.jpg' }, editor)} />);
    const img = document.querySelector('img');
    expect(img?.getAttribute('src')).toBe('/fishing-log/assets/cat.jpg');
  });

  test('falls back to the raw src when no docName is registered (no base to resolve against)', () => {
    render(<ImageInlineZoomView {...makeNode({ src: './assets/cat.jpg' })} />);
    const img = document.querySelector('img');
    expect(img?.getAttribute('src')).toBe('./assets/cat.jpg');
  });
});

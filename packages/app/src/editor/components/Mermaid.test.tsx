/**
 * Mermaid — structural unit tests.
 *
 * Same testing-library-free convention as Math.test.tsx: `renderToString`
 * from `react-dom/server` is the substrate. Mermaid renders via `useEffect`
 * + an async lazy import + the visimer canvas view, so under
 * `renderToString` the component lands in its initial placeholder state
 * (the effect fires only on real mount). Live SVG output is exercised via
 * the Playwright visual-regression suite; canvas behavior (selection,
 * popovers, in-place edits) is owned by the `visimer` package's
 * own test suite.
 */

import { renderToString } from 'react-dom/server';
import { describe, expect, test, vi } from 'vitest';
import { renderLinguiTemplate } from '@/test-utils/lingui-mock';
import * as actualLinguiReactMacro from '../../../tests/lingui-macro-shim';

vi.doMock('@lingui/react/macro', () => ({
  ...actualLinguiReactMacro,
  Trans: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useLingui: () => ({ t: renderLinguiTemplate }),
}));

const { MermaidView, compensatedMaxScale } = await import('./Mermaid.tsx');

describe('MermaidView — placeholder branch', () => {
  test('empty chart renders the placeholder shell with real height', () => {
    const html = renderToString(<MermaidView chart="" />);
    expect(html).toContain('mermaid-placeholder');
    expect(html).toContain('data-component-type="mermaid"');
    // The empty state must hold height so the block is a real target and the
    // hover chrome isn't clipped (the zero-height sliver bug); it also carries
    // a visible hint instead of a blank space.
    expect(html).toContain('min-h-16');
    expect(html).toContain('Empty diagram');
  });

  test('whitespace-only chart treated as empty', () => {
    const html = renderToString(<MermaidView chart="   " />);
    expect(html).toContain('mermaid-placeholder');
  });

  test('undefined chart treated as empty', () => {
    const html = renderToString(<MermaidView />);
    expect(html).toContain('mermaid-placeholder');
  });
});

describe('MermaidView — pre-render mount state', () => {
  test('non-empty chart starts in the rendering state under renderToString', () => {
    // useEffect doesn't run under renderToString, so the component sits in
    // its initial state — `status: 'rendering'`. We're asserting this for
    // stability: SSR-style render must NOT crash on mermaid mount and must
    // produce visible markup.
    const html = renderToString(<MermaidView chart="graph TD; A-->B;" />);
    expect(html).toContain('data-component-type="mermaid"');
    expect(html).toContain('mermaid-rendering');
  });
});

describe('compensatedMaxScale', () => {
  test('returns the raw MERMAID_ZOOM_MAX floor when the diagram paints at or above natural size', () => {
    expect(compensatedMaxScale(500, 500)).toBe(4);
    expect(compensatedMaxScale(1000, 500)).toBe(4);
  });

  test('compensates a fit-shrunk diagram so it can still reach the intended natural-size multiple', () => {
    // A 2000-wide viewBox rendered at 500 CSS pixels sits at 0.25× on screen.
    // MERMAID_ZOOM_MAX (4) means "4× natural" — Panzoom must reach scale 16.
    expect(compensatedMaxScale(500, 2000)).toBe(16);
    // 0.5× fit → 2× the floor.
    expect(compensatedMaxScale(1000, 2000)).toBe(8);
  });

  test('falls back to the raw floor for degenerate inputs', () => {
    expect(compensatedMaxScale(0, 500)).toBe(4);
    expect(compensatedMaxScale(500, 0)).toBe(4);
    expect(compensatedMaxScale(-5, 500)).toBe(4);
  });
});

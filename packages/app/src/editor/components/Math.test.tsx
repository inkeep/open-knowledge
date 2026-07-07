/**
 * Math — structural unit tests.
 *
 * Repo convention: no @testing-library/react, no
 * happy-dom. `renderToString` from `react-dom/server` is the substrate; it
 * won't drive React's lazy-import resolution (Suspense renders the fallback
 * synchronously), so these tests assert the placeholder / fallback DOM
 * shape, not the eventual KaTeX HTML output. Live KaTeX rendering is
 * exercised via the Playwright visual-regression suite.
 */

import { describe, expect, test } from 'bun:test';
import { renderToString } from 'react-dom/server';
import { MathView } from './Math.tsx';

describe('MathView — placeholder branch', () => {
  test('empty formula renders the math-placeholder shell with a zero-width space', () => {
    const html = renderToString(<MathView formula="" />);
    expect(html).toContain('class="math math-placeholder"');
    expect(html).toContain('data-component-type="math"');
    // Empty formula falls back to U+0020 so the inline-block has measurable
    // height; a literal '' would collapse the wrapper to zero height and
    // hide the slash-menu-just-inserted descriptor from view.
    expect(html).toContain(' ');
  });

  test('undefined formula treated as empty (defaults via ?? "")', () => {
    // Slash-menu insertion lands the descriptor before the author types —
    // formula is `''` not `undefined`, but defensive coding handles both.
    const html = renderToString(<MathView />);
    expect(html).toContain('math-placeholder');
  });

  test('id prop reaches the placeholder DOM (deep-link anchor)', () => {
    const html = renderToString(<MathView formula="" id="eq-zero" />);
    expect(html).toContain('id="eq-zero"');
  });
});

describe('MathView — non-empty formula', () => {
  test('renders the Suspense fallback (placeholder) under renderToString', () => {
    // KaTeX is lazy-imported; renderToString does not drive the dynamic-
    // import resolution, so the Suspense fallback is what we observe here.
    // The fallback is the same MathPlaceholder shell, carrying the formula
    // source as visible text — guarantees the user sees their input even
    // if KaTeX fails to load (network issue, parse error in the lazy
    // module, etc.).
    const html = renderToString(<MathView formula="E = mc^2" />);
    expect(html).toContain('data-component-type="math"');
    expect(html).toContain('E = mc^2');
  });

  test('id prop carries through the Suspense fallback', () => {
    const html = renderToString(<MathView formula="x^2" id="square" />);
    expect(html).toContain('id="square"');
  });
});

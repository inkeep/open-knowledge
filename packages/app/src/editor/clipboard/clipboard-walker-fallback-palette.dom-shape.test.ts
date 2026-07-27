// @vitest-environment jsdom
/**
 * DOM-shape tests for the Activity-hidden fallback palette's block-math
 * dispatch. `paletteFor` builds real DOM (`document.createElement`), so this
 * file opts into the jsdom environment via the per-file docblock above. It
 * is NOT a Tier-3 React mount test (no component render, no
 * `@testing-library/react`), so it deliberately does not use the
 * `*.dom.test.tsx` suffix — that suffix routes the RTL mount substrate and
 * carries an RTL-import contract this file must not satisfy.
 *
 * Contract pinned here: block math authored as `$$…$$` (`DollarMath`) or
 * ` ```math ` (`MathFence`) is dispatched to the same source-fallback the
 * canonical `Math` produces — an Activity-hidden copy of dollar/fence math
 * must not silently drop the block.
 *
 * Tier responsibility: this tier proves `paletteFor`'s ROUTING and the
 * `<pre class="mdx-component"><code>` element shape. Byte-level pinning of
 * the `$$\nformula\n$$` source form lives in the no-DOM unit tier
 * (`non-portable-render-source-fallback.test.ts`); compat assertions here
 * are relative to the canonical `Math` output, not absolute byte literals.
 */

import type { Node as PmNode } from '@tiptap/pm/model';
import { describe, expect, test } from 'vitest';
import { paletteFor } from './clipboard-walker-fallback-palette.ts';

/**
 * Stub a top-level `jsxComponent` PM node matching `paletteFor`'s access
 * pattern (`type.name`, `attrs.componentName`, `attrs.props`). Deliberately
 * narrower than the sibling classifier tests' named-args `stubPmNode`
 * (non-portable-render-source-fallback.test.ts): this tier only ever stubs
 * `jsxComponent` nodes, so the type name is fixed and the args stay
 * positional.
 */
function stubPmNode(componentName: string, props: Record<string, unknown>): PmNode {
  return {
    type: { name: 'jsxComponent' },
    attrs: { componentName, props },
  } as unknown as PmNode;
}

/** Pure extractor — structural assertions live in each test body. */
function sourceText(el: Element): string | null {
  return el.querySelector('code')?.textContent ?? null;
}

describe('paletteFor — block-math authored forms', () => {
  test('canonical Math dispatches to the source-fallback pre/code (control)', () => {
    const el = paletteFor(stubPmNode('Math', { formula: 'E = mc^2' }));
    expect(el).not.toBeNull();
    expect(el?.tagName.toLowerCase()).toBe('pre');
    expect(el?.className).toBe('mdx-component');
    expect(sourceText(el as Element)).toBe('$$\nE = mc^2\n$$');
  });

  test('DollarMath ($$…$$ authored) dispatches like canonical Math', () => {
    const canonical = paletteFor(stubPmNode('Math', { formula: 'E = mc^2' }));
    const el = paletteFor(stubPmNode('DollarMath', { formula: 'E = mc^2' }));
    expect(el).not.toBeNull();
    expect(el?.tagName.toLowerCase()).toBe('pre');
    expect(el?.className).toBe('mdx-component');
    expect(sourceText(el as Element)).toBe(sourceText(canonical as Element));
  });

  test('MathFence (```math authored) dispatches like canonical Math', () => {
    const canonical = paletteFor(stubPmNode('Math', { formula: 'a^2 + b^2 = c^2' }));
    const el = paletteFor(stubPmNode('MathFence', { formula: 'a^2 + b^2 = c^2' }));
    expect(el).not.toBeNull();
    expect(el?.tagName.toLowerCase()).toBe('pre');
    expect(el?.className).toBe('mdx-component');
    expect(sourceText(el as Element)).toBe(sourceText(canonical as Element));
  });
});

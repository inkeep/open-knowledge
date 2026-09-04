// @vitest-environment jsdom

import type { Node as PmNode } from '@tiptap/pm/model';
import { describe, expect, test } from 'vitest';
import { paletteFor } from './clipboard-walker-fallback-palette.ts';

function stubPmNode(componentName: string, props: Record<string, unknown>): PmNode {
  return {
    type: { name: 'jsxComponent' },
    attrs: { componentName, props },
  } as unknown as PmNode;
}

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

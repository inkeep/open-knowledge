import { describe, expect, test } from 'bun:test';
import {
  File,
  FileText,
  Film,
  FolderOpen,
  Image,
  ImageIcon,
  type LucideIcon,
  Volume2,
  X,
} from 'lucide-react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { lucideIconToSvgString } from './lucide-svg.ts';

/**
 * Drift guard for the curated lucide-SVG map. The composer's `@`-mention node
 * view injects these icons as inline-SVG strings (it renders plain DOM, not
 * React), and `react-dom/server` is deliberately kept out of the production
 * bundle — so the geometry is hand-curated in `lucide-svg.ts`. This test renders
 * each lucide component with the TEST-ONLY `react-dom/server` and asserts the
 * curated output still carries that component's exact inner geometry, so a
 * lucide upgrade that redraws a glyph fails here instead of silently shipping a
 * stale icon.
 */

/** The inner body (children of `<svg>`) lucide renders for an icon, normalized to
 *  match the curated strings: self-closing tags (`</path>` → `/>`) and no XML ns
 *  attrs, so only the geometry is compared. */
function lucideInnerBody(Icon: LucideIcon): string {
  const markup = renderToStaticMarkup(createElement(Icon));
  const inner = markup.replace(/^<svg[^>]*>/, '').replace(/<\/svg>$/, '');
  // React serializes element children as `<path ...></path>`; the curated map
  // uses the self-closing `<path .../>` form. Collapse empty-child close tags.
  return inner.replace(/><\/(path|rect|circle|line|polyline|polygon)>/g, '/>');
}

const CURATED: ReadonlyArray<[string, LucideIcon]> = [
  ['FolderOpen', FolderOpen],
  ['FileText', FileText],
  ['Image', Image],
  ['ImageIcon', ImageIcon],
  ['File', File],
  ['Film', Film],
  ['Volume2', Volume2],
  ['X', X],
];

describe('lucideIconToSvgString', () => {
  test('wraps the icon in a size-3 (0.75rem) currentColor svg', () => {
    const svg = lucideIconToSvgString(FileText);
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain('width="0.75rem"');
    expect(svg).toContain('height="0.75rem"');
    expect(svg).toContain('viewBox="0 0 24 24"');
    expect(svg).toContain('stroke="currentColor"');
    expect(svg).toContain('stroke-width="2"');
    // No hardcoded color — the host's `color` drives the glyph via currentColor.
    expect(svg).not.toContain('#');
  });

  for (const [name, Icon] of CURATED) {
    test(`${name} geometry matches the lucide component (drift guard)`, () => {
      const body = lucideInnerBody(Icon);
      // Sanity: the lucide render produced real geometry (not an empty <svg/>).
      expect(body.length).toBeGreaterThan(0);
      expect(lucideIconToSvgString(Icon)).toContain(body);
    });
  }

  test('an unmapped icon falls back to the document (FileText) body', () => {
    const unmapped = (() => null) as unknown as LucideIcon;
    expect(lucideIconToSvgString(unmapped)).toBe(lucideIconToSvgString(FileText));
  });

  test('the result is cached (stable identity across calls)', () => {
    expect(lucideIconToSvgString(FolderOpen)).toBe(lucideIconToSvgString(FolderOpen));
  });
});

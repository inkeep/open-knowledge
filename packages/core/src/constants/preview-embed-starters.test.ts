/**
 * Guard the starter-snippet shape so the regression it fixed
 * doesn't slip back in. CSS `var()` in an SVG `fill=` / `stroke=`
 * presentation attribute is not valid per the W3C SVG spec — Chromium
 * 113+ tolerates it as a non-standard extension, but Safari and older
 * Chromium silently fall back to the spec default (`fill: black`,
 * `stroke: none`), so the rings render as opaque black blobs in those
 * browsers AND in any future renderer that follows the spec strictly.
 *
 * The starter is also the canonical example agents extrapolate from
 * (palette MCP `embedPatterns` + slash-menu starter family). Shipping
 * an invalid pattern there teaches every downstream agent to repeat it,
 * which is the failure mode this guard prevents.
 *
 * The rule under test: any `var(...)` reference inside an `<svg>` tree
 * lives inside a `style="..."` attribute, never as the value of a
 * presentation attribute like `fill=` / `stroke=` / `color=`.
 */

import { describe, expect, test } from 'bun:test';
import { PREVIEW_EMBED_STARTERS } from './preview-embed-starters';

/**
 * Match the OPENING `<svg ...>` through the CLOSING `</svg>` so the
 * presentation-attribute check only sees SVG-tree markup. Pure-HTML
 * elements outside the SVG are free to use `color: var(--...)` etc.
 * via their `style=` attributes (CSS context, not SVG presentation).
 */
const SVG_BLOCK_RE = /<svg\b[\s\S]*?<\/svg>/g;

/**
 * Presentation-attribute / `<paint>` accepting attributes the SVG spec
 * defines. Each one with a `var(...)` value is invalid; the snippet
 * must route through `style="<attr>: var(...)"` instead. Sourced from
 * the SVG 1.1 + SVG 2 spec lists of paint-server-accepting attributes.
 */
const PAINT_ATTRS = ['fill', 'stroke', 'color', 'stop-color', 'flood-color', 'lighting-color'];
const PAINT_ATTR_RE = new RegExp(`\\b(${PAINT_ATTRS.join('|')})\\s*=\\s*"[^"]*var\\(`, 'i');

describe('PREVIEW_EMBED_STARTERS — SVG paint-attribute hygiene (PRD-6760)', () => {
  for (const starter of PREVIEW_EMBED_STARTERS) {
    test(`${starter.id} — no var() in SVG paint-accepting presentation attributes`, () => {
      const svgBlocks = starter.html.match(SVG_BLOCK_RE) ?? [];
      for (const svg of svgBlocks) {
        const match = svg.match(PAINT_ATTR_RE);
        // When this fails the captured attribute (e.g. `fill`) and the
        // matched substring (e.g. `fill="var(--chart-1)"`) appear in the
        // failure message — gives the next author the fix locus + the
        // canonical form (route through `style="..."`).
        expect(
          match,
          match
            ? `${starter.id}: ${match[0]} — route through style="${match[1]}: var(...)" instead`
            : undefined,
        ).toBeNull();
      }
    });
  }

  test('custom-svg starter still references the chart palette (visual smoke)', () => {
    // Round-trip: the snippet must still actually USE the theme tokens
    // somewhere — otherwise a refactor that strips the `var()` calls
    // entirely (e.g. hard-coded colors) would pass the paint-attribute
    // check above without preserving the themed-rendering intent.
    const customSvg = PREVIEW_EMBED_STARTERS.find((s) => s.id === 'custom-svg');
    expect(customSvg).toBeDefined();
    expect(customSvg?.html).toContain('var(--chart-1)');
    expect(customSvg?.html).toContain('var(--border)');
    expect(customSvg?.html).toContain('var(--foreground)');
  });
});


import { describe, expect, test } from 'bun:test';
import { PREVIEW_EMBED_STARTERS } from './preview-embed-starters';

const SVG_BLOCK_RE = /<svg\b[\s\S]*?<\/svg>/g;

const PAINT_ATTRS = ['fill', 'stroke', 'color', 'stop-color', 'flood-color', 'lighting-color'];
const PAINT_ATTR_RE = new RegExp(`\\b(${PAINT_ATTRS.join('|')})\\s*=\\s*"[^"]*var\\(`, 'i');

describe('PREVIEW_EMBED_STARTERS — SVG paint-attribute hygiene (PRD-6760)', () => {
  for (const starter of PREVIEW_EMBED_STARTERS) {
    test(`${starter.id} — no var() in SVG paint-accepting presentation attributes`, () => {
      const svgBlocks = starter.html.match(SVG_BLOCK_RE) ?? [];
      for (const svg of svgBlocks) {
        const match = svg.match(PAINT_ATTR_RE);
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
    const customSvg = PREVIEW_EMBED_STARTERS.find((s) => s.id === 'custom-svg');
    expect(customSvg).toBeDefined();
    expect(customSvg?.html).toContain('var(--chart-1)');
    expect(customSvg?.html).toContain('var(--border)');
    expect(customSvg?.html).toContain('var(--foreground)');
  });
});

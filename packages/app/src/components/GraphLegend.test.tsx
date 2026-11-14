import type { ReactElement, ReactNode } from 'react';
import { describe, expect, test } from 'vitest';

const PALETTE = ['#101010', '#202020', '#303030'];

type ElementWithChildren = ReactElement<{ children?: ReactNode; className?: string }>;

function childrenArray(node: ReactNode): ReactNode[] {
  return Array.isArray(node) ? node : [node];
}

function textContent(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') {
    return String(node);
  }
  if (!node || typeof node !== 'object') {
    return '';
  }
  const element = node as ElementWithChildren;
  return childrenArray(element.props.children).map(textContent).join('');
}

describe('GraphLegend', () => {
  test('returns null when there are no clusters', async () => {
    const { GraphLegend } = await import('./GraphLegend');
    expect(GraphLegend({ clusters: [], clusterPalette: PALETTE, variant: 'docked' })).toBeNull();
  });

  test('uses a smaller docked layout and truncates visible entries earlier', async () => {
    const { GraphLegend } = await import('./GraphLegend');
    const legend = GraphLegend({
      clusters: ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon', 'Zeta', 'Eta'],
      clusterPalette: PALETTE,
      variant: 'docked',
    }) as ElementWithChildren;

    expect(legend.props.className).toContain('bottom-2');
    expect(legend.props.className).toContain('text-[11px]');

    const children = childrenArray(legend.props.children);
    expect(textContent(children[0])).toBe('Clusters');
    expect(textContent(children.at(-1) ?? null)).toBe('+ 1 more');
  });

  test('keeps the fullscreen layout roomier and shows more entries before overflow', async () => {
    const { GraphLegend } = await import('./GraphLegend');
    const legend = GraphLegend({
      clusters: ['1', '2', '3', '4', '5', '6', '7'],
      clusterPalette: PALETTE,
      variant: 'fullscreen',
    }) as ElementWithChildren;

    expect(legend.props.className).toContain('bottom-3');
    expect(legend.props.className).toContain('text-xs');

    const children = childrenArray(legend.props.children);
    expect(textContent(children.at(-1) ?? null)).not.toContain('more');
  });

  test('colors each cluster swatch with the color the canvas gives that cluster', async () => {
    const { GraphLegend } = await import('./GraphLegend');
    const { clusterColor } = await import('./graph-colors');
    const clusters = ['Alpha', 'Beta', 'Gamma'];
    const legend = GraphLegend({
      clusters,
      clusterPalette: PALETTE,
      variant: 'fullscreen',
    }) as ElementWithChildren;

    const rows = childrenArray(childrenArray(legend.props.children)[1]) as ElementWithChildren[];
    expect(rows.map((row) => textContent(childrenArray(row.props.children)[1]))).toEqual(clusters);
    for (const row of rows) {
      const [swatch, label] = childrenArray(row.props.children) as [
        ReactElement<{ style: { backgroundColor: string } }>,
        ReactNode,
      ];
      expect(swatch.props.style.backgroundColor).toBe(clusterColor(textContent(label), PALETTE));
    }
  });
});

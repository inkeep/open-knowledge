import * as actualNextThemes from 'next-themes';
import type { ReactElement, ReactNode } from 'react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const useThemeMock = vi.fn(() => ({ resolvedTheme: 'light' as const }));

vi.doMock('next-themes', () => ({
  ...actualNextThemes,
  useTheme: useThemeMock,
}));

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
  beforeEach(() => {
    useThemeMock.mockReset();
    useThemeMock.mockReturnValue({ resolvedTheme: 'light' });
  });

  test('returns null when there are no clusters', async () => {
    const { GraphLegend } = await import('./GraphLegend');
    expect(GraphLegend({ clusters: [], variant: 'docked' })).toBeNull();
  });

  test('uses a smaller docked layout and truncates visible entries earlier', async () => {
    const { GraphLegend } = await import('./GraphLegend');
    const legend = GraphLegend({
      clusters: ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon', 'Zeta', 'Eta'],
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
      variant: 'fullscreen',
    }) as ElementWithChildren;

    expect(legend.props.className).toContain('bottom-3');
    expect(legend.props.className).toContain('text-xs');

    const children = childrenArray(legend.props.children);
    expect(textContent(children.at(-1) ?? null)).not.toContain('more');
  });
});

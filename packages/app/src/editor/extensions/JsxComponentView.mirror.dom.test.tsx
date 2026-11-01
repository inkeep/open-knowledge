import { cleanup, render, screen } from '@testing-library/react';
import type { NodeViewProps } from '@tiptap/react';
import { afterEach, describe, expect, test, vi } from 'vitest';

vi.doMock('@/lib/use-collab-url', () => ({
  useCollabUrl: () => ({ collabUrl: null }),
}));

afterEach(() => {
  cleanup();
});

function mirrorNodeProps(authored: Record<string, string | number>): NodeViewProps {
  return {
    editor: {
      isEditable: true,
      isDestroyed: false,
      commands: { setNodeSelection: () => {} },
      state: { doc: { resolve: () => ({ depth: 0 }) }, selection: { from: 0, to: 0 } },
      on: () => {},
      off: () => {},
    },
    node: {
      type: { name: 'jsxComponent' },
      attrs: {
        componentName: 'Mirror',
        kind: 'element',
        attributes: Object.entries(authored).map(([name, value]) => ({
          type: 'mdxJsxAttribute',
          name,
          value:
            typeof value === 'number'
              ? { type: 'mdxJsxAttributeValueExpression', value: String(value) }
              : value,
        })),
        props: { ...authored },
        sourceRaw: '',
        sourceDirty: false,
      },
      content: { size: 0 },
      nodeSize: 1,
    },
    getPos: () => 5,
    selected: false,
    updateAttributes: () => {},
    deleteNode: () => {},
    decorations: [],
    extension: { options: {} },
    view: {},
  } as unknown as NodeViewProps;
}

async function mountMirror(authored: Record<string, string | number>) {
  const { JsxComponentView } = await import('./JsxComponentView.tsx');
  return render(<JsxComponentView {...mirrorNodeProps(authored)} />);
}

describe('a Mirror block in the editor', () => {
  test.each([
    ['name', { src: 'pricing', name: 'plans' }],
    ['the older anchor spelling', { src: 'pricing', anchor: 'plans' }],
  ])('written with %s, points at its source block', async (_spelling, authored) => {
    const { container } = await mountMirror(authored);

    expect(
      screen.getByRole('link', { name: 'Open source doc: pricing' }).getAttribute('href'),
    ).toBe('#/pricing#source:plans');
    expect(container.textContent).toContain('pricing#plans');
    const wrapper = container.querySelector('[data-jsx-component]');
    expect(wrapper).not.toBeNull();
    expect(wrapper?.hasAttribute('data-needs-config')).toBe(false);
  });

  test('written with a numeric name, links to the source with that name as text', async () => {
    await mountMirror({ src: 'pricing', name: 7 });

    expect(
      screen.getByRole('link', { name: 'Open source doc: pricing' }).getAttribute('href'),
    ).toBe('#/pricing#source:7');
  });

  test('written with a numeric src, links to the document with that src as text', async () => {
    await mountMirror({ src: 42, name: 'plans' });

    expect(screen.getByRole('link', { name: 'Open source doc: 42' }).getAttribute('href')).toBe(
      '#/42#source:plans',
    );
  });

  test('without a name, asks to be set up', async () => {
    const { container } = await mountMirror({ src: 'pricing' });

    expect(container.querySelector('[data-jsx-component]')?.getAttribute('data-needs-config')).toBe(
      'true',
    );
  });
});

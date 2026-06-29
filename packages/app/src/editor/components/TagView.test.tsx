import { describe, expect, test } from 'bun:test';
import type { NodeViewProps } from '@tiptap/core';
import { renderToString } from 'react-dom/server';
import { TagView } from './TagView.tsx';

function makeProps(value: string): NodeViewProps {
  const node = {
    attrs: { value },
    type: { name: 'tag' },
  } as unknown as NodeViewProps['node'];
  return {
    node,
    selected: false,
    getPos: () => 0,
    editor: {} as NodeViewProps['editor'],
    decorations: [],
    extension: {} as NodeViewProps['extension'],
    HTMLAttributes: {},
    innerDecorations: [],
    updateAttributes: () => {},
    deleteNode: () => {},
    view: {} as NodeViewProps['view'],
  } as unknown as NodeViewProps;
}

describe('TagView — filled chip', () => {
  test('renders `<a class="tag" data-tag="…" href="#tag/…">#value</a>`', () => {
    const html = renderToString(<TagView {...makeProps('typescript')} />);
    expect(html).toContain('class="tag"');
    expect(html).toContain('data-tag="typescript"');
    expect(html).toContain('href="#tag/typescript"');
    expect(html).toContain('typescript</a>');
  });

  test('hierarchy value preserves the slash in data-tag and href', () => {
    const html = renderToString(<TagView {...makeProps('proj/team/2026')} />);
    expect(html).toContain('data-tag="proj/team/2026"');
    expect(html).toContain('href="#tag/proj/team/2026"');
    expect(html).toContain('proj/team/2026</a>');
  });

  test('filled chip does NOT render an input element', () => {
    const html = renderToString(<TagView {...makeProps('typescript')} />);
    expect(html).not.toContain('<input');
  });
});

describe('TagView — empty placeholder', () => {
  test('empty value renders the placeholder pill with `tag-placeholder` class', () => {
    const html = renderToString(<TagView {...makeProps('')} />);
    expect(html).toContain('tag-placeholder');
  });

  test('placeholder embeds an `<input>` (inline-edit, no separate popover)', () => {
    const html = renderToString(<TagView {...makeProps('')} />);
    expect(html).toContain('<input');
    expect(html).toContain('aria-label="Tag value"');
  });

  test('placeholder does NOT carry `data-tag` (so `tag-click-plugin` skips it)', () => {
    const html = renderToString(<TagView {...makeProps('')} />);
    expect(html).not.toContain('data-tag=');
  });
});

describe('TagView — wrapper invariant', () => {
  test('NodeViewWrapper renders as a span (inline-flow safe)', () => {
    const html = renderToString(<TagView {...makeProps('foo')} />);
    expect(html.startsWith('<span')).toBe(true);
  });
});

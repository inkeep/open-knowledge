
import { describe, expect, test } from 'bun:test';
import { findMirrorSource, renderMirrorSubtree } from './use-mirror-source.ts';

function mirrorSourceNode(id: string, children: Array<Record<string, unknown>> = []) {
  return {
    type: 'mdxJsxFlowElement' as const,
    name: 'MirrorSource',
    attributes: [{ type: 'mdxJsxAttribute', name: 'id', value: id }],
    children,
  };
}

function root(children: Array<Record<string, unknown>>) {
  return { type: 'root' as const, children };
}

describe('findMirrorSource', () => {
  test('returns null when no MirrorSource present', () => {
    expect(
      findMirrorSource(
        root([{ type: 'paragraph', children: [{ type: 'text', value: 'hi' }] }]),
        'x',
      ),
    ).toBeNull();
  });

  test('returns null when name matches but id does not', () => {
    expect(findMirrorSource(root([mirrorSourceNode('a')]), 'b')).toBeNull();
  });

  test('matches by exact id', () => {
    const node = mirrorSourceNode('banner', [{ type: 'paragraph' }]);
    expect(findMirrorSource(root([node]), 'banner')).toBe(node);
  });

  test('first match wins when an id appears twice in the same doc', () => {
    const first = mirrorSourceNode('dup', [{ type: 'text', value: 'first' }]);
    const second = mirrorSourceNode('dup', [{ type: 'text', value: 'second' }]);
    expect(findMirrorSource(root([first, second]), 'dup')).toBe(first);
  });

  test('descends into nested children — MirrorSource inside a Callout still resolves', () => {
    const target = mirrorSourceNode('nested', [{ type: 'paragraph' }]);
    const tree = root([
      {
        type: 'mdxJsxFlowElement',
        name: 'Callout',
        attributes: [],
        children: [target],
      },
    ]);
    expect(findMirrorSource(tree, 'nested')).toBe(target);
  });

  test('ignores non-MirrorSource JSX flow elements named MirrorSource at a deeper level only by id check', () => {
    const stray = {
      type: 'mdxJsxFlowElement',
      name: 'MirrorSource',
      attributes: [], // no id
      children: [],
    };
    expect(findMirrorSource(root([stray]), 'x')).toBeNull();
  });

  test('id with empty-string value still matches an empty anchor query (precise equality)', () => {
    const node = mirrorSourceNode('', [{ type: 'paragraph' }]);
    expect(findMirrorSource(root([node]), '')).toBe(node);
  });
});

describe('renderMirrorSubtree', () => {
  test('renders a single paragraph child as HTML', () => {
    const html = renderMirrorSubtree(
      mirrorSourceNode('x', [
        {
          type: 'paragraph',
          children: [{ type: 'text', value: 'hello world' }],
        },
      ]),
    );
    expect(html).toContain('<p>');
    expect(html).toContain('hello world');
    expect(html).toContain('</p>');
  });

  test('preserves inline emphasis via the shared hast pipeline', () => {
    const html = renderMirrorSubtree(
      mirrorSourceNode('x', [
        {
          type: 'paragraph',
          children: [{ type: 'strong', children: [{ type: 'text', value: 'bold' }] }],
        },
      ]),
    );
    expect(html).toContain('<strong>');
    expect(html).toContain('bold');
    expect(html).toContain('</strong>');
  });

  test('returns an empty-root render (no <p>) when children is empty', () => {
    const html = renderMirrorSubtree(mirrorSourceNode('x', []));
    expect(html).not.toContain('<p>');
  });

  test('renders nested headings + list children — multi-block subtree', () => {
    const html = renderMirrorSubtree(
      mirrorSourceNode('x', [
        {
          type: 'heading',
          depth: 2,
          children: [{ type: 'text', value: 'Release 0.7.0' }],
        },
        {
          type: 'list',
          ordered: false,
          children: [
            {
              type: 'listItem',
              children: [{ type: 'paragraph', children: [{ type: 'text', value: 'item one' }] }],
            },
          ],
        },
      ]),
    );
    expect(html).toContain('<h2>');
    expect(html).toContain('Release 0.7.0');
    expect(html).toContain('<ul>');
    expect(html).toContain('item one');
  });
});

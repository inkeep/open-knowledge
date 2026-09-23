import { describe, expect, test } from 'vitest';
import { remarkUntrustedContent } from './remark-untrusted-content';

interface MdastNode {
  type: string;
  value?: string;
  url?: string;
  alt?: string | null;
  children?: MdastNode[];
}

function run(children: MdastNode[]): MdastNode[] {
  const tree: MdastNode = { type: 'root', children };
  remarkUntrustedContent()()(tree);
  return tree.children ?? [];
}

describe('remarkUntrustedContent', () => {
  test('raw HTML becomes literal text, inline and block alike', () => {
    const out = run([
      { type: 'html', value: '<script>alert(1)</script>' },
      {
        type: 'paragraph',
        children: [
          { type: 'text', value: 'see ' },
          { type: 'html', value: '<b>' },
          { type: 'text', value: 'bold' },
          { type: 'html', value: '</b>' },
        ],
      },
    ]);
    expect(out[0]).toEqual({ type: 'text', value: '<script>alert(1)</script>' });
    expect(out[1]?.children?.map((c) => c.type)).toEqual(['text', 'text', 'text', 'text']);
    expect(out[1]?.children?.[1]).toEqual({ type: 'text', value: '<b>' });
  });

  test('an image is reduced to its alt text, or its url when there is none', () => {
    const out = run([
      {
        type: 'paragraph',
        children: [
          { type: 'image', url: 'https://example.com/x.png', alt: 'a chart' },
          { type: 'image', url: 'https://example.com/y.png', alt: '' },
          { type: 'image', url: '', alt: null },
        ],
      },
    ]);
    expect(out[0]?.children).toEqual([
      { type: 'text', value: 'a chart' },
      { type: 'text', value: 'https://example.com/y.png' },
    ]);
  });

  test('everything else is left in place, including code that mentions tags', () => {
    const code = { type: 'code', value: '<div>kept as code</div>' };
    const out = run([
      code,
      { type: 'paragraph', children: [{ type: 'inlineCode', value: '<b>' }] },
    ]);
    expect(out[0]).toBe(code);
    expect(out[1]?.children?.[0]).toEqual({ type: 'inlineCode', value: '<b>' });
  });
});

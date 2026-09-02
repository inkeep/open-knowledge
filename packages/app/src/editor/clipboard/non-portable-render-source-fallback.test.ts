import { MarkdownManager, sharedExtensions } from '@inkeep/open-knowledge-core';
import type { Node as PmNode } from '@tiptap/pm/model';
import { describe, expect, test } from 'vitest';
import { nonPortableDescriptorNames } from './non-portable-descriptors.test-helper.ts';
import { sourceFallbackFormFor } from './non-portable-render-source-fallback.ts';

function stubPmNode(args: {
  typeName: string;
  componentName?: string;
  props?: Record<string, unknown>;
  language?: unknown;
  meta?: unknown;
  textContent?: string;
}): PmNode {
  return {
    type: { name: args.typeName },
    attrs: {
      ...(args.componentName !== undefined ? { componentName: args.componentName } : {}),
      ...(args.props !== undefined ? { props: args.props } : {}),
      ...(args.language !== undefined ? { language: args.language } : {}),
      ...(args.meta !== undefined ? { meta: args.meta } : {}),
    },
    textContent: args.textContent ?? '',
  } as unknown as PmNode;
}

describe('sourceFallbackFormFor — Math jsxComponent', () => {
  test('emits `$$\\nformula\\n$$` source', () => {
    const node = stubPmNode({
      typeName: 'jsxComponent',
      componentName: 'Math',
      props: { formula: 'E = mc^2' },
    });
    expect(sourceFallbackFormFor(node)).toEqual({ source: '$$\nE = mc^2\n$$' });
  });

  test('newlines are load-bearing — pin block-vs-inline distinction', () => {
    const node = stubPmNode({
      typeName: 'jsxComponent',
      componentName: 'Math',
      props: { formula: 'x' },
    });
    expect(sourceFallbackFormFor(node)).toEqual({ source: '$$\nx\n$$' });
  });

  test('missing formula prop falls back to empty string', () => {
    const node = stubPmNode({
      typeName: 'jsxComponent',
      componentName: 'Math',
      props: {},
    });
    expect(sourceFallbackFormFor(node)).toEqual({ source: '$$\n\n$$' });
  });

  test('non-string formula prop falls back to empty string', () => {
    const node = stubPmNode({
      typeName: 'jsxComponent',
      componentName: 'Math',
      props: { formula: 42 },
    });
    expect(sourceFallbackFormFor(node)).toEqual({ source: '$$\n\n$$' });
  });
});

describe('sourceFallbackFormFor — MermaidFence jsxComponent', () => {
  test('emits fenced-code form with `mermaid` info string', () => {
    const node = stubPmNode({
      typeName: 'jsxComponent',
      componentName: 'MermaidFence',
      props: { chart: 'graph TD\n  A --> B' },
    });
    expect(sourceFallbackFormFor(node)).toEqual({
      source: '```mermaid\ngraph TD\n  A --> B\n```',
    });
  });

  test('multi-line chart preserves newlines', () => {
    const chart = 'sequenceDiagram\n  Alice->>Bob: Hello\n  Bob-->>Alice: Hi';
    const node = stubPmNode({
      typeName: 'jsxComponent',
      componentName: 'MermaidFence',
      props: { chart },
    });
    expect(sourceFallbackFormFor(node)).toEqual({
      source: `\`\`\`mermaid\n${chart}\n\`\`\``,
    });
  });

  test('missing chart prop falls back to empty string', () => {
    const node = stubPmNode({
      typeName: 'jsxComponent',
      componentName: 'MermaidFence',
      props: {},
    });
    expect(sourceFallbackFormFor(node)).toEqual({ source: '```mermaid\n\n```' });
  });

  test('non-string chart prop falls back to empty string', () => {
    const node = stubPmNode({
      typeName: 'jsxComponent',
      componentName: 'MermaidFence',
      props: { chart: { type: 'flowchart' } },
    });
    expect(sourceFallbackFormFor(node)).toEqual({ source: '```mermaid\n\n```' });
  });
});

describe('sourceFallbackFormFor — block-math compat authored forms (DollarMath / MathFence)', () => {
  test('DollarMath emits the same `$$\\nformula\\n$$` source as canonical Math', () => {
    const dollar = stubPmNode({
      typeName: 'jsxComponent',
      componentName: 'DollarMath',
      props: { formula: 'E = mc^2' },
    });
    const canonical = stubPmNode({
      typeName: 'jsxComponent',
      componentName: 'Math',
      props: { formula: 'E = mc^2' },
    });
    expect(sourceFallbackFormFor(dollar)).toEqual({ source: '$$\nE = mc^2\n$$' });
    expect(sourceFallbackFormFor(dollar)).toEqual(sourceFallbackFormFor(canonical));
  });

  test('MathFence emits the same `$$\\nformula\\n$$` source as canonical Math', () => {
    const fence = stubPmNode({
      typeName: 'jsxComponent',
      componentName: 'MathFence',
      props: { formula: 'a^2 + b^2 = c^2' },
    });
    const canonical = stubPmNode({
      typeName: 'jsxComponent',
      componentName: 'Math',
      props: { formula: 'a^2 + b^2 = c^2' },
    });
    expect(sourceFallbackFormFor(fence)).toEqual({ source: '$$\na^2 + b^2 = c^2\n$$' });
    expect(sourceFallbackFormFor(fence)).toEqual(sourceFallbackFormFor(canonical));
  });

  test('block-math compat forms preserve the block-vs-inline newlines', () => {
    for (const componentName of ['DollarMath', 'MathFence']) {
      const node = stubPmNode({
        typeName: 'jsxComponent',
        componentName,
        props: { formula: 'x' },
      });
      expect(sourceFallbackFormFor(node), componentName).toEqual({ source: '$$\nx\n$$' });
    }
  });

  test('missing formula prop on compat forms falls back to empty string', () => {
    for (const componentName of ['DollarMath', 'MathFence']) {
      const node = stubPmNode({ typeName: 'jsxComponent', componentName, props: {} });
      expect(sourceFallbackFormFor(node), componentName).toEqual({ source: '$$\n\n$$' });
    }
  });
});

describe('sourceFallbackFormFor — registry-derived non-portable coverage', () => {
  test('every descriptor that renders as a non-portable canonical yields a source form', () => {
    const descriptorNames = nonPortableDescriptorNames();

    expect(descriptorNames).toEqual(
      expect.arrayContaining(['Math', 'MermaidFence', 'DollarMath', 'MathFence']),
    );

    for (const componentName of descriptorNames) {
      const node = stubPmNode({ typeName: 'jsxComponent', componentName, props: {} });
      expect(sourceFallbackFormFor(node), componentName).not.toBeNull();
    }
  });
});

describe('sourceFallbackFormFor — preview-active codeBlock', () => {
  test('html + preview → fenced source with the authored info-string', () => {
    const node = stubPmNode({
      typeName: 'codeBlock',
      language: 'html',
      meta: 'preview',
      textContent: '<h1>Hi</h1>',
    });
    expect(sourceFallbackFormFor(node)).toEqual({
      source: '```html preview\n<h1>Hi</h1>\n```',
    });
  });

  test('xml + preview → recognized via the normalize path', () => {
    const node = stubPmNode({
      typeName: 'codeBlock',
      language: 'xml',
      meta: 'preview',
      textContent: '<svg></svg>',
    });
    expect(sourceFallbackFormFor(node)).toEqual({
      source: '```xml preview\n<svg></svg>\n```',
    });
  });

  test('fence widens past a backtick run in the body (no early close)', () => {
    const body = 'before\n```\ninner\n```\nafter';
    const node = stubPmNode({
      typeName: 'codeBlock',
      language: 'html',
      meta: 'preview',
      textContent: body,
    });
    expect(sourceFallbackFormFor(node)).toEqual({
      source: `\`\`\`\`html preview\n${body}\n\`\`\`\``,
    });
  });

  test('tilde fence widens past a ~~~ run in the body (no early close)', () => {
    const body = 'before\n~~~\ninner\n~~~\nafter';
    const node = stubPmNode({
      typeName: 'codeBlock',
      language: 'html',
      meta: 'title="a`b`" preview',
      textContent: body,
    });
    const source = sourceFallbackFormFor(node)?.source ?? '';
    expect(source.startsWith('~~~~')).toBe(true);
    expect(source.endsWith('\n~~~~')).toBe(true);
  });

  test('non-preview html code block → null (portable clean-clone path)', () => {
    const node = stubPmNode({
      typeName: 'codeBlock',
      language: 'html',
      textContent: '<h1>Hi</h1>',
    });
    expect(sourceFallbackFormFor(node)).toBeNull();
  });

  test('preview meta on a non-previewable language → null', () => {
    const node = stubPmNode({
      typeName: 'codeBlock',
      language: 'js',
      meta: 'preview',
      textContent: "console.log('x')",
    });
    expect(sourceFallbackFormFor(node)).toBeNull();
  });

  test('null language attr → null (no preview gate, no throw)', () => {
    const node = stubPmNode({
      typeName: 'codeBlock',
      language: null,
      meta: 'preview',
      textContent: '<h1>Hi</h1>',
    });
    expect(sourceFallbackFormFor(node)).toBeNull();
  });

  test('null meta attr → null (no preview gate, no throw)', () => {
    const node = stubPmNode({
      typeName: 'codeBlock',
      language: 'html',
      meta: null,
      textContent: '<h1>Hi</h1>',
    });
    expect(sourceFallbackFormFor(node)).toBeNull();
  });

  test('meta carrying a backtick emits a valid fence (tilde), not a broken backtick fence', () => {
    const node = stubPmNode({
      typeName: 'codeBlock',
      language: 'html',
      meta: 'title="a`b`" preview',
      textContent: '<h1>Hi</h1>',
    });
    const form = sourceFallbackFormFor(node);
    expect(form).not.toBeNull();
    const source = form?.source ?? '';
    expect(source).not.toBe('');
    const fenceChar = source[0];
    const infoLine = source.slice(0, source.indexOf('\n'));
    expect(infoLine.slice(3)).not.toContain(fenceChar);
  });
});

describe('sourceFallbackFormFor — emitted fence round-trips through OK`s parser', () => {
  const md = new MarkdownManager({ extensions: sharedExtensions });
  const topNodeType = (source: string): string | undefined => {
    const doc = md.parse(source) as { content?: Array<{ type?: string }> };
    return doc.content?.[0]?.type;
  };

  test('plain preview meta round-trips to a codeBlock', () => {
    const node = stubPmNode({
      typeName: 'codeBlock',
      language: 'html',
      meta: 'preview',
      textContent: '<h1>Hi</h1>',
    });
    const source = sourceFallbackFormFor(node)?.source ?? '';
    expect(topNodeType(source)).toBe('codeBlock');
  });

  test('backtick-in-meta still round-trips to a codeBlock (not a paragraph)', () => {
    const node = stubPmNode({
      typeName: 'codeBlock',
      language: 'html',
      meta: 'title="a`b`" preview',
      textContent: '<h1>Hi</h1>',
    });
    const source = sourceFallbackFormFor(node)?.source ?? '';
    expect(topNodeType(source)).toBe('codeBlock');
  });
});

describe('sourceFallbackFormFor — fall-through cases', () => {
  test('mathInline atom → null (handled by post-clone pass instead)', () => {
    const node = stubPmNode({ typeName: 'mathInline' });
    expect(sourceFallbackFormFor(node)).toBeNull();
  });

  test('Callout jsxComponent → null (palette path handles it separately)', () => {
    const node = stubPmNode({
      typeName: 'jsxComponent',
      componentName: 'Callout',
      props: { type: 'note' },
    });
    expect(sourceFallbackFormFor(node)).toBeNull();
  });

  test('img/video/audio jsxComponents → null (URL classifier handles)', () => {
    for (const componentName of ['img', 'video', 'audio']) {
      const node = stubPmNode({ typeName: 'jsxComponent', componentName });
      expect(sourceFallbackFormFor(node)).toBeNull();
    }
  });

  test('Accordion / GFMCallout / HtmlDetailsAccordion compat → null', () => {
    for (const componentName of ['Accordion', 'GFMCallout', 'HtmlDetailsAccordion']) {
      const node = stubPmNode({ typeName: 'jsxComponent', componentName });
      expect(sourceFallbackFormFor(node)).toBeNull();
    }
  });

  test('paragraph / text / heading / codeBlock → null', () => {
    for (const typeName of ['paragraph', 'text', 'heading', 'codeBlock']) {
      const node = stubPmNode({ typeName });
      expect(sourceFallbackFormFor(node)).toBeNull();
    }
  });

  test('unknown jsxComponent name → null', () => {
    const node = stubPmNode({
      typeName: 'jsxComponent',
      componentName: 'CustomFutureComponent',
      props: {},
    });
    expect(sourceFallbackFormFor(node)).toBeNull();
  });
});

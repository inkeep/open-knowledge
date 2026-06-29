import { describe, expect, test } from 'bun:test';
import type { Node as PmNode } from '@tiptap/pm/model';
import { sourceFallbackFormFor } from './non-portable-render-source-fallback.ts';

function stubPmNode(args: {
  typeName: string;
  componentName?: string;
  props?: Record<string, unknown>;
}): PmNode {
  return {
    type: { name: args.typeName },
    attrs: {
      ...(args.componentName !== undefined ? { componentName: args.componentName } : {}),
      ...(args.props !== undefined ? { props: args.props } : {}),
    },
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

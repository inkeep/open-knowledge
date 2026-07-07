/**
 * Co-located unit tests for the non-portable-render source-fallback
 * helper. Mirrors the convention from `clipboard-walker-fallback-
 * palette.test.ts`: bun-test has no DOM, so the DOM-shape behaviour of
 * `nonPortableRenderSourceFallback` is covered by Playwright E2E. This
 * file pins the **structural** dispatch contract that is testable
 * without a DOM via `sourceFallbackFormFor` (the inner pure classifier).
 *
 * Coverage tiers:
 *   1. Block jsxComponents (Math, Mermaid) → expected markdown-source
 *      bytes
 *   2. Falls through (Callout, paragraph, heading, mathInline,
 *      unknown jsxComponent) → null
 *   3. Edge cases — empty / missing / non-string props
 */

import { describe, expect, test } from 'bun:test';
import type { Node as PmNode } from '@tiptap/pm/model';
import { sourceFallbackFormFor } from './non-portable-render-source-fallback.ts';

/**
 * Build a stub PmNode shape that matches the call sites'
 * `node.type.name`, `node.attrs.componentName`, `node.attrs.props`
 * access patterns. The classifier doesn't touch any other field, so
 * the cast is safe at runtime.
 */
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
    // `$$x$$` inline (no newlines) parses as inline math by remark-math
    // even though our intent is block. Keep newlines so destinations
    // re-parsing as markdown classify correctly.
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
    // Defensive against descriptor schema drift (e.g. a future
    // `formula: number` migration). The string-narrow guard converts
    // non-strings to '' rather than risk emitting `undefined` / `null`
    // text into the clipboard.
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
    // Symmetric defense with the Math non-string formula test —
    // descriptor schema drift (e.g. `chart: object` migration) shouldn't
    // emit `[object Object]` into the clipboard.
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
    // mathInline is a PM atom (`inline: true, atom: true`) whose parent
    // is always a paragraph. The walker's `nodesBetween` callback gates
    // on `parent !== view.state.doc`, so inline atoms never surface as
    // the iteration target — this helper is unreachable for them.
    // Inline-atom source-fallback is handled by
    // `clipboard-walker.ts:applyNonPortableInlineAtomReplacement` which
    // walks the cloned paragraph subtree and replaces matching elements
    // directly via the DOM. This branch returning null is intentional.
    const node = stubPmNode({ typeName: 'mathInline' });
    expect(sourceFallbackFormFor(node)).toBeNull();
  });

  test('Callout jsxComponent → null (palette path handles it separately)', () => {
    // Callout has its own palette entry that emits a styled `<aside>`,
    // and the walker primary path clones the live-rendered aside
    // cleanly. Source-fallback is intentionally NOT applied — Callout
    // is portable.
    const node = stubPmNode({
      typeName: 'jsxComponent',
      componentName: 'Callout',
      props: { type: 'note' },
    });
    expect(sourceFallbackFormFor(node)).toBeNull();
  });

  test('img/video/audio jsxComponents → null (URL classifier handles)', () => {
    // These have URL-portability source-fallback for non-portable URLs
    // (data:, blob:, file:) handled separately in
    // `clipboard-walker.ts:applyUrlClassifierPostPass`. The non-
    // portable-RENDER fallback is for KaTeX/SVG, not URL-bearing
    // primitives — distinct concerns.
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
    // Future descriptors that ship without opting into the source-
    // fallback path stay null — the walker primary path clones their
    // live render. Adding a non-portable descriptor requires also
    // adding a case here (and to `PALETTE_DESCRIPTOR_NAMES`).
    const node = stubPmNode({
      typeName: 'jsxComponent',
      componentName: 'CustomFutureComponent',
      props: {},
    });
    expect(sourceFallbackFormFor(node)).toBeNull();
  });
});

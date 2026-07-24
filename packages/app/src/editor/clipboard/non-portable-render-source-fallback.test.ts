/**
 * Co-located unit tests for the non-portable-render source-fallback
 * helper. Mirrors the convention from `clipboard-walker-fallback-
 * palette.test.ts`: the vitest node environment has no DOM, so the DOM-shape behaviour of
 * `nonPortableRenderSourceFallback` is covered by Playwright E2E. This
 * file pins the **structural** dispatch contract that is testable
 * without a DOM via `sourceFallbackFormFor` (the inner pure classifier).
 *
 * Coverage tiers:
 *   1. Block jsxComponents (Math, Mermaid) → expected markdown-source
 *      bytes
 *   2. Preview-active codeBlock → fenced-source bytes; non-preview → null
 *   3. Falls through (Callout, paragraph, heading, mathInline,
 *      unknown jsxComponent) → null
 *   4. Edge cases — empty / missing / non-string props
 */

import { MarkdownManager, sharedExtensions } from '@inkeep/open-knowledge-core';
import type { Node as PmNode } from '@tiptap/pm/model';
import { describe, expect, test } from 'vitest';
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
    // `html` normalizes to highlight.js's `xml` key; a block authored as
    // `xml preview` renders the same iframe and must fall back too.
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
    // A body containing a ``` run would early-close a 3-backtick fence on
    // re-parse (CommonMark §4.5); the fence widens to one longer.
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
    // A backtick in the meta forces a tilde fence; a body containing a `~~~`
    // run would early-close a 3-tilde fence on re-parse (CommonMark §4.5),
    // so the tilde fence widens to one longer.
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
    // `js preview` renders no iframe — the preview pane only mounts for
    // html/xml. The gate must not fire for other languages.
    const node = stubPmNode({
      typeName: 'codeBlock',
      language: 'js',
      meta: 'preview',
      textContent: "console.log('x')",
    });
    expect(sourceFallbackFormFor(node)).toBeNull();
  });

  test('null language attr → null (no preview gate, no throw)', () => {
    // Symmetric defense with the Math/Mermaid non-string prop tests — a
    // non-string attr narrows to '' and the preview gate declines it.
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
    // A `title="…"` meta token may contain a backtick (setMetaTitle strips
    // `"` and newlines but not backticks; a tilde-authored fence has no
    // restriction). CommonMark §4.5 forbids backticks in a backtick fence's
    // info-string, so embedding such meta after a backtick fence produces an
    // opener that parsers reject — the block degrades to a paragraph. The
    // emitted source must stay a valid fence so the round-trip intent holds.
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
    // The info-string line must not embed the fence character it opens with.
    const fenceChar = source[0];
    const infoLine = source.slice(0, source.indexOf('\n'));
    expect(infoLine.slice(3)).not.toContain(fenceChar);
  });
});

describe('sourceFallbackFormFor — emitted fence round-trips through OK`s parser', () => {
  // The whole point of emitting fenced source (rather than the live iframe) is
  // that a markdown-aware destination — OK`s own parser included — re-parses it
  // back to a code block. Drive the REAL markdown pipeline so a fence that only
  // LOOKS valid but degrades to prose on re-parse is caught.
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

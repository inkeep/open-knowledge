import type { JSONContent } from '@tiptap/core';
import type { Fragment } from '@tiptap/pm/model';
import { Schema } from '@tiptap/pm/model';
import type { EditorView } from '@tiptap/pm/view';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { SerializeResult, WalkerEnv } from './clipboard-walker.ts';

const actualWalker = await import('./clipboard-walker.ts');
const realWalkLiveDom = actualWalker.walkLiveDomToInlineStyledFragment;

let capturedEnv: WalkerEnv | null = null;
let captureActive = false;

vi.doMock('./clipboard-walker.ts', () => ({
  ...actualWalker,
  walkLiveDomToInlineStyledFragment: (slice: unknown, view: unknown, env: WalkerEnv) => {
    if (captureActive) {
      capturedEnv = env;
      return { childNodes: [] };
    }
    // biome-ignore lint/suspicious/noExplicitAny: pass-through to the real implementation
    return realWalkLiveDom(slice as any, view as any, env);
  },
}));

const { createClipboardHtmlSerializer, findDescriptorRoot } = await import('./serialize.ts');

interface FakeEl {
  classes: Set<string>;
  attrs: Set<string>;
  parentElement: FakeEl | null;
  children: FakeEl[];
  childNodes: unknown[];
  classList: { contains: (c: string) => boolean };
  hasAttribute: (a: string) => boolean;
}

function el(opts?: { classes?: string[]; attrs?: string[] }): FakeEl {
  const classes = new Set(opts?.classes ?? []);
  const attrs = new Set(opts?.attrs ?? []);
  const node: FakeEl = {
    classes,
    attrs,
    parentElement: null,
    children: [],
    childNodes: [],
    classList: { contains: (c: string) => classes.has(c) },
    hasAttribute: (a: string) => attrs.has(a),
  };
  return node;
}

function chain(...els: FakeEl[]): void {
  for (let i = 1; i < els.length; i++) {
    els[i].parentElement = els[i - 1];
  }
}

const fakeTextNode = () => ({ nodeType: 3 });

function buildInlineZoomTopology() {
  const proseMirror = el({ classes: ['ProseMirror'] });
  const para = el();
  const reactRenderer = el({ classes: ['react-renderer', 'node-image'] });
  const inlineLeafWrapper = el({
    attrs: ['data-node-view-wrapper', 'data-clipboard-inline-leaf'],
  });
  const rmiz = el({ attrs: ['data-rmiz'] });
  const rmizContent = el({ attrs: ['data-rmiz-content'] });
  const img = el();
  chain(proseMirror, para, reactRenderer, inlineLeafWrapper, rmiz, rmizContent, img);
  para.children = [reactRenderer];
  para.childNodes = [fakeTextNode(), reactRenderer, fakeTextNode()];
  return { para, reactRenderer, img };
}

const inlineImageSchema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: {
      group: 'block',
      content: 'inline*',
      toDOM: () => ['p', 0],
      parseDOM: [{ tag: 'p' }],
    },
    image: {
      group: 'inline',
      inline: true,
      atom: true,
      attrs: { src: { default: '' }, alt: { default: '' } },
      toDOM: (node) => ['img', { src: node.attrs.src, alt: node.attrs.alt }],
      parseDOM: [{ tag: 'img' }],
    },
    text: { group: 'inline' },
  },
});

const LEADING_TEXT = 'Some prose with an ';
const TRAILING_TEXT = ' image.';

function buildDoc() {
  return inlineImageSchema.node('doc', null, [
    inlineImageSchema.node('paragraph', null, [
      inlineImageSchema.text(LEADING_TEXT),
      inlineImageSchema.node('image', { src: './x.jpg', alt: 'alt' }),
      inlineImageSchema.text(TRAILING_TEXT),
    ]),
  ]);
}

const IMAGE_POS = 1 + LEADING_TEXT.length;

function fakePosAtDOM(para: FakeEl, img: FakeEl, doc: ReturnType<typeof buildDoc>) {
  const paraNode = doc.child(0);
  return (node: unknown, offset: number, _bias?: number): number => {
    if (node === img) return IMAGE_POS;
    if (node === para) {
      let pos = 1;
      for (let i = 0; i < offset; i++) {
        pos += paraNode.child(i).nodeSize;
      }
      return pos;
    }
    throw new RangeError('fakePosAtDOM: element not in fake mapping');
  };
}

function discriminatingMdManager() {
  const serializeJson = (json: JSONContent): string => {
    if (json.type === 'image') {
      return `![${json.attrs?.alt ?? ''}](${json.attrs?.src ?? ''})`;
    }
    if (json.type === 'text') return json.text ?? '';
    return (json.content ?? []).map(serializeJson).join('');
  };
  return {
    serialize: (json: JSONContent) => serializeJson(json),
    parse: () => ({ type: 'doc', content: [] }),
  };
}

function captureEnv(para: FakeEl, img: FakeEl): WalkerEnv {
  capturedEnv = null;
  captureActive = true;
  const doc = buildDoc();
  const view = {
    posAtDOM: fakePosAtDOM(para, img, doc),
    state: {
      schema: inlineImageSchema,
      doc,
      selection: {
        from: 0,
        to: doc.content.size,
        content: () => doc.slice(0, doc.content.size),
      },
    },
  } as unknown as EditorView;
  const handle = createClipboardHtmlSerializer({
    // biome-ignore lint/suspicious/noExplicitAny: markdown-manager double
    mdManager: discriminatingMdManager() as any,
  });
  handle.setView(view);
  try {
    handle.serializer.serializeFragment({ firstChild: null } as unknown as Fragment, undefined, {
      appendChild: () => {},
    } as unknown as DocumentFragment);
  } finally {
    captureActive = false;
  }
  if (!capturedEnv) throw new Error('walker env was not captured');
  return capturedEnv;
}

let origWarn: typeof console.warn;
beforeEach(() => {
  origWarn = console.warn;
  console.warn = () => {};
});
afterEach(() => {
  console.warn = origWarn;
});

describe('QA-005 contract — inline-image source-fallback range resolution', () => {
  test('findDescriptorRoot: real ImageInlineZoom topology (outer .react-renderer.node-image present) is NOT a descriptor', () => {
    const { img } = buildInlineZoomTopology();
    expect(findDescriptorRoot(img as unknown as Element)).toBeNull();
  });

  test('serializeElementMarkdown resolves the inline image atom, not the paragraph leading text run', () => {
    const { para, img } = buildInlineZoomTopology();
    const env = captureEnv(para, img);
    const result = env.serializeElementMarkdown?.(img as unknown as Element) as SerializeResult;
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.markdown).toBe('![alt](./x.jpg)');
    }
  });

  test('descriptor path with a leading text sibling passes a childNodes offset to posAtDOM (genuine descriptor mid-paragraph)', () => {
    const proseMirror = el({ classes: ['ProseMirror'] });
    const para = el();
    const reactRenderer = el({ classes: ['react-renderer', 'node-mathInline'] });
    const innerWrapper = el({ attrs: ['data-node-view-wrapper'] });
    const leaf = el();
    chain(proseMirror, para, reactRenderer, innerWrapper, leaf);
    para.children = [reactRenderer];
    para.childNodes = [fakeTextNode(), reactRenderer, fakeTextNode()];

    const env = captureEnv(para, leaf);
    const result = env.serializeElementMarkdown?.(leaf as unknown as Element) as SerializeResult;
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.markdown).toBe('![alt](./x.jpg)');
    }
  });
});

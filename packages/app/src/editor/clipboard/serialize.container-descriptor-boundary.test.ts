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
  childNodes: unknown[];
  classList: { contains: (c: string) => boolean };
  hasAttribute: (a: string) => boolean;
}

function el(opts?: { classes?: string[]; attrs?: string[] }): FakeEl {
  const classes = new Set(opts?.classes ?? []);
  const attrs = new Set(opts?.attrs ?? []);
  return {
    classes,
    attrs,
    parentElement: null,
    childNodes: [],
    classList: { contains: (c: string) => classes.has(c) },
    hasAttribute: (a: string) => attrs.has(a),
  };
}

function chain(...els: FakeEl[]): void {
  for (let i = 1; i < els.length; i++) {
    els[i].parentElement = els[i - 1];
  }
}

function buildContainerWithImageTopology() {
  const proseMirror = el({ classes: ['ProseMirror'] });
  const calloutRenderer = el({ classes: ['react-renderer', 'node-jsxComponent'] });
  const calloutWrapper = el({ attrs: ['data-node-view-wrapper', 'data-jsx-component'] });
  const calloutBody = el();
  const contentDom = el({ attrs: ['data-node-view-content'] });
  const imageRenderer = el({ classes: ['react-renderer', 'node-jsxComponent'] });
  const imageWrapper = el({ attrs: ['data-node-view-wrapper', 'data-jsx-component'] });
  const img = el();
  chain(
    proseMirror,
    calloutRenderer,
    calloutWrapper,
    calloutBody,
    contentDom,
    imageRenderer,
    imageWrapper,
    img,
  );
  proseMirror.childNodes = [calloutRenderer];
  contentDom.childNodes = [imageRenderer];
  return { proseMirror, calloutRenderer, contentDom, imageRenderer, img };
}

function buildNestedContainerTopology() {
  const proseMirror = el({ classes: ['ProseMirror'] });
  const outerRenderer = el({ classes: ['react-renderer', 'node-jsxComponent'] });
  const outerWrapper = el({ attrs: ['data-node-view-wrapper', 'data-jsx-component'] });
  const outerContent = el({ attrs: ['data-node-view-content'] });
  const innerRenderer = el({ classes: ['react-renderer', 'node-jsxComponent'] });
  const innerWrapper = el({ attrs: ['data-node-view-wrapper', 'data-jsx-component'] });
  const innerContent = el({ attrs: ['data-node-view-content'] });
  const imageRenderer = el({ classes: ['react-renderer', 'node-jsxComponent'] });
  const imageWrapper = el({ attrs: ['data-node-view-wrapper', 'data-jsx-component'] });
  const img = el();
  chain(
    proseMirror,
    outerRenderer,
    outerWrapper,
    outerContent,
    innerRenderer,
    innerWrapper,
    innerContent,
    imageRenderer,
    imageWrapper,
    img,
  );
  return { proseMirror, outerRenderer, innerRenderer, imageRenderer, img };
}

const containerSchema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    container: {
      group: 'block',
      content: 'block+',
      toDOM: () => ['div', { 'data-jsx': 'callout' }, 0],
      parseDOM: [{ tag: 'div[data-jsx=callout]' }],
    },
    image: {
      group: 'block',
      atom: true,
      attrs: { src: { default: '' }, alt: { default: '' } },
      toDOM: (node) => ['img', { src: node.attrs.src, alt: node.attrs.alt }],
      parseDOM: [{ tag: 'img' }],
    },
    text: { group: 'inline' },
  },
});

function buildDoc() {
  return containerSchema.node('doc', null, [
    containerSchema.node('container', null, [
      containerSchema.node('image', { src: './shot.png', alt: 'shot' }),
    ]),
  ]);
}

const IMAGE_POS = 1;

function fakePosAtDOM(
  topology: ReturnType<typeof buildContainerWithImageTopology>,
  doc: ReturnType<typeof buildDoc>,
) {
  const { proseMirror, contentDom, img } = topology;
  const container = doc.child(0);
  return (node: unknown, offset: number, _bias?: number): number => {
    if (node === img) return IMAGE_POS;
    if (node === proseMirror) {
      let pos = 0;
      for (let i = 0; i < offset; i++) pos += doc.child(i).nodeSize;
      return pos;
    }
    if (node === contentDom) {
      let pos = 1;
      for (let i = 0; i < offset; i++) pos += container.child(i).nodeSize;
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
    if (json.type === 'container') {
      return `<callout>${(json.content ?? []).map(serializeJson).join('')}</callout>`;
    }
    if (json.type === 'text') return json.text ?? '';
    return (json.content ?? []).map(serializeJson).join('');
  };
  return {
    serialize: (json: JSONContent) => serializeJson(json),
    parse: () => ({ type: 'doc', content: [] }),
  };
}

function captureEnv(topology: ReturnType<typeof buildContainerWithImageTopology>): WalkerEnv {
  capturedEnv = null;
  captureActive = true;
  const doc = buildDoc();
  const view = {
    posAtDOM: fakePosAtDOM(topology, doc),
    state: {
      schema: containerSchema,
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

describe('container-descriptor boundary — leaf resolves to its own descriptor across [data-node-view-content]', () => {
  test('findDescriptorRoot: a leaf inside a container NodeViewContent resolves to its OWN descriptor, not the enclosing container', () => {
    const { calloutRenderer, imageRenderer, img } = buildContainerWithImageTopology();
    const resolved = findDescriptorRoot(img as unknown as Element);
    expect(resolved).toBe(imageRenderer as unknown as Element);
    expect(resolved).not.toBe(calloutRenderer as unknown as Element);
  });

  test('findDescriptorRoot: through TWO nested containers, the leaf still resolves to the innermost descriptor', () => {
    const { outerRenderer, innerRenderer, imageRenderer, img } = buildNestedContainerTopology();
    const resolved = findDescriptorRoot(img as unknown as Element);
    expect(resolved).toBe(imageRenderer as unknown as Element);
    expect(resolved).not.toBe(innerRenderer as unknown as Element);
    expect(resolved).not.toBe(outerRenderer as unknown as Element);
  });

  test('serializeElementMarkdown emits the leaf image markdown, not the whole container component source', () => {
    const topology = buildContainerWithImageTopology();
    const env = captureEnv(topology);
    const result = env.serializeElementMarkdown?.(
      topology.img as unknown as Element,
    ) as SerializeResult;
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.markdown).toBe('![shot](./shot.png)');
    }
  });
});

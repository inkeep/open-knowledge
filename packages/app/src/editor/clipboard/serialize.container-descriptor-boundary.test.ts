/**
 * Container-descriptor boundary contract: a leaf reached THROUGH a container
 * NodeView's content area (`[data-node-view-content]`, emitted by
 * `@tiptap/react`'s `NodeViewContent`) must resolve to its OWN descriptor
 * root and its OWN ProseMirror range, never the enclosing container's.
 *
 * A container descriptor (a `jsxComponent` with children, e.g. `Callout`,
 * `Accordion`) renders its children into a `[data-node-view-content]` hole.
 * When a descriptor-rendered leaf (e.g. a `CommonMarkImage` `jsxComponent`)
 * lives inside that hole, the production DOM is
 * (`JsxComponentView.tsx` Branch 2 + `NodeViewContent`):
 *
 *   .ProseMirror
 *     .react-renderer.node-jsxComponent            (Callout outer wrapper)
 *       [data-node-view-wrapper data-jsx-component] (Callout NodeViewWrapper)
 *         .jsx-component-chrome
 *         <Callout> …
 *           [data-node-view-content]               (Callout children hole)
 *             .react-renderer.node-jsxComponent    (image outer wrapper)
 *               [data-node-view-wrapper data-jsx-component]
 *                 img                              (leaf)
 *
 * The `[data-node-view-content]` element belongs to the container, but
 * everything the container HOSTS inside it is a different, enclosed PM node.
 * A descriptor climb that records the outermost matching wrapper without
 * stopping at that boundary adopts the CONTAINER's wrapper as the leaf's
 * descriptor root, so `posAtDOM → nodeAt → slice` covers the whole container
 * and the cross-app `text/html` source-fallback emits the entire component's
 * markdown at the leaf's slot.
 *
 * These tests pin the invariant at two tiers:
 *   1. `findDescriptorRoot` (the single choke point) resolves the leaf's own
 *      descriptor across one and across two nested contentDOM boundaries.
 *   2. `serializeElementMarkdown` (the real consumer) emits the leaf's own
 *      markdown bytes, not the whole container component's source.
 *
 * Harness mirrors `serialize.inline-image-range.test.ts`: `buildWalkerEnv`
 * is private, so the walker entry point is stubbed via `vi.doMock` to
 * capture the env, and the env is driven through the same public wiring
 * production uses. The mock DELEGATES to the real implementation outside an
 * explicit capture window so it stays behavior-transparent to the worker.
 */

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

// Imported AFTER the module mock so `serializeFragment`'s walker tier hits
// the delegating mock above.
const { createClipboardHtmlSerializer, findDescriptorRoot } = await import('./serialize.ts');

// ---------------------------------------------------------------------------
// Fake live-DOM elements — cover exactly the surface the code under test
// touches (`classList.contains`, `hasAttribute`, `parentElement`,
// `childNodes`) with STABLE object identity so `parentElement ===` and
// `childNodes.indexOf(...)` work.
// ---------------------------------------------------------------------------

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

/**
 * Container (Callout `jsxComponent`) holding an inline image, both real
 * `jsxComponent` NodeViews, with the image nested inside the container's
 * `[data-node-view-content]` hole.
 */
function buildContainerWithImageTopology() {
  const proseMirror = el({ classes: ['ProseMirror'] });
  const calloutRenderer = el({ classes: ['react-renderer', 'node-jsxComponent'] });
  const calloutWrapper = el({ attrs: ['data-node-view-wrapper', 'data-jsx-component'] });
  const calloutBody = el(); // rendered <Callout> element
  const contentDom = el({ attrs: ['data-node-view-content'] }); // NodeViewContent hole
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
  // Wire the childNodes the descriptor-parent branch indexes through.
  proseMirror.childNodes = [calloutRenderer];
  contentDom.childNodes = [imageRenderer];
  return { proseMirror, calloutRenderer, contentDom, imageRenderer, img };
}

/**
 * Doubly-nested container: an outer container whose content hole hosts an
 * inner container whose content hole hosts the image leaf. Pins that the
 * leaf resolves to its OWN descriptor across TWO contentDOM boundaries, not
 * either enclosing container's.
 */
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

// ---------------------------------------------------------------------------
// PM document mirroring a container holding a single image descriptor.
// ---------------------------------------------------------------------------

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
    // Required by prosemirror-model (every schema needs a text type) even
    // though the container's block-only content never holds text here.
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

// Doc content starts at 0: the container node opens at 0 (the over-climb
// slices from here), its content starts at 1, and the image atom sits at
// position 1 (the leaf's own range).
const IMAGE_POS = 1;

/**
 * posAtDOM faithful to ProseMirror's contract: the offset counts CHILDNODES
 * of the PM node the passed DOM element maps to.
 *   - `.ProseMirror` maps to the doc — offset 0 → position 0 (the container).
 *   - the container's `[data-node-view-content]` maps to the container's
 *     content region — offset 0 → position 1 (the image atom).
 * The correct climb resolves `descriptorRoot = imageRenderer` (parent =
 * contentDom → image); the over-climb resolves `descriptorRoot =
 * calloutRenderer` (parent = .ProseMirror → whole container).
 */
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

/**
 * Markdown manager double that discriminates WHICH PM node reached
 * serialization: an image emits its markdown source, a container wraps its
 * serialized children in a marker so the over-climb (whole-component source)
 * surfaces as distinct bytes, never a false green.
 */
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
    // Positive: the image's own outer `.react-renderer` is the descriptor root.
    expect(resolved).toBe(imageRenderer as unknown as Element);
    // Negative: the enclosing container's wrapper must NOT be adopted — the
    // `[data-node-view-content]` boundary belongs to a different PM node.
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
      // The leaf's own range — NOT `<callout>![shot](./shot.png)</callout>`,
      // which is what the over-climb slices and serializes.
      expect(result.markdown).toBe('![shot](./shot.png)');
    }
  });
});

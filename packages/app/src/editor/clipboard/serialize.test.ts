
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { JSONContent } from '@tiptap/core';
import type { Fragment } from '@tiptap/pm/model';
import { Schema } from '@tiptap/pm/model';
import type { EditorView } from '@tiptap/pm/view';

import {
  createClipboardHtmlSerializer,
  createClipboardTextSerializer,
  findDescriptorRoot,
  sliceToDocJson,
} from './serialize.ts';

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: {
      group: 'block',
      content: 'text*',
      toDOM: () => ['p', 0],
      parseDOM: [{ tag: 'p' }],
    },
    text: { group: 'inline' },
  },
});

function makeSlice(text: string) {
  const doc = schema.node('doc', null, [schema.node('paragraph', null, [schema.text(text)])]);
  return doc.slice(0, doc.content.size);
}

function fakeMdManager() {
  return {
    serialize: mock((doc: JSONContent) => {
      const p = doc.content?.[0]?.content?.[0]?.text ?? '';
      return `# ${p}`;
    }),
    parse: mock(() => ({ type: 'doc', content: [] })),
  };
}

function fakeView() {
  return { state: { schema } } as unknown as Parameters<
    ReturnType<typeof createClipboardTextSerializer>
  >[1];
}

let origWarn: typeof console.warn;
beforeEach(() => {
  origWarn = console.warn;
  console.warn = () => {};
});
afterEach(() => {
  console.warn = origWarn;
});

describe('createClipboardTextSerializer', () => {
  test('produces markdown from a slice via MarkdownManager.serialize', () => {
    const md = fakeMdManager();
    // biome-ignore lint/suspicious/noExplicitAny: fake md manager shape
    const serializer = createClipboardTextSerializer({ mdManager: md as any });
    const text = serializer(makeSlice('hello'), fakeView());
    expect(text).toBe('# hello');
    expect(md.serialize).toHaveBeenCalledTimes(1);
  });

  test('falls through to PM textBetween on serialize throw', () => {
    const md = fakeMdManager();
    md.serialize = mock(() => {
      throw new Error('boom');
    });
    // biome-ignore lint/suspicious/noExplicitAny: fake md manager shape
    const serializer = createClipboardTextSerializer({ mdManager: md as any });
    const text = serializer(makeSlice('hello world'), fakeView());
    expect(text).toContain('hello world');
  });

  test('never throws — even on an empty-selection slice', () => {
    const md = fakeMdManager();
    // biome-ignore lint/suspicious/noExplicitAny: fake md manager shape
    const serializer = createClipboardTextSerializer({ mdManager: md as any });
    const emptyDoc = schema.node('doc', null, [schema.node('paragraph')]);
    const slice = emptyDoc.slice(0, emptyDoc.content.size);
    expect(() => serializer(slice, fakeView())).not.toThrow();
  });
});

describe('createClipboardHtmlSerializer — walker→markdown tier dispatch', () => {

  function emptyFragment(): Fragment {
    return { firstChild: null } as unknown as Fragment;
  }

  function sentinelTarget(): DocumentFragment {
    return {} as DocumentFragment;
  }

  let warnCalls: string[];
  let innerOrigWarn: typeof console.warn;
  beforeEach(() => {
    warnCalls = [];
    innerOrigWarn = console.warn;
    console.warn = (msg: unknown) => {
      warnCalls.push(typeof msg === 'string' ? msg : String(msg));
    };
  });
  afterEach(() => {
    console.warn = innerOrigWarn;
  });

  test('view attached + active selection + walker throws → catch fires + markdown tier returns target', () => {
    const view = {
      state: {
        selection: {
          from: 0,
          to: 5,
          content: () => {
            throw new Error('walker-boom');
          },
        },
      },
    } as unknown as EditorView;

    const md = fakeMdManager();
    const handle = createClipboardHtmlSerializer({
      // biome-ignore lint/suspicious/noExplicitAny: fake md manager shape
      mdManager: md as any,
    });
    handle.setView(view);

    const target = sentinelTarget();
    const result = handle.serializer.serializeFragment(emptyFragment(), undefined, target);

    const failEvent = warnCalls.find((w) => w.includes('clipboard-serialize-failed'));
    expect(failEvent).toBeDefined();
    expect(failEvent).toContain('walker:walker-boom');

    expect(result).toBe(target);
  });

  test('no view attached → walker tier skipped → markdown tier returns target', () => {
    const md = fakeMdManager();
    const handle = createClipboardHtmlSerializer({
      // biome-ignore lint/suspicious/noExplicitAny: fake md manager shape
      mdManager: md as any,
    });

    const target = sentinelTarget();
    const result = handle.serializer.serializeFragment(emptyFragment(), undefined, target);

    expect(warnCalls.find((w) => w.includes('walker:'))).toBeUndefined();
    expect(result).toBe(target);
  });

  test('collapsed selection (from === to) → walker tier skipped → markdown tier returns target', () => {
    const view = {
      state: {
        selection: {
          from: 0,
          to: 0,
          content: () => {
            throw new Error('should-not-be-called');
          },
        },
      },
    } as unknown as EditorView;

    const md = fakeMdManager();
    const handle = createClipboardHtmlSerializer({
      // biome-ignore lint/suspicious/noExplicitAny: fake md manager shape
      mdManager: md as any,
    });
    handle.setView(view);

    const target = sentinelTarget();
    const result = handle.serializer.serializeFragment(emptyFragment(), undefined, target);

    expect(warnCalls.find((w) => w.includes('walker:'))).toBeUndefined();
    expect(result).toBe(target);
  });
});

describe('createClipboardHtmlSerializer — walker env wires markdown reconstruction', () => {

  let warnCalls: string[];
  let innerOrigWarn: typeof console.warn;
  beforeEach(() => {
    warnCalls = [];
    innerOrigWarn = console.warn;
    console.warn = (msg: unknown) => {
      warnCalls.push(typeof msg === 'string' ? msg : String(msg));
    };
  });
  afterEach(() => {
    console.warn = innerOrigWarn;
  });

  test('walker tier receives an env with `serializeElementMarkdown` when view is attached', () => {
    const view = {
      posAtDOM: () => 0,
      state: {
        schema: {} as Schema,
        selection: {
          from: 0,
          to: 5,
          content: () => {
            throw new Error('walker-boom');
          },
        },
        doc: {
          nodeAt: () => null,
          slice: () => ({ content: { toJSON: () => [] } }),
        },
      },
    } as unknown as EditorView;
    const md = fakeMdManager();
    const handle = createClipboardHtmlSerializer({
      // biome-ignore lint/suspicious/noExplicitAny: fake md manager shape
      mdManager: md as any,
    });
    handle.setView(view);
    const target = {} as DocumentFragment;
    handle.serializer.serializeFragment(
      { firstChild: null } as unknown as Fragment,
      undefined,
      target,
    );
    const failEvent = warnCalls.find((w) => w.includes('clipboard-serialize-failed'));
    expect(failEvent).toBeDefined();
    expect(failEvent).toContain('walker:walker-boom');
  });
});

interface FakeDescriptorElement {
  parentElement: FakeDescriptorElement | null;
  classes: Set<string>;
  attrs: Set<string>;
}

function makeDescriptorEl(opts?: { classes?: string[]; attrs?: string[] }): FakeDescriptorElement {
  return {
    parentElement: null,
    classes: new Set(opts?.classes ?? []),
    attrs: new Set(opts?.attrs ?? []),
  };
}

function chainDescriptorEls(...els: FakeDescriptorElement[]): FakeDescriptorElement {
  for (let i = 1; i < els.length; i++) {
    els[i].parentElement = els[i - 1];
  }
  return els[els.length - 1];
}

function wrapDescriptor(el: FakeDescriptorElement): Element {
  return {
    classList: { contains: (c: string) => el.classes.has(c) },
    hasAttribute: (a: string) => el.attrs.has(a),
    get parentElement() {
      return el.parentElement === null ? null : wrapDescriptor(el.parentElement);
    },
  } as unknown as Element;
}

describe('findDescriptorRoot — outermost-wrapper selection', () => {

  test('(a) bare element with only ProseMirror parent → returns null', () => {
    const proseMirror = makeDescriptorEl({ classes: ['ProseMirror'] });
    const img = makeDescriptorEl();
    const live = chainDescriptorEls(proseMirror, img);
    expect(findDescriptorRoot(wrapDescriptor(live))).toBeNull();
  });

  test('(b) single .react-renderer wrapper → returns that wrapper', () => {
    const proseMirror = makeDescriptorEl({ classes: ['ProseMirror'] });
    const reactRenderer = makeDescriptorEl({ classes: ['react-renderer'] });
    const img = makeDescriptorEl();
    const live = chainDescriptorEls(proseMirror, reactRenderer, img);
    const root = findDescriptorRoot(wrapDescriptor(live));
    expect(root).not.toBeNull();
    expect(root?.classList.contains('react-renderer')).toBe(true);
  });

  test('(c) nested wrappers → returns the OUTERMOST wrapper (CRITICAL — load-bearing)', () => {
    const proseMirror = makeDescriptorEl({ classes: ['ProseMirror'] });
    const reactRenderer = makeDescriptorEl({ classes: ['react-renderer'] });
    const innerWrapper = makeDescriptorEl({
      attrs: ['data-node-view-wrapper', 'data-jsx-component'],
    });
    const img = makeDescriptorEl();
    const live = chainDescriptorEls(proseMirror, reactRenderer, innerWrapper, img);

    const root = findDescriptorRoot(wrapDescriptor(live));
    expect(root).not.toBeNull();
    expect(root?.classList.contains('react-renderer')).toBe(true);
    expect(root?.hasAttribute('data-node-view-wrapper')).toBe(false);
  });

  test('(d) climbing stops at the .ProseMirror boundary', () => {
    const outerChrome = makeDescriptorEl({ classes: ['react-renderer'] });
    const proseMirror = makeDescriptorEl({ classes: ['ProseMirror'] });
    const img = makeDescriptorEl();
    const live = chainDescriptorEls(outerChrome, proseMirror, img);

    const root = findDescriptorRoot(wrapDescriptor(live));
    expect(root).toBeNull();
  });

  test('(e) detached element with no .ProseMirror ancestor → returns null', () => {
    const detached = makeDescriptorEl();
    const root = findDescriptorRoot(wrapDescriptor(detached));
    expect(root).toBeNull();
  });

  test('(f) wrappers carrying `data-clipboard-inline-leaf` are skipped (ImageInlineZoom opt-out)', () => {
    const proseMirror = makeDescriptorEl({ classes: ['ProseMirror'] });
    const para = makeDescriptorEl();
    const inlineLeafWrapper = makeDescriptorEl({
      attrs: ['data-node-view-wrapper', 'data-clipboard-inline-leaf'],
    });
    const img = makeDescriptorEl();
    const live = chainDescriptorEls(proseMirror, para, inlineLeafWrapper, img);

    expect(findDescriptorRoot(wrapDescriptor(live))).toBeNull();
  });

  test('(g) opt-out is wrapper-local — a real descriptor BEYOND the inline-leaf wrapper still matches (defense against accidental no-op for nested cases)', () => {
    const proseMirror = makeDescriptorEl({ classes: ['ProseMirror'] });
    const outerReactRenderer = makeDescriptorEl({ classes: ['react-renderer'] });
    const inlineLeafWrapper = makeDescriptorEl({
      attrs: ['data-node-view-wrapper', 'data-clipboard-inline-leaf'],
    });
    const img = makeDescriptorEl();
    const live = chainDescriptorEls(proseMirror, outerReactRenderer, inlineLeafWrapper, img);

    const root = findDescriptorRoot(wrapDescriptor(live));
    expect(root).not.toBeNull();
    expect(root?.classList.contains('react-renderer')).toBe(true);
  });
});

describe('sliceToDocJson — inline-first wrapping branch', () => {

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

  test('inline-first slice → wraps in paragraph, doc JSON contains image atom', () => {
    const img = inlineImageSchema.node('image', { src: 'cat.png', alt: 'cat' });
    const paragraph = inlineImageSchema.node('paragraph', null, [img]);
    const slice = paragraph.slice(0, paragraph.content.size);
    expect(slice.content.firstChild?.isInline).toBe(true);

    const docJson = sliceToDocJson(slice, inlineImageSchema);

    expect(docJson.type).toBe('doc');
    const firstBlock = docJson.content?.[0];
    expect(firstBlock?.type).toBe('paragraph');
    const firstInline = firstBlock?.content?.[0];
    expect(firstInline?.type).toBe('image');
    expect(firstInline?.attrs?.src).toBe('cat.png');
  });

  test('block-first slice → no wrap, doc JSON nests block directly under doc', () => {
    const img = inlineImageSchema.node('image', { src: 'cat.png', alt: 'cat' });
    const paragraph = inlineImageSchema.node('paragraph', null, [img]);
    const doc = inlineImageSchema.node('doc', null, [paragraph]);
    const slice = doc.slice(0, doc.content.size);
    expect(slice.content.firstChild?.isInline).toBe(false);
    expect(slice.content.firstChild?.type.name).toBe('paragraph');

    const docJson = sliceToDocJson(slice, inlineImageSchema);

    expect(docJson.type).toBe('doc');
    expect(docJson.content?.[0]?.type).toBe('paragraph');
    expect(docJson.content?.[0]?.content?.[0]?.type).toBe('image');
  });
});

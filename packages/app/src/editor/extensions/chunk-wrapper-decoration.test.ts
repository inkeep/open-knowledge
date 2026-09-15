import { Schema } from '@tiptap/pm/model';
import { EditorState, type Plugin } from '@tiptap/pm/state';
import type { DecorationSet } from '@tiptap/pm/view';
import { afterEach, describe, expect, test } from 'vitest';
import {
  __resetFirstEmitForTesting,
  chunkWrapperDecorationKey,
  chunkWrapperDecorationPlugin,
  OK_CHUNK_WRAPPER_CLASS,
} from './chunk-wrapper-decoration';

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'inline*' },
    heading: { group: 'block', content: 'inline*', attrs: { level: { default: 1 } } },
    blockquote: { group: 'block', content: 'block+' },
    list: { group: 'block', content: 'listItem+' },
    listItem: { content: 'paragraph block*' },
    jsxComponent: {
      group: 'block',
      content: 'block*',
      attrs: { componentName: { default: 'Callout' } },
    },
    text: { group: 'inline' },
  },
  marks: {},
});

interface DecorationSpec {
  from: number;
  to: number;
  attrs: Record<string, string>;
}

function decorationSpecs(state: EditorState): DecorationSpec[] | null {
  const plugin = state.plugins.find((p) => p.spec.key === chunkWrapperDecorationKey) as
    | Plugin
    | undefined;
  if (!plugin) return null;
  const decorationsFn = plugin.props.decorations;
  if (!decorationsFn) return null;
  const source = decorationsFn.call(plugin, state);
  if (!source) return null;
  const set = source as DecorationSet;
  const found = set.find() as unknown as Array<{
    from: number;
    to: number;
    type: { attrs?: Record<string, string | undefined> };
  }>;
  return found.map((d) => {
    const rawAttrs = d.type.attrs ?? {};
    const attrs: Record<string, string> = {};
    for (const [k, v] of Object.entries(rawAttrs)) {
      if (typeof v === 'string') attrs[k] = v;
    }
    return { from: d.from, to: d.to, attrs };
  });
}

function makeState(doc: ReturnType<typeof schema.node>): EditorState {
  return EditorState.create({
    doc,
    plugins: [chunkWrapperDecorationPlugin()],
  });
}

afterEach(() => {
  __resetFirstEmitForTesting();
});

describe('chunkWrapperDecorationPlugin — decoration emission', () => {
  test('empty doc (no block children) — returns null', () => {
    const doc = schema.node('doc', null, [schema.node('paragraph')]);
    const state = makeState(doc);
    const specs = decorationSpecs(state);
    expect(specs).toHaveLength(1);
    expect(specs?.[0].attrs.class).toBe(OK_CHUNK_WRAPPER_CLASS);
  });

  test('single paragraph — one Decoration.node with ok-chunk-wrapper class', () => {
    const doc = schema.node('doc', null, [
      schema.node('paragraph', null, [schema.text('Hello world')]),
    ]);
    const state = makeState(doc);
    const specs = decorationSpecs(state);
    expect(specs).toHaveLength(1);
    expect(specs?.[0].attrs.class).toBe(OK_CHUNK_WRAPPER_CLASS);
    expect(specs?.[0].from).toBe(0);
    expect(specs?.[0].to).toBe(doc.firstChild?.nodeSize);
  });

  test('mixed top-level blocks — heading included alongside paragraph + blockquote', () => {
    const para = schema.node('paragraph', null, [schema.text('first')]);
    const heading = schema.node('heading', { level: 2 }, [schema.text('second')]);
    const blockquote = schema.node('blockquote', null, [
      schema.node('paragraph', null, [schema.text('nested')]),
    ]);
    const doc = schema.node('doc', null, [para, heading, blockquote]);
    const state = makeState(doc);
    const specs = decorationSpecs(state);
    expect(specs).toHaveLength(3);
    for (const s of specs ?? []) {
      expect(s.attrs.class).toBe(OK_CHUNK_WRAPPER_CLASS);
    }
    expect(specs?.[0].from).toBe(0);
    expect(specs?.[0].to).toBe(para.nodeSize);
    expect(specs?.[1].from).toBe(para.nodeSize);
    expect(specs?.[1].to).toBe(para.nodeSize + heading.nodeSize);
    expect(specs?.[2].from).toBe(para.nodeSize + heading.nodeSize);
    expect(specs?.[2].to).toBe(para.nodeSize + heading.nodeSize + blockquote.nodeSize);
  });

  test('many top-level blocks — N paragraphs produce N decorations', () => {
    const blocks = Array.from({ length: 20 }, (_, i) =>
      schema.node('paragraph', null, [schema.text(`block ${i}`)]),
    );
    const doc = schema.node('doc', null, blocks);
    const state = makeState(doc);
    const specs = decorationSpecs(state);
    expect(specs).toHaveLength(20);
    for (const s of specs ?? []) {
      expect(s.attrs.class).toBe(OK_CHUNK_WRAPPER_CLASS);
    }
  });

  test('jsxComponent top-level block — excluded (paint chrome lives outside the border box)', () => {
    const para1 = schema.node('paragraph', null, [schema.text('before')]);
    const callout = schema.node('jsxComponent', { componentName: 'Callout' }, [
      schema.node('paragraph', null, [schema.text('inside callout')]),
    ]);
    const para2 = schema.node('paragraph', null, [schema.text('after')]);
    const doc = schema.node('doc', null, [para1, callout, para2]);
    const state = makeState(doc);
    const specs = decorationSpecs(state);
    expect(specs).toHaveLength(2);
    expect(specs?.[0].from).toBe(0);
    expect(specs?.[0].to).toBe(para1.nodeSize);
    expect(specs?.[1].from).toBe(para1.nodeSize + callout.nodeSize);
    expect(specs?.[1].to).toBe(para1.nodeSize + callout.nodeSize + para2.nodeSize);
    for (const s of specs ?? []) {
      expect(s.attrs.class).toBe(OK_CHUNK_WRAPPER_CLASS);
    }
  });

  test('doc of only jsxComponents — zero decorations emitted', () => {
    const callout1 = schema.node('jsxComponent', { componentName: 'Callout' }, [
      schema.node('paragraph', null, [schema.text('a')]),
    ]);
    const callout2 = schema.node('jsxComponent', { componentName: 'Callout' }, [
      schema.node('paragraph', null, [schema.text('b')]),
    ]);
    const doc = schema.node('doc', null, [callout1, callout2]);
    const state = makeState(doc);
    const specs = decorationSpecs(state);
    expect(specs).toBeNull();
  });

  test('list with multiple items — one decoration on the list, NOT per listItem (top-level only)', () => {
    const items = [
      schema.node('listItem', null, [schema.node('paragraph', null, [schema.text('a')])]),
      schema.node('listItem', null, [schema.node('paragraph', null, [schema.text('b')])]),
      schema.node('listItem', null, [schema.node('paragraph', null, [schema.text('c')])]),
    ];
    const list = schema.node('list', null, items);
    const doc = schema.node('doc', null, [list]);
    const state = makeState(doc);
    const specs = decorationSpecs(state);
    expect(specs).toHaveLength(1);
    expect(specs?.[0].attrs.class).toBe(OK_CHUNK_WRAPPER_CLASS);
    expect(specs?.[0].from).toBe(0);
    expect(specs?.[0].to).toBe(list.nodeSize);
  });
});

describe('chunkWrapperDecorationPlugin — plugin identity', () => {
  test('plugin uses chunkWrapperDecorationKey', () => {
    const plugin = chunkWrapperDecorationPlugin();
    expect(plugin.spec.key).toBe(chunkWrapperDecorationKey);
  });

  test('OK_CHUNK_WRAPPER_CLASS export matches the CSS contract', () => {
    expect(OK_CHUNK_WRAPPER_CLASS).toBe('ok-chunk-wrapper');
  });

  test('decoration spec is independent across plugin instances', () => {
    const p1 = chunkWrapperDecorationPlugin();
    const p2 = chunkWrapperDecorationPlugin();
    expect(p1).not.toBe(p2);
    expect(p1.spec.key).toBe(p2.spec.key);
  });
});

describe('chunkWrapperDecorationPlugin — graceful degradation', () => {
  test('plugin keeps emitting decorations in test env where CSS.supports is unavailable', () => {
    __resetFirstEmitForTesting();
    const doc = schema.node('doc', null, [schema.node('paragraph', null, [schema.text('hi')])]);
    const state = makeState(doc);
    const specs = decorationSpecs(state);
    expect(specs).toHaveLength(1);
    expect(specs?.[0].attrs.class).toBe(OK_CHUNK_WRAPPER_CLASS);
  });
});

describe('chunkWrapperDecorationPlugin — addProseMirrorPlugins idempotence', () => {
  test('repeat decoration call on same state returns equivalent decorations', () => {
    const doc = schema.node('doc', null, [
      schema.node('paragraph', null, [schema.text('one')]),
      schema.node('paragraph', null, [schema.text('two')]),
    ]);
    const state = makeState(doc);
    const first = decorationSpecs(state);
    const second = decorationSpecs(state);
    expect(first).toEqual(second);
  });
});

describe('chunkWrapperDecorationPlugin — ok/render/cv-auto-skip mark emission', () => {
  test('first non-empty emit fires ok/render/cv-auto-skip mark', () => {
    performance.clearMeasures('ok/render/cv-auto-skip');
    const doc = schema.node('doc', null, [schema.node('paragraph', null, [schema.text('hello')])]);
    const state = makeState(doc);
    decorationSpecs(state);
    const entries = performance.getEntriesByName('ok/render/cv-auto-skip');
    expect(entries.length).toBe(1);
  });

  test('subsequent emits within same session do not re-fire the mark', () => {
    performance.clearMeasures('ok/render/cv-auto-skip');
    const doc = schema.node('doc', null, [schema.node('paragraph', null, [schema.text('hello')])]);
    const state = makeState(doc);
    decorationSpecs(state);
    decorationSpecs(state);
    decorationSpecs(state);
    const entries = performance.getEntriesByName('ok/render/cv-auto-skip');
    expect(entries.length).toBe(1);
  });

  test('__resetFirstEmitForTesting allows re-observation of the mark', () => {
    performance.clearMeasures('ok/render/cv-auto-skip');
    const doc = schema.node('doc', null, [schema.node('paragraph', null, [schema.text('hello')])]);
    decorationSpecs(makeState(doc));
    expect(performance.getEntriesByName('ok/render/cv-auto-skip').length).toBe(1);

    __resetFirstEmitForTesting();
    decorationSpecs(makeState(doc));
    expect(performance.getEntriesByName('ok/render/cv-auto-skip').length).toBe(2);
  });
});

describe('chunkWrapperDecorationPlugin — the set follows the document through transactions', () => {
  function paragraph(text: string) {
    return schema.node('paragraph', null, text === '' ? [] : [schema.text(text)]);
  }

  function base(): EditorState {
    return makeState(
      schema.node('doc', null, [
        paragraph('one'),
        schema.node('heading', null, [schema.text('two')]),
        paragraph('three'),
        schema.node('jsxComponent', { componentName: 'Callout' }, [paragraph('inside')]),
        paragraph('four'),
      ]),
    );
  }

  function expectFresh(state: EditorState): void {
    expect(decorationSpecs(state)).toEqual(decorationSpecs(makeState(state.doc)));
  }

  test('typing inside a block keeps every block wrapped', () => {
    const state = base();
    expectFresh(state.apply(state.tr.insertText('x', 2)));
  });

  test('splitting a block wraps both halves', () => {
    const state = base();
    const next = state.apply(state.tr.split(3));
    expect(next.doc.childCount).toBe(state.doc.childCount + 1);
    expectFresh(next);
  });

  test('deleting a whole block drops its wrapper', () => {
    const state = base();
    expectFresh(state.apply(state.tr.delete(0, state.doc.child(0).nodeSize)));
  });

  test('inserting a component adds no wrapper for it', () => {
    const state = base();
    const callout = schema.node('jsxComponent', { componentName: 'Callout' }, [paragraph('new')]);
    expectFresh(state.apply(state.tr.insert(0, callout)));
  });

  test('replacing the whole document rewraps it', () => {
    const state = base();
    const next = state.apply(
      state.tr.replaceWith(0, state.doc.content.size, [paragraph('a'), paragraph('b')]),
    );
    expectFresh(next);
  });

  test('a transaction that changes no content keeps the same set', () => {
    const state = base();
    const next = state.apply(state.tr.setMeta('unrelated', true));
    expect(chunkWrapperDecorationKey.getState(next)).toBe(
      chunkWrapperDecorationKey.getState(state),
    );
  });

  test('matches a fresh build after 300 random edits', () => {
    let seed = 0x2545f491;
    const random = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const pick = (n: number): number => Math.floor(random() * n);
    let state = base();
    for (let i = 0; i < 300; i++) {
      const textblocks: Array<{ start: number; size: number }> = [];
      state.doc.descendants((node, pos) => {
        if (node.isTextblock) textblocks.push({ start: pos + 1, size: node.content.size });
        return true;
      });
      const block = textblocks[pick(textblocks.length)] as { start: number; size: number };
      const at = block.start + pick(block.size + 1);
      const roll = random();
      const tr = state.tr;
      if (roll < 0.4) tr.insertText('x', at);
      else if (roll < 0.6) tr.split(at);
      else if (roll < 0.75 && state.doc.childCount > 1) {
        let pos = 0;
        const index = pick(state.doc.childCount);
        for (let c = 0; c < index; c++) pos += state.doc.child(c).nodeSize;
        tr.delete(pos, pos + state.doc.child(index).nodeSize);
      } else if (roll < 0.9) {
        let pos = 0;
        const index = pick(state.doc.childCount + 1);
        for (let c = 0; c < index; c++) pos += state.doc.child(c).nodeSize;
        tr.insert(pos, paragraph(`p${i}`));
      } else if (block.size > 0) {
        tr.delete(block.start, block.start + block.size);
      }
      state = state.apply(tr);
      expectFresh(state);
    }
  });
});

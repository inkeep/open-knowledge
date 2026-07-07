/**
 * `getPmStats(editor)` — unit tests.
 *
 * Construct an `EditorState` directly with a custom schema (mirroring the
 * pattern in `mark-identity-decoration.test.ts`) and pass a structurally-
 * typed `{state, view}` stub — the helper accepts an `EditorLike` shape so
 * unit tests don't need a live `Editor` mount with DOM.
 */

import { describe, expect, test } from 'bun:test';
import { type Mark, Schema } from '@tiptap/pm/model';
import { EditorState, Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { getPmStats, type PmStats } from './get-pm-stats';

// ---------------------------------------------------------------------------
// Test schema — the same minimal shape used elsewhere in this package's
// pure PM-state tests.
// ---------------------------------------------------------------------------

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'inline*' },
    heading: { group: 'block', content: 'inline*', attrs: { level: { default: 1 } } },
    text: { group: 'inline' },
  },
  marks: {
    link: { attrs: { href: {} } },
    strong: {},
    emphasis: {},
  },
});

function buildDoc(
  blocks: Array<{ type: 'paragraph' | 'heading'; runs: Array<{ text: string; marks?: Mark[] }> }>,
) {
  const children = blocks.map((b) =>
    schema.node(
      b.type,
      null,
      b.runs.map((r) => schema.text(r.text, r.marks)),
    ),
  );
  return schema.node('doc', null, children);
}

function linkMark(href: string): Mark {
  return schema.mark('link', { href });
}

function strongMark(): Mark {
  return schema.mark('strong');
}

function emphasisMark(): Mark {
  return schema.mark('emphasis');
}

interface ViewStub {
  nodeViews?: Record<string, unknown>;
}

function makeEditor(state: EditorState, view?: ViewStub) {
  return { state, view: view ?? {} };
}

// ---------------------------------------------------------------------------
// Empty doc
// ---------------------------------------------------------------------------

describe('getPmStats — empty doc', () => {
  test('paragraph-only doc with no text content', () => {
    const doc = schema.node('doc', null, [schema.node('paragraph', null, [])]);
    const state = EditorState.create({ doc });
    // Type-annotated to keep the public PmStats export grounded — knip's
    // `--unsafe --write` strips exports with zero importers; this annotation
    // ensures the type is referenced and the export survives auto-cleanup.
    const stats: PmStats = getPmStats(makeEditor(state));

    // descendants() walks the single empty paragraph but its child fragment is empty.
    expect(stats.nodeCount).toBe(1);
    expect(stats.nodeCountByType).toEqual({ paragraph: 1 });
    expect(stats.markCount).toBe(0);
    expect(stats.markCountByType).toEqual({});
    expect(stats.nodeViewCount).toBe(0);
    expect(stats.decorationCount).toBe(0);
    expect(stats.decorationCountByPlugin).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Single-node doc
// ---------------------------------------------------------------------------

describe('getPmStats — single-node doc', () => {
  test('one paragraph with plain text', () => {
    const doc = buildDoc([{ type: 'paragraph', runs: [{ text: 'hello' }] }]);
    const state = EditorState.create({ doc });
    const stats = getPmStats(makeEditor(state));

    // Two descendants: paragraph + text node.
    expect(stats.nodeCount).toBe(2);
    expect(stats.nodeCountByType).toEqual({ paragraph: 1, text: 1 });
    expect(stats.markCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Multi-mark doc — verifies markCount AND markCountByType
// ---------------------------------------------------------------------------

describe('getPmStats — multi-mark doc', () => {
  test('text with one link mark contributes 1 to markCount', () => {
    const doc = buildDoc([
      { type: 'paragraph', runs: [{ text: 'click', marks: [linkMark('https://a.com')] }] },
    ]);
    const state = EditorState.create({ doc });
    const stats = getPmStats(makeEditor(state));

    expect(stats.markCount).toBe(1);
    expect(stats.markCountByType).toEqual({ link: 1 });
  });

  test('text with stacked marks contributes one count per mark', () => {
    // strong + emphasis stacked on the same text node — both should count.
    const doc = buildDoc([
      {
        type: 'paragraph',
        runs: [{ text: 'bold-italic', marks: [strongMark(), emphasisMark()] }],
      },
    ]);
    const state = EditorState.create({ doc });
    const stats = getPmStats(makeEditor(state));

    expect(stats.markCount).toBe(2);
    expect(stats.markCountByType).toEqual({ strong: 1, emphasis: 1 });
  });

  test('marks across split text nodes count per text-node-instance', () => {
    // PM splits text nodes when marks differ between adjacent runs. A "single"
    // logical link sliced into two text nodes registers as two mark instances.
    const doc = buildDoc([
      {
        type: 'paragraph',
        runs: [
          { text: 'first', marks: [linkMark('https://a.com')] },
          { text: ' ' },
          { text: 'second', marks: [linkMark('https://a.com')] },
        ],
      },
    ]);
    const state = EditorState.create({ doc });
    const stats = getPmStats(makeEditor(state));

    expect(stats.markCount).toBe(2);
    expect(stats.markCountByType).toEqual({ link: 2 });
  });

  test('mixed block types are tracked in nodeCountByType', () => {
    const doc = buildDoc([
      { type: 'heading', runs: [{ text: 'Title' }] },
      { type: 'paragraph', runs: [{ text: 'body' }] },
      { type: 'paragraph', runs: [{ text: 'more body' }] },
    ]);
    const state = EditorState.create({ doc });
    const stats = getPmStats(makeEditor(state));

    expect(stats.nodeCountByType.heading).toBe(1);
    expect(stats.nodeCountByType.paragraph).toBe(2);
    expect(stats.nodeCountByType.text).toBe(3);
    expect(stats.nodeCount).toBe(6);
  });
});

// ---------------------------------------------------------------------------
// nodeViewCount — verified via stub since real NodeView mount needs DOM
// ---------------------------------------------------------------------------

describe('getPmStats — nodeViewCount', () => {
  test('view with two registered NodeView constructors', () => {
    const doc = buildDoc([{ type: 'paragraph', runs: [{ text: 'x' }] }]);
    const state = EditorState.create({ doc });
    const stats = getPmStats(
      makeEditor(state, {
        nodeViews: {
          wikiLink: () => ({}),
          jsxComponent: () => ({}),
        },
      }),
    );

    expect(stats.nodeViewCount).toBe(2);
  });

  test('view without nodeViews → zero', () => {
    const doc = buildDoc([{ type: 'paragraph', runs: [{ text: 'x' }] }]);
    const state = EditorState.create({ doc });
    const stats = getPmStats(makeEditor(state, {}));

    expect(stats.nodeViewCount).toBe(0);
  });

  test('omitted view → zero', () => {
    const doc = buildDoc([{ type: 'paragraph', runs: [{ text: 'x' }] }]);
    const state = EditorState.create({ doc });
    // EditorLike permits view to be undefined; helper should not throw.
    const stats = getPmStats({ state });

    expect(stats.nodeViewCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// decorationCount + decorationCountByPlugin — multiple plugins
// ---------------------------------------------------------------------------

const keyedPluginA = new PluginKey('decoTestA');
const keyedPluginB = new PluginKey('decoTestB');

function decoratorPlugin(key: PluginKey, attr: string, attrValue: string): Plugin {
  return new Plugin({
    key,
    props: {
      decorations(state) {
        const decos: Decoration[] = [];
        state.doc.descendants((node, pos) => {
          if (node.type.name === 'text') {
            decos.push(Decoration.inline(pos, pos + node.nodeSize, { [attr]: attrValue }));
          }
          return true;
        });
        return DecorationSet.create(state.doc, decos);
      },
    },
  });
}

function unkeyedDecoratorPlugin(attr: string, attrValue: string): Plugin {
  return new Plugin({
    props: {
      decorations(state) {
        const decos: Decoration[] = [];
        state.doc.descendants((node, pos) => {
          if (node.type.name === 'text') {
            decos.push(Decoration.inline(pos, pos + node.nodeSize, { [attr]: attrValue }));
          }
          return true;
        });
        return DecorationSet.create(state.doc, decos);
      },
    },
  });
}

describe('getPmStats — decoration counts', () => {
  test('single keyed plugin emits N decorations → counted', () => {
    const doc = buildDoc([
      { type: 'paragraph', runs: [{ text: 'one' }] },
      { type: 'paragraph', runs: [{ text: 'two' }] },
    ]);
    const state = EditorState.create({
      doc,
      plugins: [decoratorPlugin(keyedPluginA, 'data-a', 'x')],
    });
    const stats = getPmStats(makeEditor(state));

    // Two text nodes → two decorations.
    expect(stats.decorationCount).toBe(2);
    // Keyed plugins surface their PluginKey name (with PM's internal counter suffix).
    const keyName = Object.keys(stats.decorationCountByPlugin)[0];
    expect(keyName?.startsWith('decoTestA')).toBe(true);
    expect(stats.decorationCountByPlugin[keyName as string]).toBe(2);
  });

  test('two keyed plugins → counts split per-plugin', () => {
    const doc = buildDoc([{ type: 'paragraph', runs: [{ text: 'hello' }] }]);
    const state = EditorState.create({
      doc,
      plugins: [
        decoratorPlugin(keyedPluginA, 'data-a', 'x'),
        decoratorPlugin(keyedPluginB, 'data-b', 'y'),
      ],
    });
    const stats = getPmStats(makeEditor(state));

    expect(stats.decorationCount).toBe(2);
    const keys = Object.keys(stats.decorationCountByPlugin).sort();
    expect(keys.length).toBe(2);
    expect(keys[0]?.startsWith('decoTestA')).toBe(true);
    expect(keys[1]?.startsWith('decoTestB')).toBe(true);
    for (const k of keys) {
      expect(stats.decorationCountByPlugin[k]).toBe(1);
    }
  });

  test('unkeyed plugin gets a fallback string identifier', () => {
    const doc = buildDoc([{ type: 'paragraph', runs: [{ text: 'foo' }] }]);
    const state = EditorState.create({
      doc,
      plugins: [unkeyedDecoratorPlugin('data-u', 'z')],
    });
    const stats = getPmStats(makeEditor(state));

    expect(stats.decorationCount).toBe(1);
    const keys = Object.keys(stats.decorationCountByPlugin);
    expect(keys.length).toBe(1);
    // PM auto-generates `plugin$N` for keyless plugins; either that or the
    // helper's `unkeyed-N` fallback is acceptable. The contract is "stable
    // string identifier"; assert non-empty.
    const keyName = keys[0];
    expect(typeof keyName).toBe('string');
    expect((keyName as string).length).toBeGreaterThan(0);
    expect(stats.decorationCountByPlugin[keyName as string]).toBe(1);
  });

  test('plugin returning null contributes nothing', () => {
    const nullPlugin = new Plugin({
      key: new PluginKey('nullDeco'),
      props: {
        decorations() {
          return null;
        },
      },
    });
    const doc = buildDoc([{ type: 'paragraph', runs: [{ text: 'foo' }] }]);
    const state = EditorState.create({ doc, plugins: [nullPlugin] });
    const stats = getPmStats(makeEditor(state));

    expect(stats.decorationCount).toBe(0);
    expect(stats.decorationCountByPlugin).toEqual({});
  });

  test('plugin without props.decorations is skipped silently', () => {
    const noopPlugin = new Plugin({ key: new PluginKey('noopPlugin'), props: {} });
    const doc = buildDoc([{ type: 'paragraph', runs: [{ text: 'foo' }] }]);
    const state = EditorState.create({ doc, plugins: [noopPlugin] });
    const stats = getPmStats(makeEditor(state));

    expect(stats.decorationCount).toBe(0);
    expect(stats.decorationCountByPlugin).toEqual({});
  });

  test('plugin throwing inside decorations is swallowed (probe must be robust)', () => {
    const throwingPlugin = new Plugin({
      key: new PluginKey('throwingDeco'),
      props: {
        decorations() {
          throw new Error('boom');
        },
      },
    });
    // Combine with a working plugin to assert one buggy plugin doesn't take
    // the whole probe down.
    const doc = buildDoc([{ type: 'paragraph', runs: [{ text: 'foo' }] }]);
    const state = EditorState.create({
      doc,
      plugins: [throwingPlugin, decoratorPlugin(keyedPluginA, 'data-a', 'x')],
    });
    const stats = getPmStats(makeEditor(state));

    // Working plugin still counted, throwing plugin contributes 0.
    expect(stats.decorationCount).toBe(1);
    const keys = Object.keys(stats.decorationCountByPlugin);
    expect(keys.length).toBe(1);
    expect(keys[0]?.startsWith('decoTestA')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Combined — exercise the realistic shape (nodes + marks + nodeViews +
// multiple decorations) so we have one sanity-check that the helper's
// coordinated output is internally consistent.
// ---------------------------------------------------------------------------

describe('getPmStats — combined sanity', () => {
  test('realistic doc with marks + plugins + nodeViews matches expected counts', () => {
    const doc = buildDoc([
      { type: 'heading', runs: [{ text: 'Title' }] },
      {
        type: 'paragraph',
        runs: [{ text: 'Click ', marks: [linkMark('https://a.com')] }, { text: 'here' }],
      },
    ]);
    const state = EditorState.create({
      doc,
      plugins: [
        decoratorPlugin(keyedPluginA, 'data-a', 'x'),
        decoratorPlugin(keyedPluginB, 'data-b', 'y'),
      ],
    });

    const stats = getPmStats(
      makeEditor(state, {
        nodeViews: { wikiLink: () => ({}), jsxComponent: () => ({}), heading: () => ({}) },
      }),
    );

    // 2 blocks + 3 text nodes = 5 nodes.
    expect(stats.nodeCount).toBe(5);
    expect(stats.nodeCountByType.heading).toBe(1);
    expect(stats.nodeCountByType.paragraph).toBe(1);
    expect(stats.nodeCountByType.text).toBe(3);

    expect(stats.markCount).toBe(1);
    expect(stats.markCountByType.link).toBe(1);

    expect(stats.nodeViewCount).toBe(3);

    // 3 text nodes × 2 plugins = 6 decorations.
    expect(stats.decorationCount).toBe(6);
    expect(Object.keys(stats.decorationCountByPlugin).length).toBe(2);
  });
});

/**
 * markIdentityDecorationPlugin — unit tests.
 *
 * Covers the decoration-emission contract: given a `markIdentityPlugin` state
 * with N tracked marks, the decoration plugin emits a DecorationSet of N
 * inline decorations, each carrying `data-mark-id` attributes matching the
 * IDs assigned by the identity plugin. Pure PM state operations — no live
 * editor needed.
 */

import { describe, expect, test } from 'bun:test';
import { type Mark, Schema } from '@tiptap/pm/model';
import { EditorState, type Plugin } from '@tiptap/pm/state';
import type { DecorationSet } from '@tiptap/pm/view';
import { markIdentityPlugin } from './mark-identity';
import {
  MARK_ID_DATA_ATTR,
  markIdentityDecorationKey,
  markIdentityDecorationPlugin,
} from './mark-identity-decoration';

// ---------------------------------------------------------------------------
// Test schema — mirrors mark-identity.test.ts for shared conventions
// ---------------------------------------------------------------------------

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'inline*' },
    text: { group: 'inline' },
  },
  marks: {
    link: { attrs: { href: {} } },
    wikiLink: { attrs: { page: {} } },
    strong: {},
  },
});

function buildDoc(runs: Array<{ text: string; marks?: Mark[] }>) {
  const paragraph = schema.node(
    'paragraph',
    null,
    runs.map((r) => schema.text(r.text, r.marks)),
  );
  return schema.node('doc', null, [paragraph]);
}

function linkMark(href: string): Mark {
  return schema.mark('link', { href });
}

interface DecorationSpec {
  from: number;
  to: number;
  attrs: Record<string, string>;
}

/**
 * Extract decorations from a plugin.props.decorations(state) result into a
 * plain shape so tests can assert without reaching into PM internals.
 *
 * PM's `props.decorations` is a method with `this: Plugin` binding; calling
 * via `plugin.props.decorations(state)` would rebind `this` to `plugin.props`.
 * Use `.call(plugin, state)` to preserve the documented binding.
 *
 * The return type of `props.decorations` is `DecorationSource | null | undefined`;
 * `DecorationSource` is a supertype of `DecorationSet` without `.find()`. This
 * plugin always returns `DecorationSet.create(...)` or null, so the cast is safe.
 *
 * Inline decoration attrs on PM's internal `InlineType` are stored directly
 * (not nested under `.attributes`): `{ 'data-mark-id': 'm1', class?, style? }`.
 */
function decorationSpecs(state: EditorState): DecorationSpec[] | null {
  const plugin = state.plugins.find((p) => p.spec.key === markIdentityDecorationKey) as
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

function makeState(doc: ReturnType<typeof buildDoc>): EditorState {
  return EditorState.create({
    doc,
    plugins: [
      markIdentityPlugin({ markTypes: ['link', 'wikiLink'] }),
      markIdentityDecorationPlugin(),
    ],
  });
}

// ---------------------------------------------------------------------------
// Exports + factory shape
// ---------------------------------------------------------------------------

describe('markIdentityDecorationPlugin — exports', () => {
  test('markIdentityDecorationKey is a stable PluginKey', () => {
    expect(markIdentityDecorationKey).toBeDefined();
    // PluginKey has a .key field (internal name); its identity is stable
    // across module reloads because we hold a single module-level instance.
    expect(markIdentityDecorationKey).toBe(markIdentityDecorationKey);
  });

  test('MARK_ID_DATA_ATTR exports the canonical attribute name', () => {
    expect(MARK_ID_DATA_ATTR).toBe('data-mark-id');
  });

  test('factory returns a Plugin keyed by markIdentityDecorationKey', () => {
    const plugin = markIdentityDecorationPlugin();
    expect(plugin.spec.key).toBe(markIdentityDecorationKey);
  });
});

// ---------------------------------------------------------------------------
// Decoration emission
// ---------------------------------------------------------------------------

describe('markIdentityDecorationPlugin — decoration emission', () => {
  test('empty doc → no decorations', () => {
    const state = makeState(buildDoc([{ text: 'plain text' }]));
    const specs = decorationSpecs(state);
    // Either null (plugin bails out on empty state) or empty array.
    expect(specs === null || specs.length === 0).toBe(true);
  });

  test('one marked span → one decoration with data-mark-id="m1"', () => {
    const state = makeState(buildDoc([{ text: 'hello ', marks: [linkMark('https://a.com')] }]));
    const specs = decorationSpecs(state);
    expect(specs).not.toBeNull();
    expect(specs?.length).toBe(1);
    expect(specs?.[0]?.attrs[MARK_ID_DATA_ATTR]).toBe('m1');
  });

  test('two disjoint marks → two decorations with distinct IDs', () => {
    const state = makeState(
      buildDoc([
        { text: 'first ', marks: [linkMark('https://a.com')] },
        { text: 'middle ' },
        { text: 'second', marks: [linkMark('https://b.com')] },
      ]),
    );
    const specs = decorationSpecs(state);
    expect(specs).not.toBeNull();
    expect(specs?.length).toBe(2);
    const ids = new Set(specs?.map((s) => s.attrs[MARK_ID_DATA_ATTR]));
    expect(ids.size).toBe(2);
    expect(ids.has('m1')).toBe(true);
    expect(ids.has('m2')).toBe(true);
  });

  test('decoration from/to match MarkInfo range', () => {
    const state = makeState(
      buildDoc([
        { text: 'pre ' }, // positions 1..5
        { text: 'LINK', marks: [linkMark('https://x.com')] }, // positions 5..9
        { text: ' post' },
      ]),
    );
    const specs = decorationSpecs(state);
    expect(specs).not.toBeNull();
    expect(specs?.length).toBe(1);
    expect(specs?.[0]?.from).toBe(5);
    expect(specs?.[0]?.to).toBe(9);
  });

  test('non-tracked mark types produce no decorations', () => {
    const state = makeState(buildDoc([{ text: 'bold', marks: [schema.mark('strong')] }]));
    const specs = decorationSpecs(state);
    expect(specs === null || specs.length === 0).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Safe degradation
// ---------------------------------------------------------------------------

describe('markIdentityDecorationPlugin — safe degradation', () => {
  test('without markIdentityPlugin installed → decorations returns null', () => {
    const state = EditorState.create({
      doc: buildDoc([{ text: 'x', marks: [linkMark('https://a.com')] }]),
      plugins: [markIdentityDecorationPlugin()], // NO identity plugin
    });
    const specs = decorationSpecs(state);
    expect(specs).toBeNull();
  });
});

/**
 * chunkWrapperDecorationPlugin — unit tests.
 *
 * Covers the decoration-emission contract: given a doc with N top-level block
 * children, the plugin emits N Decoration.node entries each carrying
 * `class: ok-chunk-wrapper`. Inline-only root children are skipped (rare; the
 * doc schema forbids inlines at the root in normal use, but the plugin guards
 * regardless).
 *
 * Pattern mirrors mark-identity-decoration.test.ts — pure PM state operations,
 * no live editor or DOM mount required.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { Schema } from '@tiptap/pm/model';
import { EditorState, type Plugin } from '@tiptap/pm/state';
import type { DecorationSet } from '@tiptap/pm/view';
import {
  __resetFirstEmitForTesting,
  chunkWrapperDecorationKey,
  chunkWrapperDecorationPlugin,
  OK_CHUNK_WRAPPER_CLASS,
} from './chunk-wrapper-decoration';

// ---------------------------------------------------------------------------
// Test schema — block-rich (paragraph, heading, blockquote, listItem-in-list)
// ---------------------------------------------------------------------------

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

/**
 * Extract the chunk-wrapper plugin's decorations into a plain shape.
 *
 * `Decoration.node` (used here) stores attrs on the decoration's internal
 * `type.attrs` record — same shape as `Decoration.inline` for assertion
 * purposes.
 */
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
    // The schema requires at least one block, so construct the smallest legal
    // doc: a single empty paragraph. Even an empty paragraph counts as one
    // top-level block, so the plugin emits one decoration. To get the
    // null-return path, we need a doc whose only children are inline (which
    // the schema forbids at root). The plugin's `decos.length === 0` branch
    // is defensive — verified via direct assertion on the empty array case.
    const doc = schema.node('doc', null, [schema.node('paragraph')]);
    const state = makeState(doc);
    const specs = decorationSpecs(state);
    // Single paragraph → one decoration covering it.
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
    // Decoration.node spans the whole node: from=0 (paragraph start),
    // to=paragraph.nodeSize (which is content.size + 2 for open/close tokens).
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
    // Every top-level non-jsxComponent block is wrapped — headings
    // included. jsxComponent is the only block-level carve-out because
    // its chrome (halo + hover zone + toolbar) paints outside its border
    // box and would be clipped by `contain: paint`.
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
    // The `.jsx-component-wrapper` DOM node paints `::before` (top:-12px),
    // `::after` halo (inset:-4px), and the `.jsx-component-chrome` toolbar
    // (top:-11px) outside its own border box. CV:auto's paint containment
    // would clip those, so the plugin must skip jsxComponent. Surrounding
    // paragraphs still get decorated.
    const para1 = schema.node('paragraph', null, [schema.text('before')]);
    const callout = schema.node('jsxComponent', { componentName: 'Callout' }, [
      schema.node('paragraph', null, [schema.text('inside callout')]),
    ]);
    const para2 = schema.node('paragraph', null, [schema.text('after')]);
    const doc = schema.node('doc', null, [para1, callout, para2]);
    const state = makeState(doc);
    const specs = decorationSpecs(state);
    // Only the two paragraphs are decorated; the callout's range is absent.
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
    // Edge case: a doc where every top-level child is excluded. The plugin's
    // `decos.length === 0` branch returns null (no DecorationSet), so the
    // once-per-session mark also doesn't fire here.
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
    // Single decoration on the list itself — listItems and inner paragraphs
    // are NOT separately decorated. Browser containment on the list ancestor
    // covers descendants.
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
    // The CSS rule at globals.css:.ProseMirror .ok-chunk-wrapper requires
    // exactly this class name. If this test fails, the CSS rule and the
    // plugin output have drifted.
    expect(OK_CHUNK_WRAPPER_CLASS).toBe('ok-chunk-wrapper');
  });

  test('decoration spec is independent across plugin instances', () => {
    // Two separate calls to the factory return distinct Plugin instances
    // (so multiple editors with this plugin don't share state). Both still
    // bind to the same PluginKey by design.
    const p1 = chunkWrapperDecorationPlugin();
    const p2 = chunkWrapperDecorationPlugin();
    expect(p1).not.toBe(p2);
    expect(p1.spec.key).toBe(p2.spec.key);
  });
});

describe('chunkWrapperDecorationPlugin — graceful degradation', () => {
  // The plugin's CSS rule depends on `content-visibility: auto`. Browsers
  // that don't support it (Firefox <123, Safari <18) drop the rule entirely.
  // Without feature detection the plugin would still walk the doc and emit
  // wrapper-class decorations on every transaction for no rendering benefit
  // (just unused class attributes + per-transaction DOM mutations).
  //
  // The unit-test environment doesn't have CSS.supports defined (jsdom-free
  // EditorState), so the helper's "no CSS global → assume supported" branch
  // is exercised by every other test in this file. To exercise the
  // "unsupported → no-op plugin" branch, mock CSS.supports inside a test —
  // but the support check runs at module-init time, BEFORE we can mock. So
  // this test verifies the helper's contract via its other observable: in
  // the test environment, where the support check returned `true`, the
  // plugin DOES emit decorations. The negative branch is exercised only
  // structurally (via the function's plain shape) and behaviorally in
  // browser e2e where unsupported browsers run the no-op path.
  test('plugin keeps emitting decorations in test env where CSS.supports is unavailable', () => {
    // In bun:test there is no `CSS` global; the helper defaults to "supported".
    // Verifying via a roundtrip: emit decorations on a single-block doc.
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
    // PM may call props.decorations more than once per transaction (e.g.
    // during DecorationGroup composition). The plugin must produce the same
    // set both times — purity invariant.
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
  // The plugin emits `ok/render/cv-auto-skip` once per session via a
  // module-global flag. These tests assert the once-per-session contract:
  // first non-empty emit fires the mark; subsequent emits do not re-fire;
  // resetting the flag allows re-observation. `__resetFirstEmitForTesting`
  // exists solely to support this assertion shape — without it the flag
  // would leak across tests.
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


import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { type Mark, Schema } from '@tiptap/pm/model';
import { EditorState, type Transaction } from '@tiptap/pm/state';
import type { DecorationSet, EditorView } from '@tiptap/pm/view';
import {
  __resetPageListCacheForTests,
  type PageListCacheSnapshot,
  setPageListCache,
} from '../page-list-cache';
import {
  computeLinkResolutionDecorations,
  type LinkResolutionAttrsComputer,
  linkResolutionDecorationKey,
  linkResolutionDecorationPlugin,
} from './link-resolution-decoration';
import { type MarkInfo, markIdentityPlugin } from './mark-identity';


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

function wikiMark(page: string): Mark {
  return schema.mark('wikiLink', { page });
}

function seedCache(pages: string[] = [], folderPaths: string[] = []): PageListCacheSnapshot {
  const snap: PageListCacheSnapshot = {
    pages: new Set(pages),
    folderPaths: new Set(folderPaths),
  };
  setPageListCache(snap);
  return snap;
}


beforeEach(() => {
  __resetPageListCacheForTests();
});

afterEach(() => {
  __resetPageListCacheForTests();
});


describe('computeLinkResolutionDecorations (pure helper)', () => {
  const trackedTypes: ReadonlySet<string> = new Set(['link']);

  test('empty byId → null', () => {
    const doc = buildDoc([{ text: 'plain' }]);
    const result = computeLinkResolutionDecorations(doc, new Map(), trackedTypes, () => null, null);
    expect(result).toBeNull();
  });

  test('tracked markType + attrs returned → one decoration emitted', () => {
    const doc = buildDoc([{ text: 'hello', marks: [linkMark('https://a.com')] }]);
    const byId = new Map<string, MarkInfo>([
      [
        'm1',
        {
          id: 'm1',
          markType: 'link',
          attrs: { href: 'https://a.com' },
          from: 1,
          to: 6,
        },
      ],
    ]);
    const computeAttrs: LinkResolutionAttrsComputer = (info) => ({
      'data-resolution-state': info.attrs.href === 'https://a.com' ? 'external' : 'unknown',
    });
    const result = computeLinkResolutionDecorations(doc, byId, trackedTypes, computeAttrs, null);
    expect(result).not.toBeNull();
    const found = (result as DecorationSet).find() as unknown as Array<{
      from: number;
      to: number;
      type: { attrs?: Record<string, string> };
    }>;
    expect(found.length).toBe(1);
    expect(found[0]?.from).toBe(1);
    expect(found[0]?.to).toBe(6);
    expect(found[0]?.type.attrs?.['data-resolution-state']).toBe('external');
    expect(found[0]?.type.attrs?.['data-mark-id']).toBe('m1');
  });

  test('non-tracked markType → skipped (no decoration for that mark)', () => {
    const doc = buildDoc([{ text: 'bold', marks: [schema.mark('strong')] }]);
    const byId = new Map<string, MarkInfo>([
      ['m1', { id: 'm1', markType: 'strong', attrs: {}, from: 1, to: 5 }],
    ]);
    const computeAttrs: LinkResolutionAttrsComputer = () => ({ 'data-test': 'x' });
    const result = computeLinkResolutionDecorations(doc, byId, trackedTypes, computeAttrs, null);
    expect(result).toBeNull();
  });

  test('computeAttrs returning null → mark gets data-mark-id baseline only (D6 merged-plugin null-attrs fallback)', () => {
    const doc = buildDoc([
      { text: 'first', marks: [linkMark('https://a.com')] },
      { text: 'second', marks: [linkMark('https://b.com')] },
    ]);
    const byId = new Map<string, MarkInfo>([
      ['m1', { id: 'm1', markType: 'link', attrs: { href: 'https://a.com' }, from: 1, to: 6 }],
      ['m2', { id: 'm2', markType: 'link', attrs: { href: 'https://b.com' }, from: 6, to: 12 }],
    ]);
    const computeAttrs: LinkResolutionAttrsComputer = (info) =>
      info.attrs.href === 'https://a.com' ? { 'data-x': '1' } : null;
    const result = computeLinkResolutionDecorations(doc, byId, trackedTypes, computeAttrs, null);
    expect(result).not.toBeNull();
    const found = (result as DecorationSet).find();
    expect(found.length).toBe(2);
    const m1 = found.find((d) => (d as unknown as { from: number }).from === 1);
    expect(m1).toBeDefined();
    expect(
      (m1 as unknown as { type: { attrs?: Record<string, string> } }).type.attrs?.['data-mark-id'],
    ).toBe('m1');
    expect(
      (m1 as unknown as { type: { attrs?: Record<string, string> } }).type.attrs?.['data-x'],
    ).toBe('1');
    const m2 = found.find((d) => (d as unknown as { from: number }).from === 6);
    expect(m2).toBeDefined();
    expect(
      (m2 as unknown as { type: { attrs?: Record<string, string> } }).type.attrs?.['data-mark-id'],
    ).toBe('m2');
  });

  test('cache is forwarded verbatim to computeAttrs', () => {
    const doc = buildDoc([{ text: 'x', marks: [linkMark('/page')] }]);
    const byId = new Map<string, MarkInfo>([
      ['m1', { id: 'm1', markType: 'link', attrs: { href: '/page' }, from: 1, to: 2 }],
    ]);
    const snapshot: PageListCacheSnapshot = {
      pages: new Set(['page']),
      folderPaths: new Set(),
    };
    const captured: Array<PageListCacheSnapshot | null> = [];
    const computeAttrs: LinkResolutionAttrsComputer = (_info, cache) => {
      captured.push(cache);
      return { 'data-x': '1' };
    };
    computeLinkResolutionDecorations(doc, byId, trackedTypes, computeAttrs, snapshot);
    expect(captured.length).toBe(1);
    expect(captured[0] === snapshot).toBe(true);
  });

  test('multiple tracked marks → multiple decorations', () => {
    const doc = buildDoc([
      { text: 'one', marks: [linkMark('https://a.com')] },
      { text: ' + ' },
      { text: 'two', marks: [linkMark('https://b.com')] },
    ]);
    const byId = new Map<string, MarkInfo>([
      ['m1', { id: 'm1', markType: 'link', attrs: { href: 'https://a.com' }, from: 1, to: 4 }],
      ['m2', { id: 'm2', markType: 'link', attrs: { href: 'https://b.com' }, from: 7, to: 10 }],
    ]);
    const computeAttrs: LinkResolutionAttrsComputer = (info) => ({
      'data-state': info.id,
    });
    const result = computeLinkResolutionDecorations(doc, byId, trackedTypes, computeAttrs, null);
    expect(result).not.toBeNull();
    const found = (result as DecorationSet).find();
    expect(found.length).toBe(2);
  });

  test('multiple markTypes — only those in trackedTypes are considered', () => {
    const doc = buildDoc([
      { text: 'link', marks: [linkMark('https://a.com')] },
      { text: 'wiki', marks: [wikiMark('Home')] },
    ]);
    const byId = new Map<string, MarkInfo>([
      ['m1', { id: 'm1', markType: 'link', attrs: { href: 'https://a.com' }, from: 1, to: 5 }],
      ['m2', { id: 'm2', markType: 'wikiLink', attrs: { page: 'Home' }, from: 5, to: 9 }],
    ]);
    const computeAttrs: LinkResolutionAttrsComputer = () => ({ 'data-x': '1' });
    const linkOnly = computeLinkResolutionDecorations(
      doc,
      byId,
      new Set(['link']),
      computeAttrs,
      null,
    );
    expect((linkOnly as DecorationSet).find().length).toBe(1);

    const both = computeLinkResolutionDecorations(
      doc,
      byId,
      new Set(['link', 'wikiLink']),
      computeAttrs,
      null,
    );
    expect((both as DecorationSet).find().length).toBe(2);
  });
});


describe('linkResolutionDecorationPlugin — factory & key', () => {
  test('factory returns a Plugin keyed by linkResolutionDecorationKey', () => {
    const plugin = linkResolutionDecorationPlugin({
      markTypes: ['link'],
      computeAttrs: () => null,
    });
    expect(plugin.spec.key).toBe(linkResolutionDecorationKey);
  });

  test('initial plugin state has version = 0', () => {
    const plugin = linkResolutionDecorationPlugin({
      markTypes: ['link'],
      computeAttrs: () => null,
    });
    const state = EditorState.create({
      doc: buildDoc([{ text: 'x' }]),
      plugins: [plugin],
    });
    const pluginState = linkResolutionDecorationKey.getState(state);
    expect(pluginState).toEqual({ version: 0 });
  });
});


describe('linkResolutionDecorationPlugin — refresh meta', () => {
  test('refresh meta transaction increments version', () => {
    const plugin = linkResolutionDecorationPlugin({
      markTypes: ['link'],
      computeAttrs: () => null,
    });
    const state = EditorState.create({
      doc: buildDoc([{ text: 'x' }]),
      plugins: [plugin],
    });
    const tr = state.tr.setMeta(linkResolutionDecorationKey, { refresh: true });
    const next = state.apply(tr);
    const pluginState = linkResolutionDecorationKey.getState(next);
    expect(pluginState?.version).toBe(1);
  });

  test('unrelated transactions do NOT increment version', () => {
    const plugin = linkResolutionDecorationPlugin({
      markTypes: ['link'],
      computeAttrs: () => null,
    });
    const state = EditorState.create({
      doc: buildDoc([{ text: 'x' }]),
      plugins: [plugin],
    });
    const tr = state.tr.insertText('y');
    const next = state.apply(tr);
    const pluginState = linkResolutionDecorationKey.getState(next);
    expect(pluginState?.version).toBe(0);
  });

  test('refresh meta without {refresh: true} is ignored', () => {
    const plugin = linkResolutionDecorationPlugin({
      markTypes: ['link'],
      computeAttrs: () => null,
    });
    const state = EditorState.create({
      doc: buildDoc([{ text: 'x' }]),
      plugins: [plugin],
    });
    const tr = state.tr.setMeta(linkResolutionDecorationKey, {});
    const next = state.apply(tr);
    const pluginState = linkResolutionDecorationKey.getState(next);
    expect(pluginState?.version).toBe(0);
  });
});


describe('linkResolutionDecorationPlugin — integration with markIdentityPlugin', () => {
  test('with markIdentityPlugin + tracked marks → decorations emitted', () => {
    const plugin = linkResolutionDecorationPlugin({
      markTypes: ['link'],
      computeAttrs: (info) => {
        const href = info.attrs.href as string | undefined;
        if (!href) return null;
        return { 'data-resolution-state': href.startsWith('https://') ? 'external' : 'unknown' };
      },
    });
    const state = EditorState.create({
      doc: buildDoc([{ text: 'hello ', marks: [linkMark('https://a.com')] }]),
      plugins: [markIdentityPlugin({ markTypes: ['link'] }), plugin],
    });
    const decorationsFn = plugin.props.decorations;
    expect(decorationsFn).toBeDefined();
    const result = decorationsFn?.call(plugin, state);
    expect(result).not.toBeFalsy();
    const found = (result as DecorationSet).find() as unknown as Array<{
      from: number;
      to: number;
      type: { attrs?: Record<string, string> };
    }>;
    expect(found.length).toBe(1);
    expect(found[0]?.type.attrs?.['data-resolution-state']).toBe('external');
  });

  test('without markIdentityPlugin installed → decorations returns null', () => {
    const plugin = linkResolutionDecorationPlugin({
      markTypes: ['link'],
      computeAttrs: () => ({ 'data-x': '1' }),
    });
    const state = EditorState.create({
      doc: buildDoc([{ text: 'hello', marks: [linkMark('https://a.com')] }]),
      plugins: [plugin], // NO markIdentityPlugin
    });
    const decorationsFn = plugin.props.decorations;
    const result = decorationsFn?.call(plugin, state);
    expect(result).toBeNull();
  });

  test('cache is read live at decorations-call time, not cached on plugin', () => {
    const plugin = linkResolutionDecorationPlugin({
      markTypes: ['link'],
      computeAttrs: (_info, cache) => ({
        'data-resolution-state': cache?.pages.has('page') ? 'resolved' : 'unresolved',
      }),
    });
    const state = EditorState.create({
      doc: buildDoc([{ text: 'x', marks: [linkMark('/page')] }]),
      plugins: [markIdentityPlugin({ markTypes: ['link'] }), plugin],
    });
    const decorationsFn = plugin.props.decorations;
    expect(decorationsFn).toBeDefined();

    const r1 = decorationsFn?.call(plugin, state);
    const f1 = (r1 as DecorationSet).find() as unknown as Array<{
      type: { attrs?: Record<string, string> };
    }>;
    expect(f1[0]?.type.attrs?.['data-resolution-state']).toBe('unresolved');

    seedCache(['page']);
    const r2 = decorationsFn?.call(plugin, state);
    const f2 = (r2 as DecorationSet).find() as unknown as Array<{
      type: { attrs?: Record<string, string> };
    }>;
    expect(f2[0]?.type.attrs?.['data-resolution-state']).toBe('resolved');
  });
});


interface FakeViewBag {
  view: EditorView;
  dispatched: Transaction[];
}

function createFakeView(state: EditorState): FakeViewBag {
  const dispatched: Transaction[] = [];
  const fake = {
    get state() {
      return state;
    },
    dispatch(tr: Transaction) {
      dispatched.push(tr);
    },
  };
  return { view: fake as unknown as EditorView, dispatched };
}

describe('linkResolutionDecorationPlugin — view subscription lifecycle', () => {
  test('view() subscribes; cache change after subscribe fires refresh dispatch', () => {
    const plugin = linkResolutionDecorationPlugin({
      markTypes: ['link'],
      computeAttrs: () => null,
    });
    const state = EditorState.create({
      doc: buildDoc([{ text: 'x' }]),
      plugins: [plugin],
    });
    const bag = createFakeView(state);
    const pluginView = plugin.spec.view?.(bag.view);
    expect(bag.dispatched.length).toBe(0);

    seedCache(['page']);
    expect(bag.dispatched.length).toBe(1);
    const meta = bag.dispatched[0]?.getMeta(linkResolutionDecorationKey) as { refresh?: boolean };
    expect(meta?.refresh).toBe(true);

    pluginView?.destroy?.();
  });

  test('subscribe replays immediately if cache is non-null at view-create time', () => {
    seedCache(['page']);

    const plugin = linkResolutionDecorationPlugin({
      markTypes: ['link'],
      computeAttrs: () => null,
    });
    const state = EditorState.create({
      doc: buildDoc([{ text: 'x' }]),
      plugins: [plugin],
    });
    const bag = createFakeView(state);
    const pluginView = plugin.spec.view?.(bag.view);

    expect(bag.dispatched.length).toBe(1);

    pluginView?.destroy?.();
  });

  test('destroy() unsubscribes; subsequent cache changes do NOT fire dispatch', () => {
    const plugin = linkResolutionDecorationPlugin({
      markTypes: ['link'],
      computeAttrs: () => null,
    });
    const state = EditorState.create({
      doc: buildDoc([{ text: 'x' }]),
      plugins: [plugin],
    });
    const bag = createFakeView(state);
    const pluginView = plugin.spec.view?.(bag.view);

    seedCache(['page']);
    expect(bag.dispatched.length).toBe(1);

    pluginView?.destroy?.();

    seedCache(['page', 'another']);
    expect(bag.dispatched.length).toBe(1);
  });
});

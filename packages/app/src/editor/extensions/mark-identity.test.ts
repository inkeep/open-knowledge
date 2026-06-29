import { describe, expect, test } from 'bun:test';
import { type Mark, Schema } from '@tiptap/pm/model';
import { EditorState } from '@tiptap/pm/state';
import {
  computeMarkIdentity,
  diffMarkIdentity,
  initialMarkIdentityState,
  type MarkInfo,
  markIdentityKey,
  markIdentityPlugin,
} from './mark-identity';

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'inline*' },
    text: { group: 'inline' },
  },
  marks: {
    link: {
      attrs: { href: {} },
    },
    wikiLink: {
      attrs: { page: {} },
    },
    strong: {},
  },
});

function doc(runs: Array<{ text: string; marks?: Mark[] }>) {
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
function strongMark(): Mark {
  return schema.mark('strong');
}

describe('computeMarkIdentity — initial assignment', () => {
  test('empty doc → empty state', () => {
    const d = schema.node('doc', null, [schema.node('paragraph')]);
    const next = computeMarkIdentity(d, initialMarkIdentityState(), new Set(['link']), undefined);
    expect(next.byId.size).toBe(0);
    expect(next.counter).toBe(0);
  });

  test('doc with no tracked marks → empty state', () => {
    const d = doc([{ text: 'hello', marks: [strongMark()] }]);
    const next = computeMarkIdentity(d, initialMarkIdentityState(), new Set(['link']), undefined);
    expect(next.byId.size).toBe(0);
  });

  test('single tracked mark → one entry with id m1', () => {
    const d = doc([{ text: 'link', marks: [linkMark('/a')] }]);
    const next = computeMarkIdentity(d, initialMarkIdentityState(), new Set(['link']), undefined);
    expect(next.byId.size).toBe(1);
    const info = [...next.byId.values()][0];
    expect(info.id).toBe('m1');
    expect(info.markType).toBe('link');
    expect(info.attrs).toEqual({ href: '/a' });
    expect(next.counter).toBe(1);
  });

  test('two distinct marks → two entries, m1 and m2', () => {
    const d = doc([
      { text: 'a', marks: [linkMark('/a')] },
      { text: 'unmarked ' },
      { text: 'b', marks: [linkMark('/b')] },
    ]);
    const next = computeMarkIdentity(d, initialMarkIdentityState(), new Set(['link']), undefined);
    expect(next.byId.size).toBe(2);
    expect(next.counter).toBe(2);
  });

  test('multiple tracked mark types (link + wikiLink) both get IDs', () => {
    const d = doc([
      { text: 'link', marks: [linkMark('/a')] },
      { text: ' wiki', marks: [wikiMark('Page')] },
    ]);
    const next = computeMarkIdentity(
      d,
      initialMarkIdentityState(),
      new Set(['link', 'wikiLink']),
      undefined,
    );
    expect(next.byId.size).toBe(2);
    const types = [...next.byId.values()].map((i) => i.markType);
    expect(types).toContain('link');
    expect(types).toContain('wikiLink');
  });

  test('non-tracked mark types (strong) are ignored', () => {
    const d = doc([{ text: 'bold', marks: [strongMark()] }]);
    const next = computeMarkIdentity(d, initialMarkIdentityState(), new Set(['link']), undefined);
    expect(next.byId.size).toBe(0);
  });

  test('predicate further filters — tracks only external links', () => {
    const d = doc([
      { text: 'ext', marks: [linkMark('https://external.com')] },
      { text: ' int', marks: [linkMark('/internal')] },
    ]);
    const next = computeMarkIdentity(
      d,
      initialMarkIdentityState(),
      new Set(['link']),
      (m) => typeof m.attrs.href === 'string' && m.attrs.href.startsWith('http'),
    );
    expect(next.byId.size).toBe(1);
    const info = [...next.byId.values()][0];
    expect(info.attrs.href).toBe('https://external.com');
  });
});

describe('computeMarkIdentity — contiguous span merging', () => {
  test('single mark applied to consecutive text nodes merges into one info', () => {
    const m = linkMark('/same');
    const paragraph = schema.node('paragraph', null, [
      schema.text('hello ', [m]),
      schema.text('world', [m]),
    ]);
    const d = schema.node('doc', null, [paragraph]);
    const next = computeMarkIdentity(d, initialMarkIdentityState(), new Set(['link']), undefined);
    expect(next.byId.size).toBe(1);
    const info = [...next.byId.values()][0];
    expect(info.from).toBe(1);
    expect(info.to).toBe(12);
  });
});

describe('computeMarkIdentity — ID carryover via mapping', () => {
  const identityMapping = { map: (pos: number) => pos };

  test('same doc + identity mapping → all IDs carry forward', () => {
    const d = doc([{ text: 'link', marks: [linkMark('/a')] }]);
    const prev = computeMarkIdentity(d, initialMarkIdentityState(), new Set(['link']), undefined);
    const prevId = [...prev.byId.keys()][0];
    const next = computeMarkIdentity(d, prev, new Set(['link']), undefined, identityMapping);
    expect(next.byId.size).toBe(1);
    expect([...next.byId.keys()][0]).toBe(prevId);
    expect(next.counter).toBe(prev.counter);
  });

  test('insertion in unmarked region → existing mark ID preserved', () => {
    const prev = computeMarkIdentity(
      doc([{ text: 'link', marks: [linkMark('/a')] }, { text: ' tail' }]),
      initialMarkIdentityState(),
      new Set(['link']),
      undefined,
    );
    const prevId = [...prev.byId.keys()][0];

    const newDoc = doc([{ text: 'link', marks: [linkMark('/a')] }, { text: ' more tail' }]);
    const mapping = {
      map: (pos: number) => (pos <= 10 ? pos : pos + 5),
    };
    const next = computeMarkIdentity(newDoc, prev, new Set(['link']), undefined, mapping);
    expect(next.byId.size).toBe(1);
    expect([...next.byId.keys()][0]).toBe(prevId);
  });

  test('deleted mark range → ID dropped (deregister case)', () => {
    const prev = computeMarkIdentity(
      doc([{ text: 'link', marks: [linkMark('/a')] }]),
      initialMarkIdentityState(),
      new Set(['link']),
      undefined,
    );
    expect(prev.byId.size).toBe(1);

    const newDoc = schema.node('doc', null, [schema.node('paragraph')]);
    const mapping = { map: (pos: number) => (pos <= 1 ? pos : 1) };
    const next = computeMarkIdentity(newDoc, prev, new Set(['link']), undefined, mapping);
    expect(next.byId.size).toBe(0);
  });

  test('different attrs → fresh ID even if range aligns (treat as new mark)', () => {
    const prev = computeMarkIdentity(
      doc([{ text: 'link', marks: [linkMark('/a')] }]),
      initialMarkIdentityState(),
      new Set(['link']),
      undefined,
    );
    const prevId = [...prev.byId.keys()][0];

    const newDoc = doc([{ text: 'link', marks: [linkMark('/different')] }]);
    const identityMapping = { map: (pos: number) => pos };
    const next = computeMarkIdentity(newDoc, prev, new Set(['link']), undefined, identityMapping);
    expect(next.byId.size).toBe(1);
    expect([...next.byId.keys()][0]).not.toBe(prevId);
    expect(next.counter).toBe(prev.counter + 1);
  });

  test('per-editor-instance counter never re-uses IDs even after all marks deleted', () => {
    let state = initialMarkIdentityState();
    state = computeMarkIdentity(
      doc([{ text: 'a', marks: [linkMark('/1')] }]),
      state,
      new Set(['link']),
      undefined,
    );
    expect([...state.byId.keys()][0]).toBe('m1');

    const emptyDoc = schema.node('doc', null, [schema.node('paragraph')]);
    state = computeMarkIdentity(emptyDoc, state, new Set(['link']), undefined, {
      map: (p: number) => (p <= 1 ? p : 1),
    });
    expect(state.byId.size).toBe(0);
    expect(state.counter).toBe(1);

    state = computeMarkIdentity(
      doc([{ text: 'b', marks: [linkMark('/2')] }]),
      state,
      new Set(['link']),
      undefined,
      { map: (p: number) => p },
    );
    expect([...state.byId.keys()][0]).toBe('m2');
  });
});

describe('diffMarkIdentity — register/deregister transitions', () => {
  test('new ID fires onRegister once', () => {
    const prev = new Set<string>();
    const info: MarkInfo = { id: 'm1', markType: 'link', attrs: {}, from: 0, to: 5 };
    const next = { byId: new Map([['m1', info]]), counter: 1 };
    const registered: MarkInfo[] = [];
    const deregistered: string[] = [];
    const nextIds = diffMarkIdentity(
      prev,
      next,
      (i) => registered.push(i),
      (id) => deregistered.push(id),
    );
    expect(registered).toHaveLength(1);
    expect(registered[0]).toBe(info);
    expect(deregistered).toHaveLength(0);
    expect(nextIds).toEqual(new Set(['m1']));
  });

  test('removed ID fires onDeregister', () => {
    const prev = new Set(['m1']);
    const next = { byId: new Map(), counter: 1 };
    const registered: MarkInfo[] = [];
    const deregistered: string[] = [];
    diffMarkIdentity(
      prev,
      next,
      (i) => registered.push(i),
      (id) => deregistered.push(id),
    );
    expect(registered).toHaveLength(0);
    expect(deregistered).toEqual(['m1']);
  });

  test('stable ID: no callbacks fire', () => {
    const prev = new Set(['m1']);
    const info: MarkInfo = { id: 'm1', markType: 'link', attrs: {}, from: 0, to: 5 };
    const next = { byId: new Map([['m1', info]]), counter: 1 };
    const registered: MarkInfo[] = [];
    const deregistered: string[] = [];
    diffMarkIdentity(
      prev,
      next,
      (i) => registered.push(i),
      (id) => deregistered.push(id),
    );
    expect(registered).toHaveLength(0);
    expect(deregistered).toHaveLength(0);
  });

  test('mixed: m1 stays, m2 added, m3 removed', () => {
    const prev = new Set(['m1', 'm3']);
    const m1: MarkInfo = { id: 'm1', markType: 'link', attrs: {}, from: 0, to: 5 };
    const m2: MarkInfo = { id: 'm2', markType: 'link', attrs: {}, from: 6, to: 10 };
    const next = {
      byId: new Map([
        ['m1', m1],
        ['m2', m2],
      ]),
      counter: 2,
    };
    const registered: MarkInfo[] = [];
    const deregistered: string[] = [];
    diffMarkIdentity(
      prev,
      next,
      (i) => registered.push(i),
      (id) => deregistered.push(id),
    );
    expect(registered).toEqual([m2]);
    expect(deregistered).toEqual(['m3']);
  });
});

describe('markIdentityPlugin — EditorState integration', () => {
  test('init walks doc and populates plugin state', () => {
    const d = doc([{ text: 'link', marks: [linkMark('/a')] }]);
    const plugin = markIdentityPlugin({ markTypes: ['link'] });
    const state = EditorState.create({ doc: d, plugins: [plugin] });
    const mis = markIdentityKey.getState(state);
    expect(mis).toBeDefined();
    expect(mis?.byId.size).toBe(1);
  });

  test('apply of non-doc-change tr preserves state identity', () => {
    const d = doc([{ text: 'link', marks: [linkMark('/a')] }]);
    const plugin = markIdentityPlugin({ markTypes: ['link'] });
    const state1 = EditorState.create({ doc: d, plugins: [plugin] });
    const mis1 = markIdentityKey.getState(state1);
    const tr = state1.tr.setMeta('noop', true);
    const state2 = state1.apply(tr);
    const mis2 = markIdentityKey.getState(state2);
    expect(mis2).toBe(mis1);
  });

  test('apply of doc-changing tr recomputes state', () => {
    const d = doc([{ text: 'plain' }]);
    const plugin = markIdentityPlugin({ markTypes: ['link'] });
    const state1 = EditorState.create({ doc: d, plugins: [plugin] });
    expect(markIdentityKey.getState(state1)?.byId.size).toBe(0);

    const tr = state1.tr.addMark(1, 6, linkMark('/new'));
    const state2 = state1.apply(tr);
    const mis2 = markIdentityKey.getState(state2);
    expect(mis2?.byId.size).toBe(1);
  });

  test('predicate scopes tracking (link mark filtered)', () => {
    const d = doc([
      { text: 'ext', marks: [linkMark('https://x.com')] },
      { text: ' int', marks: [linkMark('/internal')] },
    ]);
    const plugin = markIdentityPlugin({
      markTypes: ['link'],
      predicate: (m) => typeof m.attrs.href === 'string' && m.attrs.href.startsWith('http'),
    });
    const state = EditorState.create({ doc: d, plugins: [plugin] });
    const mis = markIdentityKey.getState(state);
    expect(mis?.byId.size).toBe(1);
  });
});

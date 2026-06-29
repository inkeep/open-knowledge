import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { JSONContent } from '@tiptap/core';
import {
  __resetComposerDraftForTests,
  clearComposerDraft,
  getComposerDraft,
  setComposerDismissed,
  setComposerDraftDoc,
  subscribeComposerDraft,
} from './composer-draft-store';

const DRAFT_KEY = 'ok-ask-ai-draft-v2';

function doc(...inline: JSONContent[]): JSONContent {
  return { type: 'doc', content: [{ type: 'paragraph', content: inline }] };
}
function text(value: string): JSONContent {
  return { type: 'text', text: value };
}
function mention(path: string, label = path): JSONContent {
  return { type: 'composerMention', attrs: { path, label } };
}

/** Minimal in-memory `localStorage` so the reload-survival path runs under plain
 *  bun (no jsdom). A fresh instance per test is implicitly cleared. */
function makeLocalStorage(): Storage {
  const store = new Map<string, string>();
  return {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (key) => store.get(key) ?? null,
    key: (index) => [...store.keys()][index] ?? null,
    removeItem: (key) => {
      store.delete(key);
    },
    setItem: (key, value) => {
      store.set(key, String(value));
    },
  };
}

beforeEach(() => {
  (globalThis as { window?: { localStorage: Storage } }).window = {
    localStorage: makeLocalStorage(),
  };
  __resetComposerDraftForTests();
});

afterEach(() => {
  __resetComposerDraftForTests();
  delete (globalThis as Record<string, unknown>).window;
});

describe('composer-draft-store', () => {
  test('starts empty', () => {
    expect(getComposerDraft().doc).toBeNull();
    expect(getComposerDraft().dismissed).toBe(false);
  });

  test('a write in one placement is readable by the other (shared draft)', () => {
    const d = doc(text('condense my AGENTS.md'));
    setComposerDraftDoc(d);
    expect(getComposerDraft().doc).toEqual(d);
  });

  test('a mention chip in the draft round-trips as a node (not literal @path text)', () => {
    const d = doc(text('summarize '), mention('notes.md', 'Notes'));
    setComposerDraftDoc(d);
    const read = getComposerDraft().doc;
    const inline = (read?.content?.[0]?.content ?? []) as JSONContent[];
    expect(inline.some((node) => node.type === 'composerMention')).toBe(true);
    expect(inline.find((node) => node.type === 'composerMention')?.attrs?.path).toBe('notes.md');
  });

  test('persists the draft doc to localStorage for reload survival', () => {
    const d = doc(text('research flightless birds'));
    setComposerDraftDoc(d);
    expect(JSON.parse(window.localStorage.getItem(DRAFT_KEY) ?? 'null')).toEqual(d);
    __resetComposerDraftForTests();
    expect(getComposerDraft().doc).toEqual(d);
  });

  test('an empty/idle doc clears the draft rather than persisting a blank paragraph', () => {
    setComposerDraftDoc(doc(text('draft a spec')));
    setComposerDraftDoc({ type: 'doc', content: [{ type: 'paragraph' }] });
    expect(getComposerDraft().doc).toBeNull();
    expect(window.localStorage.getItem(DRAFT_KEY)).toBeNull();
  });

  test('a corrupt persisted value is ignored (falls back to empty)', () => {
    window.localStorage.setItem(DRAFT_KEY, '{ not valid json');
    __resetComposerDraftForTests();
    expect(getComposerDraft().doc).toBeNull();
  });

  test('clearing the draft empties it and removes the persisted value', () => {
    setComposerDraftDoc(doc(text('draft a spec')));
    clearComposerDraft();
    expect(getComposerDraft().doc).toBeNull();
    expect(window.localStorage.getItem(DRAFT_KEY)).toBeNull();
  });

  test('notifies subscribers on every set, and not after unsubscribe', () => {
    let notifications = 0;
    const unsubscribe = subscribeComposerDraft(() => {
      notifications += 1;
    });
    setComposerDraftDoc(doc(text('a')));
    setComposerDraftDoc(doc(text('b')));
    unsubscribe();
    setComposerDraftDoc(doc(text('c'))); // after unsubscribe — not counted
    expect(notifications).toBe(2);
  });

  test('dismissed is a separate latch from the draft doc', () => {
    const d = doc(text('keep me'));
    setComposerDraftDoc(d);
    setComposerDismissed(true);
    expect(getComposerDraft()).toMatchObject({ doc: d, dismissed: true });
    setComposerDismissed(false);
    expect(getComposerDraft().dismissed).toBe(false);
    expect(JSON.parse(window.localStorage.getItem(DRAFT_KEY) ?? 'null')).toEqual(d);
  });
});

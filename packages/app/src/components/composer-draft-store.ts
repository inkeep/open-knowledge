import type { JSONContent } from '@tiptap/core';

const DRAFT_STORAGE_KEY = 'ok-ask-ai-draft-v2';

interface ComposerDraftState {
  readonly doc: JSONContent | null;
  readonly dismissed: boolean;
}

const EMPTY: ComposerDraftState = { doc: null, dismissed: false };

function getStorage(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

let state: ComposerDraftState | null = null;
const listeners = new Set<() => void>();

function docIsEmpty(doc: JSONContent | null): boolean {
  if (doc === null) return true;
  const blocks = doc.content;
  if (!Array.isArray(blocks) || blocks.length === 0) return true;
  return blocks.every((block) => {
    const inline = block.content;
    return !Array.isArray(inline) || inline.length === 0;
  });
}

function load(): ComposerDraftState {
  const storage = getStorage();
  if (!storage) return EMPTY;
  try {
    const raw = storage.getItem(DRAFT_STORAGE_KEY);
    if (!raw) return EMPTY;
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return EMPTY;
    return { doc: parsed as JSONContent, dismissed: false };
  } catch (err) {
    console.warn('failed to parse stored draft — clearing', err);
    return EMPTY;
  }
}

function ensureLoaded(): ComposerDraftState {
  if (state === null) state = load();
  return state;
}

function persistDoc(doc: JSONContent | null): void {
  const storage = getStorage();
  if (!storage) return;
  try {
    if (doc && !docIsEmpty(doc)) storage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(doc));
    else storage.removeItem(DRAFT_STORAGE_KEY);
  } catch {}
}

function notify(): void {
  for (const listener of listeners) listener();
}

export function getComposerDraft(): ComposerDraftState {
  return ensureLoaded();
}

export function setComposerDraftDoc(doc: JSONContent | null): void {
  const next = doc && !docIsEmpty(doc) ? doc : null;
  state = { ...ensureLoaded(), doc: next };
  persistDoc(next);
  notify();
}

export function setComposerDismissed(dismissed: boolean): void {
  const current = ensureLoaded();
  if (current.dismissed === dismissed) return;
  state = { ...current, dismissed };
  notify();
}

export function clearComposerDraft(): void {
  setComposerDraftDoc(null);
}

export function subscribeComposerDraft(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function __resetComposerDraftForTests(): void {
  state = null;
}

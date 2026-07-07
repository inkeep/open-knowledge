/**
 * Shared, persisted draft state for the unified "Ask AI" composer.
 *
 * One module-level store (the same external-store pattern as
 * `selection-context.ts`) so the typed brief survives the composer mounting and
 * unmounting as the user moves between placements — the bottom docked field over
 * an open doc and the create/empty-screen hero. Because the draft lives here and
 * not in component-local `useState`, a brief typed in the bottom composer is the
 * same brief the create screen shows on a new tab, and vice versa. The draft is
 * persisted to localStorage so it also survives reload.
 *
 * The store carries the editor's ProseMirror document JSON (TipTap
 * `editor.getJSON()`), NOT a flattened instruction string. Atomic `@`-mention
 * chips are real nodes in that JSON, so seeding the other placement from the doc
 * restores them as chips — a flattened `@path` string would re-seed as literal
 * text the `@`-typeahead never re-parses. The other composer seeds from this doc
 * on mount (`editor.commands.setContent(doc)`) and writes the doc back on every
 * edit. (Dispatch still flattens the doc to `@path` prose via
 * `serializeComposerContent`; only the SHARED unit is the doc.) The selected
 * agent lives in the sibling `unified-agent-store`; `dismissed` is the bottom
 * field's collapse latch, shared so a reopen survives navigation too.
 */

import type { JSONContent } from '@tiptap/core';

// v2: the stored unit changed from a plain instruction string to the editor's
// document JSON. Bumping the key makes any stale v1 plain-text draft simply
// ignored — drafts are ephemeral, so no migration is needed.
const DRAFT_STORAGE_KEY = 'ok-ask-ai-draft-v2';

interface ComposerDraftState {
  /** The composer's ProseMirror document JSON (chips are real nodes), or null
   *  when there is no draft. */
  readonly doc: JSONContent | null;
  /** Whether the bottom docked field is collapsed to its footer reopen badge.
   *  Hero placement ignores it (the create screen has no collapse affordance). */
  readonly dismissed: boolean;
}

const EMPTY: ComposerDraftState = { doc: null, dismissed: false };

/**
 * Resolve a usable Storage. Mirrors the other client-only stores: guarded for
 * SSR + privacy-mode throws. No injected seam here — the store is exercised via
 * its public read/write API in the DOM tests.
 */
function getStorage(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** Lazy-loaded from localStorage on first read, then kept in memory. Only `doc`
 *  persists; `dismissed` is a per-session latch reset on reload. */
let state: ComposerDraftState | null = null;
const listeners = new Set<() => void>();

/** A draft is meaningful only when the doc has at least one node with content —
 *  an empty paragraph is the editor's idle state, indistinguishable from "no
 *  draft", so we treat it (and a parse miss) as absent. */
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
    // Guard the shape: a non-object (or an array) is not a document — fall back
    // to empty rather than feed garbage into `setContent` on the next seed.
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return EMPTY;
    return { doc: parsed as JSONContent, dismissed: false };
  } catch (err) {
    // Corrupt JSON / availability — ignore the stale draft, but log so a
    // silently-dropped draft isn't invisible.
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
  } catch {
    // quota / availability — in-memory state is still the source of truth.
  }
}

function notify(): void {
  for (const listener of listeners) listener();
}

/** The current draft snapshot (stable reference until a value actually changes,
 *  so `useSyncExternalStore` does not churn). */
export function getComposerDraft(): ComposerDraftState {
  return ensureLoaded();
}

/** Replace the draft document. An empty doc (idle editor) clears the draft so a
 *  sent-then-cleared field doesn't persist a blank paragraph. */
export function setComposerDraftDoc(doc: JSONContent | null): void {
  const next = doc && !docIsEmpty(doc) ? doc : null;
  state = { ...ensureLoaded(), doc: next };
  persistDoc(next);
  notify();
}

/** Set the bottom field's collapse latch. */
export function setComposerDismissed(dismissed: boolean): void {
  const current = ensureLoaded();
  if (current.dismissed === dismissed) return;
  state = { ...current, dismissed };
  notify();
}

/** Clear the draft document (after a successful dispatch). Leaves `dismissed`. */
export function clearComposerDraft(): void {
  setComposerDraftDoc(null);
}

export function subscribeComposerDraft(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test-only: drop the in-memory snapshot so the next read re-loads from storage.
 *  Production never calls this — the store is a session singleton. */
export function __resetComposerDraftForTests(): void {
  state = null;
}

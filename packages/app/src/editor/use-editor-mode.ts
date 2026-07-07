/**
 * useEditorMode — persists the user's editor mode (`wysiwyg` / `source`) to
 * localStorage as a user-global preference.
 *
 * Read-once: the hook reads localStorage exactly once in its `useState`
 * initializer. Every `setMode` call writes to localStorage so the last toggle
 * wins at the next load. Open tabs/windows do NOT update each other live —
 * each is its own session for its lifetime. Cross-window sync was
 * deliberately rejected because a spontaneous mode flip on tab-focus
 * surprises the user regardless of IME/drag-selection protection.
 *
 * The initializer prefers `window.__OK_EDITOR_MODE__`, set by the FOUC
 * inline script in `packages/app/index.html` for flash-free first paint when
 * the persisted mode is `source`.
 */
import { useState } from 'react';

const STORAGE_KEY = 'ok-editor-mode-v1';

// Single source for the persistable mode set — `EditorModeValue` and the
// type guard both derive from this so adding a value updates both atomically.
export const EDITOR_MODE_VALUES = ['wysiwyg', 'source'] as const;

export type EditorModeValue = (typeof EDITOR_MODE_VALUES)[number];

const DEFAULT_MODE: EditorModeValue = 'wysiwyg';

declare global {
  interface Window {
    /**
     * Set by the FOUC-prevention inline script in `packages/app/index.html`
     * before React mounts. Untyped origin — readers MUST validate via
     * `isEditorModeValue()` before use; `unknown` forces that.
     */
    __OK_EDITOR_MODE__?: unknown;
  }
}

/** Type guard — exported for unit testing. */
export function isEditorModeValue(raw: unknown): raw is EditorModeValue {
  return (EDITOR_MODE_VALUES as readonly unknown[]).includes(raw);
}

/**
 * Read the persisted mode. Default on miss, invalid value, or storage throw.
 * Logs a diagnostic warn only on structurally invalid values — storage-throw
 * stays silent because privacy-mode / quota are normal environmental
 * conditions, not bugs.
 */
export function readPersistedMode(
  storage: Pick<Storage, 'getItem'> = localStorage,
): EditorModeValue {
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (raw === null) return DEFAULT_MODE;
    if (isEditorModeValue(raw)) return raw;
    console.warn('[editor-mode] invalid persisted value, falling back to default', { raw });
  } catch {
    // Privacy mode / quota / serialization — stay silent; only the invalid-
    // value branch above logs.
  }
  return DEFAULT_MODE;
}

/**
 * Initial mode for the useState initializer. Precedence:
 *   1. `window.__OK_EDITOR_MODE__` (FOUC inline script — first-paint)
 *   2. localStorage (SSR / test harnesses / unexpected boot order)
 *   3. Default `'wysiwyg'`.
 */
export function readInitialMode(
  win: { __OK_EDITOR_MODE__?: unknown } = window,
  storage: Pick<Storage, 'getItem'> = localStorage,
): EditorModeValue {
  const preloaded = win.__OK_EDITOR_MODE__;
  if (isEditorModeValue(preloaded)) return preloaded;
  return readPersistedMode(storage);
}

/**
 * Persist mode to storage. Swallows throws (privacy mode, quota) with a
 * console.warn; returns false on throw.
 */
export function persistMode(
  next: EditorModeValue,
  storage: Pick<Storage, 'setItem'> = localStorage,
): boolean {
  try {
    storage.setItem(STORAGE_KEY, next);
    return true;
  } catch (err) {
    console.warn('[editor-mode] persist failed', err);
    return false;
  }
}

/**
 * Returns `[mode, setMode]`. `setMode` updates React state AND persists to
 * localStorage. Does NOT listen for cross-window changes — open tabs remain
 * independent until one reloads.
 */
export function useEditorMode(): readonly [EditorModeValue, (next: EditorModeValue) => void] {
  const [mode, setMode] = useState<EditorModeValue>(readInitialMode);

  function persistAndSet(next: EditorModeValue) {
    setMode(next);
    persistMode(next);
  }

  return [mode, persistAndSet] as const;
}

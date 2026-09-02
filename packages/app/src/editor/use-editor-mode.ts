import { useState } from 'react';

const STORAGE_KEY = 'ok-editor-mode-v1';

export const EDITOR_MODE_VALUES = ['wysiwyg', 'source'] as const;

export type EditorModeValue = (typeof EDITOR_MODE_VALUES)[number];

const DEFAULT_MODE: EditorModeValue = 'wysiwyg';

declare global {
  interface Window {
    __OK_EDITOR_MODE__?: unknown;
  }
}

export function isEditorModeValue(raw: unknown): raw is EditorModeValue {
  return (EDITOR_MODE_VALUES as readonly unknown[]).includes(raw);
}

export function readPersistedMode(
  storage: Pick<Storage, 'getItem'> = localStorage,
): EditorModeValue {
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (raw === null) return DEFAULT_MODE;
    if (isEditorModeValue(raw)) return raw;
    console.warn('[editor-mode] invalid persisted value, falling back to default', { raw });
  } catch {}
  return DEFAULT_MODE;
}

export function readInitialMode(
  win: { __OK_EDITOR_MODE__?: unknown } = window,
  storage: Pick<Storage, 'getItem'> = localStorage,
): EditorModeValue {
  const preloaded = win.__OK_EDITOR_MODE__;
  if (isEditorModeValue(preloaded)) return preloaded;
  return readPersistedMode(storage);
}

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

export function useEditorMode(): readonly [EditorModeValue, (next: EditorModeValue) => void] {
  const [mode, setMode] = useState<EditorModeValue>(readInitialMode);

  function persistAndSet(next: EditorModeValue) {
    setMode(next);
    persistMode(next);
  }

  return [mode, persistAndSet] as const;
}

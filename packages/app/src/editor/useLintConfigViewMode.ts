import { useState } from 'react';

const STORAGE_KEY = 'ok-lint-config-view-mode-v1';

export const LINT_CONFIG_VIEW_MODES = ['source', 'rules'] as const;

export type LintConfigViewMode = (typeof LINT_CONFIG_VIEW_MODES)[number];

const DEFAULT_VIEW_MODE: LintConfigViewMode = 'source';

export function isLintConfigViewMode(raw: unknown): raw is LintConfigViewMode {
  return (LINT_CONFIG_VIEW_MODES as readonly unknown[]).includes(raw);
}

export function readPersistedViewMode(
  storage: Pick<Storage, 'getItem'> = localStorage,
): LintConfigViewMode {
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (raw === null) return DEFAULT_VIEW_MODE;
    if (isLintConfigViewMode(raw)) return raw;
    console.warn('[lint-config-view-mode] invalid persisted value, falling back to default', {
      raw,
    });
  } catch {}
  return DEFAULT_VIEW_MODE;
}

export function persistViewMode(
  next: LintConfigViewMode,
  storage: Pick<Storage, 'setItem'> = localStorage,
): boolean {
  try {
    storage.setItem(STORAGE_KEY, next);
    return true;
  } catch (err) {
    console.warn('[lint-config-view-mode] persist failed', err);
    return false;
  }
}

export function useLintConfigViewMode(): readonly [
  LintConfigViewMode,
  (next: LintConfigViewMode) => void,
] {
  const [mode, setMode] = useState<LintConfigViewMode>(readPersistedViewMode);

  function persistAndSet(next: LintConfigViewMode) {
    setMode(next);
    persistViewMode(next);
  }

  return [mode, persistAndSet] as const;
}

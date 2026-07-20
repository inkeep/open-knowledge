/**
 * useLintConfigViewMode — persists the user's chosen view for an opened
 * markdownlint config file (`source` raw text vs `rules` rule browser) to
 * localStorage as a user-global preference.
 *
 * This is deliberately its own preference, keyed separately from the markdown
 * document editor's mode (`ok-editor-mode-v1`): a person who prefers `source`
 * for their prose and `rules` for their config should not have one choice
 * silently move the other.
 *
 * Read-once: the hook reads localStorage exactly once in its `useState`
 * initializer and writes on each set, so the last toggle wins at the next
 * open. Open tabs/windows do NOT update each other live — a spontaneous view
 * flip on tab-focus would surprise the user mid-task.
 */
import { useState } from 'react';

const STORAGE_KEY = 'ok-lint-config-view-mode-v1';

// Single source for the persistable view-mode set — `LintConfigViewMode` and
// the type guard both derive from this, so adding a value updates both at once.
export const LINT_CONFIG_VIEW_MODES = ['source', 'rules'] as const;

export type LintConfigViewMode = (typeof LINT_CONFIG_VIEW_MODES)[number];

const DEFAULT_VIEW_MODE: LintConfigViewMode = 'source';

/** Type guard — exported for unit testing and for validating stored values. */
export function isLintConfigViewMode(raw: unknown): raw is LintConfigViewMode {
  return (LINT_CONFIG_VIEW_MODES as readonly unknown[]).includes(raw);
}

/**
 * Read the persisted view mode. Default on miss, invalid value, or storage
 * throw. Logs a diagnostic warn only on structurally invalid values —
 * storage-throw stays silent because privacy-mode / quota are normal
 * environmental conditions, not bugs, while a value that fails the guard means
 * manual tampering or an old schema and is worth tracing.
 */
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
  } catch {
    // Privacy mode / quota — stay silent; only the invalid-value branch warns.
  }
  return DEFAULT_VIEW_MODE;
}

/**
 * Persist view mode to storage. Swallows throws (privacy mode, quota) with a
 * console.warn; returns false on throw so a caller can react if it needs to.
 */
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

/**
 * Returns `[mode, setMode]`. `setMode` updates React state AND persists to
 * localStorage. Does NOT listen for cross-window changes — open tabs remain
 * independent until one reloads.
 */
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

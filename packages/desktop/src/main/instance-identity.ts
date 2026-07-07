/**
 * Derive a short, human-readable instance label so parallel desktop instances
 * are distinguishable in the macOS menu bar and window titles.
 *
 * The label comes from the launch's `userData` directory name, which is already
 * unique per instance — set by the parallel-instance launcher
 * (`--user-data-dir ~/.ok/instances/<name>` → `<name>`) or by dev `OK_INSTANCE`
 * (`OpenKnowledge (<name>)` → `<name>`). The default install (userData basename
 * is the product name) gets no label, so normal launches are unchanged.
 *
 * Pure: no Electron, unit-testable.
 */
import { basename } from 'node:path';

/**
 * userData basenames that mean "the default install" (no label). Covers the
 * current + legacy product names and Electron's dev fallback.
 */
const DEFAULT_USERDATA_NAMES = new Set(['OpenKnowledge', 'Open Knowledge', 'Electron']);

/** Strip the `OpenKnowledge (x)` / `Open Knowledge (x)` dev wrapper down to `x`. */
const DEV_WRAPPER = /^(?:OpenKnowledge|Open Knowledge) \((.+)\)$/;

export function resolveInstanceLabel(userDataDir: string): string | null {
  const base = basename(userDataDir);
  if (DEFAULT_USERDATA_NAMES.has(base)) return null;
  const wrapped = DEV_WRAPPER.exec(base);
  const label = (wrapped ? wrapped[1] : base).trim();
  return label.length > 0 ? label : null;
}

/** Suffix the app name with the instance label, e.g. `OpenKnowledge` → `OpenKnowledge (work)`. */
export function formatInstanceAppName(appName: string, label: string): string {
  return `${appName} (${label})`;
}

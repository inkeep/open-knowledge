/**
 * Dev-only parallel-instance isolation for the desktop app.
 *
 * Electron keys its single-instance lock on the `userData` directory, and a
 * launch's Chromium storage (IndexedDB / cookies / cache) plus `state.json`
 * recents also live there. So two desktop processes sharing one `userData`
 * cannot coexist — the second fails `requestSingleInstanceLock()` and quits,
 * and even if it didn't, both would fight over the same IndexedDB.
 *
 * Relocating `userData` to a per-name sibling directory solves both at once:
 * each named instance gets its own lock (so both boot) and its own isolated
 * storage. This is wired behind `OK_INSTANCE` on unpackaged builds only — see
 * the caller in `index.ts`.
 *
 * Pure: takes the base `userData` and raw instance name, returns the relocated
 * directory (or null to leave `userData` untouched), so the derivation is
 * unit-testable without Electron's `app`.
 */
import { basename, dirname, join } from 'node:path';

/**
 * Reduce a raw `OK_INSTANCE` value to a safe single path segment: collapse any
 * run of characters outside `[A-Za-z0-9._-]` to `-` (this also removes path
 * separators, so no traversal can survive), trim leading/trailing `.`/`-` (so
 * `..` and dotfile-style names can't slip through), and bound the length.
 */
export function sanitizeInstanceName(raw: string): string {
  return raw
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '')
    .slice(0, 64);
}

/**
 * Derive the relocated `userData` directory for a named parallel instance —
 * a sibling of the base dir suffixed with the sanitized name, e.g.
 * `.../OpenKnowledge` + `b` → `.../OpenKnowledge (b)`. Returns null when the
 * name sanitizes to empty, signalling the caller to leave `userData` as-is.
 */
export function deriveInstanceUserDataDir(
  baseUserData: string,
  rawInstanceName: string,
): string | null {
  const safe = sanitizeInstanceName(rawInstanceName);
  if (safe.length === 0) return null;
  return join(dirname(baseUserData), `${basename(baseUserData)} (${safe})`);
}

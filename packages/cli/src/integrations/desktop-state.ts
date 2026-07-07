/**
 * CLI-side reader for the OK Desktop's `state.json` — the app-level store the
 * Electron main process keeps (recent projects, window state, update channel).
 * The CLI can't import the desktop package (dependency runs desktop→cli), so
 * this reimplements the two reads `ok uninstall` needs, WITHOUT Electron:
 *
 *   1. the recent-projects list, to offer a checkbox of projects to `deinit`; and
 *   2. an identity gate ("is this dir's state.json OURS?"), to safely delete the
 *      GENERIC-named legacy userData dir `~/Library/Application Support/Open
 *      Knowledge/` — another vendor could ship an app literally named "Open
 *      Knowledge", so the dir is never removed by name alone.
 *
 * The identity gate keys on the SAME discriminant the desktop's `parseAppState`
 * uses — a top-level object whose `recentProjects` is an array — which the
 * desktop's own one-time rename migration (`userdata-migration.ts`
 * `dirHasOurState` → `parseAppState`) relies on for the identical foreign-app
 * safety. That single field is the stable, load-bearing part of the contract
 * (it can never leave the shape without a schema break), so keying on it here
 * cannot drift out of sync with the desktop writer.
 *
 * The userData path is Electron's default: `app.getPath('userData')` =
 * `<Application Support | %APPDATA% | $XDG_CONFIG_HOME>/<productName>`. We reuse
 * `resolveAppSupportPath` (the same base resolver the editor-config paths use)
 * and join the product name — no Electron dependency.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type AppSupportOptions, resolveAppSupportPath } from '../commands/editors.ts';

/** Post-rename Electron `productName` — the userData basename on every platform. */
export const DESKTOP_PRODUCT_NAME = 'OpenKnowledge';
/** Pre-rename `productName` (macOS legacy `Open Knowledge`, with a space). A
 *  generic name we don't own by name alone — always identity-gate before
 *  deleting its dir. */
export const DESKTOP_LEGACY_PRODUCT_NAME = 'Open Knowledge';

interface DesktopUserDataOptions extends AppSupportOptions {
  /** Override the product-name basename (defaults to `OpenKnowledge`). */
  productName?: string;
}

/**
 * Resolve the OK Desktop userData directory — Electron's default
 * `<appSupportBase>/<productName>`. Cross-platform (macOS Application Support,
 * Windows %APPDATA%, Linux XDG config), matching Electron's own layout.
 */
export function desktopUserDataDir(options: DesktopUserDataOptions = {}): string {
  const productName = options.productName ?? DESKTOP_PRODUCT_NAME;
  return join(resolveAppSupportPath(options), productName);
}

/** A recent project as the CLI needs it: the on-disk path + display name. */
export interface DesktopRecentProject {
  path: string;
  name: string;
}

/**
 * Parse a `state.json` blob into the minimal shape the CLI reads. Returns `null`
 * unless the value is our shape — a top-level object whose `recentProjects` is
 * an array — the SAME discriminant `parseAppState` gates on. Each entry is kept
 * only when its `path` + `name` are strings (matching `parseAppState`'s
 * per-entry filter), so a partially-corrupt list degrades gracefully.
 */
function parseRecentProjects(raw: unknown): DesktopRecentProject[] | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const recentRaw = (raw as Record<string, unknown>).recentProjects;
  if (!Array.isArray(recentRaw)) return null;
  const projects: DesktopRecentProject[] = [];
  for (const entry of recentRaw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const item = entry as Record<string, unknown>;
    if (typeof item.path === 'string' && typeof item.name === 'string') {
      projects.push({ path: item.path, name: item.name });
    }
  }
  return projects;
}

/**
 * Read `<userDataDir>/state.json`'s recent-projects list, or `[]` when the file
 * is absent, unreadable, malformed, or not our shape. Never throws — a read
 * failure degrades to "no recent projects", so the uninstall sweep simply falls
 * back to the running-servers set + the manual `ok deinit` hint.
 */
export function readDesktopRecentProjects(userDataDir: string): DesktopRecentProject[] {
  const stateFile = join(userDataDir, 'state.json');
  if (!existsSync(stateFile)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(stateFile, 'utf-8'));
  } catch {
    return [];
  }
  return parseRecentProjects(parsed) ?? [];
}

/**
 * Identity gate for the generic-named legacy userData dir: true iff
 * `<dir>/state.json` exists and parses as OUR `AppState` shape (recentProjects
 * is an array). A foreign vendor's same-named dir, a junk dir, or an absent
 * state.json all return false — so `ok uninstall` never deletes a directory it
 * can't prove is OpenKnowledge's, matching the desktop rename migration's
 * `dirHasOurState` guard.
 *
 * An OS-level read error (EACCES on a present file) is treated as NOT-ours here
 * (returns false) — the conservative direction: we decline to delete a dir we
 * couldn't verify, rather than risk removing a foreign one.
 */
export function stateDirIsOurs(userDataDir: string): boolean {
  const stateFile = join(userDataDir, 'state.json');
  if (!existsSync(stateFile)) return false;
  try {
    return parseRecentProjects(JSON.parse(readFileSync(stateFile, 'utf-8'))) !== null;
  } catch {
    return false;
  }
}

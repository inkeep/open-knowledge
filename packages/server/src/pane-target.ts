/**
 * Armed pane-target store for the Claude-pane deep-link override.
 *
 * `preview_start` opens the UI at its base (no hash). By default the app lands
 * presence-driven (the doc the calling agent is on). An agent can OVERRIDE that
 * by arming an explicit target via `preview_url({ armPaneTarget: true })` —
 * which writes the target route here, TTL-bounded so a stale arm cannot hijack
 * a later base-open. The UI server's `/api/config` reads it back on base-open.
 *
 * The stored `route` is a hash fragment (`#/<doc>` or `#/<folder>/`), so the app
 * can apply it to `window.location.hash` directly. State lives in `.ok/local/`
 * (gitignored, per-machine) — never content, never committed.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { tracedMkdirSync, tracedUnlinkSync, tracedWriteFileSync } from './fs-traced.ts';

const PANE_TARGET_FILE = 'pane-target.json';

/** How long an armed target stays valid (ms). A later base-open past this is presence-driven. */
export const PANE_TARGET_TTL_MS = 30_000;

interface PaneTargetState {
  /** Hash fragment to navigate to, e.g. `#/specs/foo/SPEC` or `#/specs/foo/`. */
  route: string;
  /** Epoch ms the target was armed; used for the TTL bound. */
  armedAtMs: number;
}

/**
 * Arm an explicit pane target (hash fragment). Overwrites any prior arm.
 * `localDir` is the project's `.ok/local/` directory (the lock dir) — the same
 * path both the arming tool and the UI server's `/api/config` resolve to.
 *
 * Enforces the in-app route shape (`#/…`) at the WRITE boundary so every reader
 * inherits the guarantee; a malformed route is a no-op (never persisted).
 * Returns whether the target was armed.
 */
export function armPaneTarget(
  localDir: string,
  route: string,
  nowMs: number = Date.now(),
): boolean {
  if (!route.startsWith('#/')) return false;
  tracedMkdirSync(localDir, { recursive: true });
  const state: PaneTargetState = { route, armedAtMs: nowMs };
  tracedWriteFileSync(resolve(localDir, PANE_TARGET_FILE), JSON.stringify(state));
  return true;
}

/**
 * Read the armed pane target, or `null` if none is armed or it has expired.
 * Expiry is deliberate: an arm older than the TTL must not hijack a base-open
 * the user triggered for an unrelated reason.
 */
export function readArmedPaneTarget(
  localDir: string,
  nowMs: number = Date.now(),
  ttlMs: number = PANE_TARGET_TTL_MS,
): string | null {
  const path = resolve(localDir, PANE_TARGET_FILE);
  if (!existsSync(path)) return null;
  try {
    const state = JSON.parse(readFileSync(path, 'utf-8')) as Partial<PaneTargetState>;
    if (typeof state.route !== 'string' || typeof state.armedAtMs !== 'number') return null;
    if (nowMs - state.armedAtMs > ttlMs) return null;
    return state.route;
  } catch (err) {
    // ENOENT (deleted between existsSync and read) and JSON parse errors are
    // benign races — stay silent. Persistent permission / IO errors, though,
    // would break every pane-target deep-link with no signal; surface those so
    // "preview_start never navigates" is diagnosable.
    const code = (err as { code?: string }).code;
    if (code === 'EACCES' || code === 'EPERM' || code === 'EIO') {
      process.stderr.write(
        `[pane-target] readArmedPaneTarget failed at ${path}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
    return null;
  }
}

/**
 * Clear any armed pane target. The app calls this AFTER it has applied the
 * target on a base-open, so a reload within the TTL doesn't re-navigate to a
 * target the user already saw (and may have navigated away from). Clearing on
 * apply rather than on read keeps the read non-destructive — `/api/config` is
 * fetched by several consumers (e.g. the collab-URL hook) and only the one that
 * actually applied the target should consume it. Best-effort: a missing file or
 * unlink failure is a no-op (the TTL bound already caps a stale arm's lifetime).
 */
export function clearArmedPaneTarget(localDir: string): void {
  const path = resolve(localDir, PANE_TARGET_FILE);
  if (!existsSync(path)) return;
  try {
    tracedUnlinkSync(path);
  } catch {
    // Already gone or unwritable — nothing to clear.
  }
}

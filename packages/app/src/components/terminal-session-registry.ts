/**
 * Module-scoped registry of live docked-terminal sessions, so a CLI launch can
 * decide whether to inject into an already-open matching session or open a new
 * tab.
 *
 * The session collection (which tab hosts which PTY) lives in `TerminalDock`,
 * and the per-session runtime state (PTY id, output activity, which CLI it is
 * running) lives inside each `TerminalSession`. Neither is reachable from the
 * launch decision point in `EditorPane` through React context without lifting
 * ownership across siblings, so each session publishes a small descriptor here
 * on mount and updates it as its state changes; the launcher reads it.
 *
 * Desktop-only in practice (the dock renders only on the Electron host), but the
 * module has no host dependency — it is a plain in-renderer map.
 *
 * "Idle" is intentionally conservative: a session counts as idle only when its
 * shell prompt is settled AND there has been no PTY output for
 * {@link IDLE_QUIET_MS}. A session mid-response (an agent streaming output) keeps
 * resetting its activity clock and so reads as busy — the launcher then opens a
 * new tab rather than interrupting the running turn. The conservative default is
 * load-bearing: "not idle" routes to the safe new-tab path.
 */

import type { TerminalCli } from '@inkeep/open-knowledge-core';

/**
 * No PTY output for this long ⇒ the session's shell prompt is treated as settled
 * and idle. Long enough that a streaming agent response (which emits output in
 * bursts) does not momentarily read as idle between chunks; short enough that a
 * genuinely-waiting prompt is injectable promptly after the user's pick.
 */
export const IDLE_QUIET_MS = 1200;

export interface TerminalSessionEntry {
  /** Stable client-side session id (the dock's tab id). */
  readonly id: string;
  /** Which CLI this session was launched to run, or `null` for a bare shell
   *  (a tab opened from the strip with no launch intent). A bare shell never
   *  matches a CLI launch — the user may be doing something unrelated in it. */
  readonly cli: TerminalCli | null;
  /** Live PTY id, or `null` before the PTY resolves / after it dies. */
  readonly ptyId: string | null;
  /** Epoch ms of the last PTY output byte. 0 until the first output lands. */
  lastOutputAt: number;
  /** True once the first shell output has landed (prompt is live). */
  hasOutput: boolean;
}

const sessions = new Map<string, TerminalSessionEntry>();

/** Register (or replace) a session descriptor. Called on session mount. */
export function registerTerminalSession(entry: TerminalSessionEntry): void {
  sessions.set(entry.id, entry);
}

/** Remove a session descriptor. Called on session unmount / PTY death. */
export function unregisterTerminalSession(id: string): void {
  sessions.delete(id);
}

/** Patch the mutable runtime fields of a registered session (ptyId, activity).
 *  No-op when the session is not registered (already torn down). */
export function updateTerminalSession(
  id: string,
  patch: Partial<Pick<TerminalSessionEntry, 'ptyId' | 'lastOutputAt' | 'hasOutput'>>,
): void {
  const entry = sessions.get(id);
  if (entry === undefined) return;
  sessions.set(id, { ...entry, ...patch });
}

/**
 * A session matching `cli` that is running and idle, or `null` when none
 * qualifies. "Matching" = same CLI binary; "idle" = prompt settled + no output
 * for {@link IDLE_QUIET_MS}. The most-recently-active qualifying session wins
 * (the user's likely focus). `now` is injectable for tests.
 */
export function findIdleMatchingSession(
  cli: TerminalCli,
  now: number = Date.now(),
): TerminalSessionEntry | null {
  let best: TerminalSessionEntry | null = null;
  for (const entry of sessions.values()) {
    if (entry.cli !== cli) continue;
    if (entry.ptyId === null) continue;
    if (!entry.hasOutput) continue;
    if (now - entry.lastOutputAt < IDLE_QUIET_MS) continue;
    if (best === null || entry.lastOutputAt > best.lastOutputAt) best = entry;
  }
  return best;
}

/** Test-only reset. */
export function _clearTerminalSessionRegistry(): void {
  sessions.clear();
}

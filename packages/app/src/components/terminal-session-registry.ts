import type { TerminalCli } from '@inkeep/open-knowledge-core';

export const IDLE_QUIET_MS = 1200;

export interface TerminalSessionEntry {
  readonly id: string;
  /** Which CLI this session was launched to run, or `null` for a bare shell
   *  (a tab opened from the strip with no launch intent). A bare shell never
   *  matches a CLI launch — the user may be doing something unrelated in it. */
  readonly cli: TerminalCli | null;
  readonly ptyId: string | null;
  lastOutputAt: number;
  hasOutput: boolean;
}

const sessions = new Map<string, TerminalSessionEntry>();

export function registerTerminalSession(entry: TerminalSessionEntry): void {
  sessions.set(entry.id, entry);
}

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

export function _clearTerminalSessionRegistry(): void {
  sessions.clear();
}

/**
 * The live agent session a passage can be appended to, published for surfaces
 * outside the sessions dock.
 *
 * `TerminalSessionsHost` already decides reuse-vs-launch when text arrives
 * (`dispatchAskAi`): a live thread takes it as a staged composer draft, a live
 * CLI tab as a no-carriage-return write into its input, and anything else falls
 * through to a fresh launch. That decision is made AFTER the click, from state
 * the host keeps privately — which is fine for behavior and useless for a
 * button that has to say where a batch is going BEFORE you commit to it.
 *
 * This is that missing half: the host publishes the same predicate it will act
 * on, so a caller can label the action honestly. The comment queue's send uses
 * it — with a session live, its menu offers "append to the open conversation";
 * with none, it falls back to the plain agent picker and starts a fresh turn.
 *
 * **Only ever holds a session the host would actually reuse.** A bare shell is
 * excluded on purpose: `terminal.input` writes bytes straight to the PTY, and a
 * shell in canonical mode treats each newline as accept-line, so appending
 * markdown there would RUN it. A reload-survivor tab is excluded too — it
 * rehydrates with its CLI-ness unrecoverable. Publishing either would let a
 * button promise an append the host then refuses.
 *
 * Dock position is deliberately not part of it. The dock hosts the same
 * sessions whether it sits bottom or right (`'right'` is the default), so
 * keying off a side would make the same click behave differently for no reason
 * a user could see.
 */

import type { TerminalCli } from '@inkeep/open-knowledge-core';
import { useSyncExternalStore } from 'react';

/**
 * Carries what a caller needs to RENDER the destination, not just name it — the
 * two halves of the dock draw their marks from different sources (a registry
 * manifest vs. the CLI brand set), and a consumer that had only a name would
 * fall back to whichever icon it could reach. That is how the send button ended
 * up showing the Claude mark while pointing at a Cursor tab.
 */
export type ReusableSession =
  | {
      /** The dock's session id — the threadId for a thread. */
      readonly id: string;
      readonly kind: 'thread';
      /** The agent's display name. */
      readonly label: string;
      /** Registry/custom agent id — picks the local brand mark. */
      readonly agentId: string;
      /** Registry-manifest icon URL, when the manifest has one. */
      readonly iconUrl?: string;
    }
  | {
      /** The dock's session id — `terminal-session-<n>`. */
      readonly id: string;
      readonly kind: 'terminal';
      /** The CLI's display name. */
      readonly label: string;
      /** Which CLI the tab runs — picks the brand mark. */
      readonly cli: TerminalCli;
    };

/**
 * One slot PER DOCK, not one slot.
 *
 * Both docks mount at once (the bottom terminal and the right agents panel) and
 * both publish on every change. With a single slot the last writer won: an
 * agents panel holding a live thread was overwritten by the terminal dock
 * publishing `null` for its empty tab list, and every surface outside the docks
 * then read "nothing to reuse" while a conversation sat open on screen.
 */
type DockSurface = 'agents' | 'terminal';
const bySurface = new Map<DockSurface, ReusableSession | null>();
let current: ReusableSession | null = null;
const listeners = new Set<() => void>();

/**
 * A thread outranks a terminal when both docks have something.
 *
 * Not arbitrary: the only caller that can take either is the Ask-AI plumbing,
 * which resolves its own destination anyway, while the comment surfaces send to
 * threads alone. Preferring the thread means the answer this returns is the one
 * a reader can act on.
 */
function resolveCurrent(): ReusableSession | null {
  return bySurface.get('agents') ?? bySurface.get('terminal') ?? null;
}

function same(a: ReusableSession | null, b: ReusableSession | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.id !== b.id || a.kind !== b.kind || a.label !== b.label) return false;
  // Compare what the icon is drawn from too, or a re-published session that
  // swapped its mark would be treated as unchanged.
  if (a.kind === 'thread' && b.kind === 'thread') {
    return a.agentId === b.agentId && a.iconUrl === b.iconUrl;
  }
  if (a.kind === 'terminal' && b.kind === 'terminal') return a.cli === b.cli;
  return false;
}

/**
 * Publish the calling dock's active session when it is reusable, `null` when it
 * is not. The host calls this on every change that could flip the answer —
 * active tab, session list, PTY resolution, thread arrival.
 *
 * `surface` is what keeps the two docks from overwriting each other; each owns
 * its own slot and the reader resolves across them.
 *
 * A value-equal publish is a no-op so `useSyncExternalStore` sees a stable
 * snapshot; the host re-publishes freely rather than tracking what changed.
 */
export function publishReusableSession(surface: DockSurface, next: ReusableSession | null): void {
  if (bySurface.has(surface) && same(bySurface.get(surface) ?? null, next)) return;
  bySurface.set(surface, next);
  const resolved = resolveCurrent();
  if (same(current, resolved)) return;
  current = resolved;
  for (const listener of listeners) listener();
}

/** The session an append would land in, or `null` when a send must start one. */
export function getReusableSession(): ReusableSession | null {
  return current;
}

export function subscribeReusableSession(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Subscribe to the appendable session. `getServerSnapshot` returns `null` so
 * SSR and the node test tier render the no-session state — the conservative
 * side, where a send starts a fresh turn instead of claiming an append.
 */
export function useReusableSession(): ReusableSession | null {
  return useSyncExternalStore(subscribeReusableSession, getReusableSession, () => null);
}

/** Test-only: drop the published session between cases. */
export function _resetReusableSession(): void {
  // The per-surface slots too, or one test's agents thread outranks the next
  // one's terminal publish and the change never reaches a subscriber.
  bySurface.clear();
  current = null;
  listeners.clear();
}

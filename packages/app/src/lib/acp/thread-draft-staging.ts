/**
 * One-shot staged composer text for a freshly-launched agent thread — the ACP
 * twin of the terminal launch intent's `stagePaste`.
 *
 * A selection send (⌘J / ⇧⌘J) and the Problems panel's "Ask AI" both hand the
 * user a composed passage they are meant to review and extend before sending.
 * On the terminal path that means writing into the CLI's input without a
 * trailing carriage return; on the thread path it means seeding the composer's
 * draft and leaving the send button to the user. Auto-submitting instead would
 * spend the customer's tokens on a keystroke the user may have mis-fired.
 *
 * Delivery is order-independent because the two ends race: `launchAgentThread`
 * stages once `createThread` resolves, while `ThreadView` subscribes when the
 * dock mounts its tab — and either can happen first. A value staged before
 * anyone subscribes is held until the first subscriber for that thread arrives;
 * a subscriber that arrives first is delivered to directly. Either way the value
 * is consumed exactly once, so a later remount of the same thread does not
 * re-seed a draft the user already cleared.
 */

/**
 * Staged text awaiting a subscriber, keyed by threadId.
 *
 * Module scope, so this is per-renderer and each window has its own map — the
 * same single-window assumption `inflightLaunches` makes in `launch-agent-thread`.
 *
 * An entry normally lives for microseconds: a docked thread force-mounts its
 * composer, so the subscriber arrives right after the stage. An entry only
 * lingers when the thread never mounts at all (closed before its lazy ThreadView
 * chunk resolves). Two consequences of not evicting: one short string per orphan
 * stays for the renderer's lifetime, and reopening that exact thread from archive
 * would hand its composer the old passage. Both are bounded and rare enough that
 * a TTL would add more moving parts than it removes.
 */
const pending = new Map<string, string>();

/** The live subscriber per threadId (a thread renders in at most one tab). */
const listeners = new Map<string, (text: string) => void>();

/**
 * Stage `text` as the opening draft for `threadId`. Delivered immediately when
 * that thread's composer is already listening, otherwise held for it. Empty /
 * whitespace-only text is ignored — there is nothing to review.
 */
export function stageThreadDraft(threadId: string, text: string): void {
  if (text.trim() === '') return;
  const listener = listeners.get(threadId);
  if (listener !== undefined) {
    listener(text);
    return;
  }
  pending.set(threadId, text);
}

/**
 * Subscribe `onDraft` to staged text for `threadId`, consuming anything already
 * staged. Returns the unsubscribe. The subscription is single-slot per thread:
 * a remount replaces the prior listener rather than fanning out, matching the
 * one-tab-per-thread invariant the dock maintains.
 */
export function subscribeStagedThreadDraft(
  threadId: string,
  onDraft: (text: string) => void,
): () => void {
  listeners.set(threadId, onDraft);
  const held = pending.get(threadId);
  if (held !== undefined) {
    pending.delete(threadId);
    onDraft(held);
  }
  return () => {
    // Only clear the slot when it is still ours — a remount that registered its
    // own listener before this cleanup ran must keep the newer one.
    if (listeners.get(threadId) === onDraft) listeners.delete(threadId);
  };
}

/** Test seam — drop all staged state between cases. */
export function resetStagedThreadDrafts(): void {
  pending.clear();
  listeners.clear();
}

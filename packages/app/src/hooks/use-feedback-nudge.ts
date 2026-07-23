/**
 * Visibility predicate for the proactive feedback card in the sidebar footer.
 *
 * The card is for engaged users past the honeymoon window: two weeks since the
 * first boot we can observe, and enough documents in the workspace. It gets
 * exactly one session on screen, on that device, and never returns — whether
 * the user answers it or ignores it.
 *
 * Two deliberate timing choices, both grounded in feedback-prompt research
 * (NN/g "Task, then ask"; Apple/Firebase show-once precedents):
 *
 *  - **Evaluated at launch, not on the fly.** Eligibility is decided once per
 *    session, when the workspace's document set has loaded — not the instant a
 *    live edit pushes the count across ten. Creating the tenth document is the
 *    start of a work chunk, the worst moment to surface a prompt; the card is
 *    simply present when the user next arrives instead of materializing mid-
 *    keystroke. The session's `latchEvaluated` call latches that one decision.
 *  - **Shown once, ever.** A prior session's `shownAt` suppresses the card for
 *    good. A fresh JS context starts with `session.isShown() === false`, and
 *    the eligibility predicate's `shownAt == null` clause rejects on a
 *    persisted show, so recording the show this session doesn't fold back
 *    into the guard.
 *
 * Gating inputs are parameters, not reads: `pages` and `ready` come from the
 * page list and `blocked` from the other footer nudges, so the hook stays
 * mountable in a DOM test without the page-list provider or the desktop bridge.
 *
 * Session state lives at MODULE scope, not in the component. The shadcn
 * Sidebar tree this card mounts under "remounts transparently across theme
 * toggles, sidebar width changes, and other parent-triggered re-mounts we
 * don't control" (see `update-notices-store`, which exists for the same
 * reason, and why the onboarding/subscribe cards derive visibility purely
 * from their stores). Per-mount refs would make a remount read this
 * session's just-recorded `shownAt` as "shown in a prior session" and
 * permanently hide a card the user was looking at.
 */

import { useEffect, useState, useSyncExternalStore } from 'react';
import {
  countUserDocuments,
  type FeedbackNudgeStore,
  feedbackNudgeStore,
  isFeedbackNudgeEligible,
} from '@/lib/feedback-nudge-store';

/** Forwarded to the feedback form for analytics attribution. */
export const FEEDBACK_NUDGE_SOURCE = 'proactive_card';

/**
 * One app session's nudge decisions. A JS context (one window, boot to
 * reload/quit) IS the session, so module scope survives React remounts and
 * resets exactly when a session ends. Injectable so tests get isolation.
 *
 * Closure-backed methods rather than mutable fields: the React Compiler
 * rejects direct property assignment on values reachable from a hook
 * ("This value cannot be modified"), but latching through a method call is
 * fine — the same shape as the store's `recordShown`.
 */
export interface FeedbackNudgeSession {
  /** The single launch-time eligibility decision has been made. */
  isEvaluated(): boolean;
  /** The card took its session on screen in THIS JS context. */
  isShown(): boolean;
  /** Latch the launch decision (idempotent). */
  latchEvaluated(): void;
  /** Latch that the card is up this session (idempotent). */
  latchShown(): void;
}

export function createFeedbackNudgeSession(): FeedbackNudgeSession {
  let evaluated = false;
  let shown = false;
  return {
    isEvaluated: () => evaluated,
    isShown: () => shown,
    latchEvaluated: () => {
      evaluated = true;
    },
    latchShown: () => {
      shown = true;
    },
  };
}

const appSession = createFeedbackNudgeSession();

export interface UseFeedbackNudgeOptions {
  /**
   * The workspace's document set, or null when unknown (no page-list provider).
   * Null fails closed: no set, no count, no card. `countUserDocuments` runs at
   * most once per session — only on the render that makes the launch decision.
   */
  pages: ReadonlySet<string> | null;
  /**
   * True once the page list has finished its cold load. The launch decision
   * waits for this so it reads the real document count, not the empty set the
   * provider starts with.
   */
  ready: boolean;
  /**
   * True when another nudge surface owns the footer at launch. If set when the
   * launch decision is made, the card stands down for the whole session and
   * tries again next launch — it never pops in mid-session when the other card
   * clears. (A notice that arrives AFTER the card is already showing does not
   * hide it; `blocked` gates only the launch decision.)
   */
  blocked: boolean;
  /** Injection seam for tests; production uses the singleton. */
  store?: FeedbackNudgeStore;
  /** Injection seam for tests; production uses the wall clock. */
  now?: () => number;
  /** Injection seam for tests; production uses the module session. */
  session?: FeedbackNudgeSession;
}

export function useFeedbackNudgeVisible({
  pages,
  ready,
  blocked,
  store = feedbackNudgeStore,
  now = Date.now,
  session = appSession,
}: UseFeedbackNudgeOptions): boolean {
  const { dismissed } = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);

  // Initialized from the session so a React remount re-adopts a card that is
  // already up — module state is what survives the remount; this mirror only
  // exists to make React re-render when the show first happens.
  const [shownThisSession, setShownThisSession] = useState(session.isShown());

  // Starts the two-week clock on the first boot that ever mounts this hook.
  // Idempotent, so StrictMode and remounts are no-ops.
  useEffect(() => {
    store.recordFirstSeen(now());
  }, [store, now]);

  useEffect(() => {
    // Session-scoped latch (module scope) rather than a per-mount ref: a
    // remount must neither re-run the decision nor mistake this session's
    // own `shownAt` for a prior session's.
    if (session.isEvaluated()) return;
    // The decision is made once, at launch, when the document set has loaded.
    if (!ready || pages == null) return;
    session.latchEvaluated();
    // Another footer card owns the space at launch → defer to the next launch
    // rather than pop in later this session when it clears. Latching above
    // before this check is what makes "blocked at launch" mean "next time",
    // not "the moment the other card goes away" — consistent with only ever
    // surfacing the card at launch, never mid-work.
    if (blocked) return;
    // A prior session's show suppresses here via the predicate's
    // `shownAt == null` clause — the session's shown latch is still unset in
    // a fresh JS context, so no separate prior-session guard is needed.
    if (!isFeedbackNudgeEligible(store.getSnapshot(), now(), countUserDocuments(pages))) return;
    store.recordShown(now());
    session.latchShown();
    setShownThisSession(true);
  }, [ready, blocked, pages, store, now, session]);

  return shownThisSession && !dismissed;
}

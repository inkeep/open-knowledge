import { useEffect, useState, useSyncExternalStore } from 'react';
import {
  countUserDocuments,
  type FeedbackNudgeStore,
  feedbackNudgeStore,
  isFeedbackNudgeEligible,
} from '@/lib/feedback-nudge-store';

export const FEEDBACK_NUDGE_SOURCE = 'proactive_card';

export interface FeedbackNudgeSession {
  isEvaluated(): boolean;
  isShown(): boolean;
  latchEvaluated(): void;
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
  pages: ReadonlySet<string> | null;
  ready: boolean;
  blocked: boolean;
  store?: FeedbackNudgeStore;
  now?: () => number;
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

  const [shownThisSession, setShownThisSession] = useState(session.isShown());

  useEffect(() => {
    store.recordFirstSeen(now());
  }, [store, now]);

  useEffect(() => {
    if (session.isEvaluated()) return;
    if (!ready || pages == null) return;
    session.latchEvaluated();
    if (blocked) return;
    if (!isFeedbackNudgeEligible(store.getSnapshot(), now(), countUserDocuments(pages))) return;
    store.recordShown(now());
    session.latchShown();
    setShownThisSession(true);
  }, [ready, blocked, pages, store, now, session]);

  return shownThisSession && !dismissed;
}

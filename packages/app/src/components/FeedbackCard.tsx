/**
 * FeedbackCard — the proactive "How do you like OpenKnowledge?" card in the
 * sidebar footer, shown once to engaged users past the honeymoon window (see
 * `feedback-nudge-store`). Mirrors `SubscribeCard`: same footer slot, same
 * bordered-card shell, form inlined rather than behind a dialog.
 *
 * Lifecycle:
 *   - Shown for exactly one session (see `use-feedback-nudge`), then never
 *     again on that device, whether the user engaged with it or ignored it.
 *   - The form's ✕ closes it AND stops the nudge for good (`dismiss()`).
 *   - A confirmed submit does the same — `FeedbackForm` raises its own
 *     "Thanks for the feedback!" toast, so the card just retires.
 *
 * `FeedbackCardMount` self-gates, so `FileSidebar` mounts it unconditionally.
 */

import { useLingui } from '@lingui/react/macro';
import { useSyncExternalStore } from 'react';
import { useOptionalPageList } from '@/components/PageListContext';
import { FEEDBACK_NUDGE_SOURCE, useFeedbackNudgeVisible } from '@/hooks/use-feedback-nudge';
import { feedbackNudgeStore } from '@/lib/feedback-nudge-store';
import { onboardingCardStore } from '@/lib/onboarding-card-store';
import { getNoticesSnapshot, subscribeToNotices } from '@/lib/update-notices-store';
import { FeedbackForm } from './FeedbackForm';

export function FeedbackCard({ onClose }: { onClose: () => void }) {
  const { t } = useLingui();
  return (
    <section
      // The heading is a <p> inside FeedbackForm, not an <h*>, so the landmark
      // carries its own label rather than aria-labelledby.
      aria-label={t`Share feedback`}
      className="mx-1 mb-1 overflow-hidden rounded-lg border bg-card text-card-foreground"
    >
      <div className="px-3 py-2.5">
        <FeedbackForm
          compact
          source={FEEDBACK_NUDGE_SOURCE}
          // Deliberately not the dialog's "How do you like OpenKnowledge?".
          // That title suits a surface the user opened on purpose; this card
          // arrives uninvited, sits beside "Stay in the loop" and "Get set up"
          // (both statements), and must not restate the Good / Not great
          // toggle directly beneath it.
          title={t`Tell us how it's going`}
          onDismiss={onClose}
          onSuccess={onClose}
        />
      </div>
    </section>
  );
}

export function FeedbackCardMount() {
  // Optional on purpose. This card is a leaf of the sidebar footer, and the
  // required hook would make `FileSidebar` itself demand a `PageListProvider`
  // it otherwise has no need for. Absent provider means the document count is
  // unknown, which fails closed: no count, no nudge. That matches how the
  // onboarding card treats an unconfirmable probe — suppress rather than
  // ambush someone we cannot vouch for.
  const pageList = useOptionalPageList();
  const onboarding = useSyncExternalStore(
    onboardingCardStore.subscribe,
    onboardingCardStore.getSnapshot,
    onboardingCardStore.getSnapshot,
  );
  const notices = useSyncExternalStore(subscribeToNotices, getNoticesSnapshot, getNoticesSnapshot);

  // The first-run card is showing, or a what's-new notice is up (which is where
  // the subscribe prompt rides). Both share this footer — don't stack a third ask.
  //
  // These are snapshot reads rather than the surfaces' own hooks on purpose:
  // `useOnboardingCardVisible` would run a second fresh-project probe (an IPC
  // round-trip plus an `/api/documents` fetch) for an answer already latched in
  // the store by the time a two-week-old install is being evaluated.
  const blocked =
    (onboarding.initialized && !onboarding.dismissed && !onboarding.completed) ||
    notices.length > 0;

  // Pass the raw page set, not a count: the hook counts at most once per
  // session, on the render that makes the launch decision, so the O(pages) walk
  // never runs on every sidebar render. `ready` gates that decision on the cold
  // load finishing, so it reads the real count rather than the empty set the
  // provider starts with.
  const visible = useFeedbackNudgeVisible({
    pages: pageList?.pages ?? null,
    ready: pageList != null && !pageList.loading,
    blocked,
  });

  if (!visible) return null;
  return <FeedbackCard onClose={() => feedbackNudgeStore.dismiss()} />;
}

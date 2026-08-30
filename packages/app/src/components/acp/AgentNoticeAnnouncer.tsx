import { useLingui } from '@lingui/react/macro';
import { type ReactNode, useEffect, useRef } from 'react';
import { createLiveRegionQueue, type LiveRegionQueue } from './live-region-queue';

/**
 * Long enough that a screen reader observes each announcement separately,
 * short enough that a pair of warnings from one turn still reads as prompt.
 * Chosen for observable separation rather than measured against how long a
 * warning takes to speak, which needs a real screen reader to settle.
 */
const ANNOUNCE_SPACING_MS = 150;

/**
 * Speaks runtime warnings that arrive while the reader is here, and stays
 * silent about the ones that were already history when the thread opened.
 *
 * A warning card is passive by design — it draws itself and waits — which
 * leaves a reader who cannot see the transcript with no cue that anything
 * appeared. This region is that cue, and only that: it never moves focus and
 * the card it describes stays exactly where it is.
 *
 * The replay boundary is the whole difficulty, and it is settled per notice
 * rather than per render. A thread's transcript arrives after the view is
 * already mounted, in one or more batches out of the server's retained log, so
 * "the model gained a notice" cannot by itself mean "a warning just happened"
 * — opening a month-old thread would recite every warning it ever produced.
 * Comparing each notice's own seq against the subscription's replay bound is
 * exact where counting is not: a batch that carries the tail of the retained
 * log AND a warning that landed after it is indistinguishable by count, and
 * the live half of it would be lost.
 *
 * Scoped to the thread the reader is looking at. A background thread's panel
 * is `display: none`, which takes its region out of the accessibility tree, so
 * a warning arriving there is drawn but not spoken and is found on the card
 * when the reader switches to it. Announcing it on reveal was rejected for the
 * same reason replay is silent: by then it is history, and speaking history is
 * the failure mode this region is built to avoid.
 */
export function AgentNoticeAnnouncer({
  notices,
  agentName,
  replayThroughSeq,
}: {
  /** Every agent notice in the transcript, in source order, with its seq. */
  notices: readonly { readonly seq: number; readonly text: string }[];
  agentName: string;
  /** Upper bound of the replayed window — at or below it is history. */
  replayThroughSeq: number;
}): ReactNode {
  const { t } = useLingui();
  const regionRef = useRef<HTMLDivElement | null>(null);
  const queueRef = useRef<LiveRegionQueue | null>(null);
  const spokenThroughRef = useRef(Number.NEGATIVE_INFINITY);

  // Declared before the announcing effect so the queue exists by the time that
  // one first runs — effects fire in declaration order.
  useEffect(() => {
    const queue = createLiveRegionQueue({
      region: () => regionRef.current,
      spacingMs: ANNOUNCE_SPACING_MS,
    });
    queueRef.current = queue;
    return () => {
      queue.dispose();
      queueRef.current = null;
    };
  }, []);

  useEffect(() => {
    const floor = Math.max(replayThroughSeq, spokenThroughRef.current);
    const arrived = notices.filter((item) => item.seq > floor);
    if (arrived.length === 0) return;
    spokenThroughRef.current = arrived[arrived.length - 1]?.seq ?? floor;
    queueRef.current?.announce(
      arrived.map((item) => {
        const headline = noticeHeadline(item.text);
        return t`${agentName} reported: ${headline}`;
      }),
    );
  }, [notices, agentName, replayThroughSeq, t]);

  // Mounted empty from the first render and filled later: a region that
  // appears already holding its text is commonly missed, and one added and
  // populated in the same cycle is missed outright.
  return (
    <div
      ref={regionRef}
      role="status"
      aria-live="polite"
      aria-atomic="true"
      className="sr-only"
      data-testid="agent-thread-warning-announcer"
    />
  );
}

/**
 * The warning's own opening line. The rest of a multi-paragraph config warning
 * stays on screen instead of being read into the polite queue, and what is
 * spoken is the agent's wording rather than a paraphrase of it.
 */
function noticeHeadline(text: string): string {
  return (text.split('\n', 1)[0] ?? '').trim();
}

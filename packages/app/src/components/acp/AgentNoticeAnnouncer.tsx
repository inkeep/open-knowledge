import { useLingui } from '@lingui/react/macro';
import { type ReactNode, useEffect, useRef } from 'react';
import { createLiveRegionQueue, type LiveRegionQueue } from './live-region-queue';

const ANNOUNCE_SPACING_MS = 150;

export function AgentNoticeAnnouncer({
  notices,
  agentName,
  replayThroughSeq,
}: {
  notices: readonly { readonly seq: number; readonly text: string }[];
  agentName: string;
  replayThroughSeq: number;
}): ReactNode {
  const { t } = useLingui();
  const regionRef = useRef<HTMLDivElement | null>(null);
  const queueRef = useRef<LiveRegionQueue | null>(null);
  const spokenThroughRef = useRef(Number.NEGATIVE_INFINITY);

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

function noticeHeadline(text: string): string {
  return (text.split('\n', 1)[0] ?? '').trim();
}

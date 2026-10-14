import { useLingui } from '@lingui/react/macro';
import { FeedbackCardMount } from '@/components/FeedbackCard';
import { UpdateNotices } from '@/components/UpdateNotices';

export function CornerCardStack() {
  const { t } = useLingui();
  return (
    <section
      aria-label={t`Updates and feedback`}
      data-testid="corner-card-stack"
      className="pointer-events-none fixed start-3 bottom-3 z-40 w-88 max-w-[calc(100vw-1.5rem)] has-[>:empty]:hidden"
    >
      <div
        data-testid="corner-card-stack-column"
        className="corner-card-column flex max-h-[calc(100vh-var(--ok-app-header-height,2.75rem)-1.5rem)] flex-col gap-2"
      >
        <UpdateNotices />
        <FeedbackCardMount />
      </div>
    </section>
  );
}

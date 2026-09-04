import { useRef } from 'react';
import { OkBlob } from '@/components/OkBlob';
import { nextRageStreak, RAGE_STREAK_TO_REVEAL } from '@/components/ok-blob-runner-logic';
import { MASCOT_VIEW_TRANSITION_NAME } from '@/lib/view-transition';

interface EmptyStateHeaderProps {
  readonly title: string;
  readonly subtitle?: string;
  readonly celebrateSignal: number;
  readonly onRageStreak?: () => void;
}

export function EmptyStateHeader({
  title,
  subtitle,
  celebrateSignal,
  onRageStreak,
}: EmptyStateHeaderProps) {
  const streakRef = useRef(0);
  const lastRageAtRef = useRef<number | null>(null);

  function handleRage() {
    const now =
      typeof performance !== 'undefined' && typeof performance.now === 'function'
        ? performance.now()
        : Date.now();
    const previous = lastRageAtRef.current;
    const dt = previous === null ? Number.POSITIVE_INFINITY : now - previous;
    lastRageAtRef.current = now;
    const streak = nextRageStreak(streakRef.current, dt);
    streakRef.current = streak;
    if (streak < RAGE_STREAK_TO_REVEAL) return;
    streakRef.current = 0;
    onRageStreak?.();
  }

  return (
    <div className="flex flex-col items-start gap-3 @md/emptystate:flex-row @md/emptystate:items-center @md/emptystate:gap-4">
      <OkBlob
        size={64}
        celebrateSignal={celebrateSignal}
        onRage={onRageStreak ? handleRage : undefined}
        style={onRageStreak ? { viewTransitionName: MASCOT_VIEW_TRANSITION_NAME } : undefined}
      />
      <div className="flex flex-col gap-2">
        <h2 className="text-2xl font-light tracking-tighter text-balance">{title}</h2>
        {subtitle ? <p className="text-sm text-muted-foreground">{subtitle}</p> : null}
      </div>
    </div>
  );
}

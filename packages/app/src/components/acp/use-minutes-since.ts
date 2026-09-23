import { useLayoutEffect, useState } from 'react';

const TICK_MS = 30_000;

export function minutesSince(since: number, now: number): number {
  return Math.max(1, Math.floor((now - since) / 60_000));
}

export function useMinutesSince(since: number | undefined): number {
  const [now, setNow] = useState(0);
  useLayoutEffect(() => {
    if (since === undefined) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, [since]);
  return since === undefined ? 0 : minutesSince(since, now);
}

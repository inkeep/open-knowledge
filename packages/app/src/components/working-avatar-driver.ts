/**
 * One rAF loop for every {@link WorkingAvatar} on the page.
 *
 * Each avatar drives its own `d` attribute imperatively (React re-rendering a
 * 250-number path string at 60fps would be pure waste), so the loop itself is
 * shared but the clock is not: each subscriber's elapsed time counts from its
 * own join, so a turn that starts always opens on the mascot's home pose rather
 * than dropping in mid-cycle at whatever shape a page-lifetime clock had
 * reached. The loop stops entirely once the last subscriber leaves.
 */

type Tick = (elapsedSeconds: number) => void;

const subscribers = new Map<Tick, number>();
let frame = 0;

function now(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

function loop(): void {
  const t = now();
  for (const [tick, joinedAt] of subscribers) tick((t - joinedAt) / 1000);
  // A subscriber that unsubscribes from inside its own tick cancels the frame
  // that is already executing, which is a no-op — without this check the
  // reschedule below would revive an empty loop for the page's lifetime.
  if (subscribers.size === 0) {
    frame = 0;
    return;
  }
  frame = requestAnimationFrame(loop);
}

/** Subscribe to the shared loop. Returns an unsubscribe function. */
export function subscribeToMorphClock(tick: Tick): () => void {
  subscribers.set(tick, now());
  if (frame === 0 && typeof requestAnimationFrame === 'function') {
    frame = requestAnimationFrame(loop);
  }
  return () => {
    subscribers.delete(tick);
    if (subscribers.size === 0 && frame !== 0) {
      cancelAnimationFrame(frame);
      frame = 0;
    }
  };
}

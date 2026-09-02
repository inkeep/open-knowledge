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
  if (subscribers.size === 0) {
    frame = 0;
    return;
  }
  frame = requestAnimationFrame(loop);
}

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

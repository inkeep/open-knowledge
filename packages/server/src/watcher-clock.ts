export interface WatcherTimer {
  unref(): unknown;
}

export interface WatcherClock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): WatcherTimer;
  clearTimeout(timer: WatcherTimer | null | undefined): void;
  setInterval(callback: () => void, intervalMs: number): WatcherTimer;
  clearInterval(timer: WatcherTimer | null | undefined): void;
}

export const systemWatcherClock: WatcherClock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (timer) => {
    if (timer) clearTimeout(timer as NodeJS.Timeout);
  },
  setInterval: (callback, intervalMs) => setInterval(callback, intervalMs),
  clearInterval: (timer) => {
    if (timer) clearInterval(timer as NodeJS.Timeout);
  },
};

const installed: WatcherClock[] = [];

export function watcherClock(): WatcherClock {
  return installed[installed.length - 1] ?? systemWatcherClock;
}

export function installWatcherClock(clock: WatcherClock): () => void {
  installed.push(clock);
  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    const index = installed.lastIndexOf(clock);
    if (index >= 0) installed.splice(index, 1);
  };
}

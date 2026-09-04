export interface LiveRegionQueue {
  announce(messages: readonly string[]): void;
  dispose(): void;
}

export const CLEAR_TO_WRITE_MS = 50;

export function createLiveRegionQueue(options: {
  region: () => HTMLElement | null;
  spacingMs: number;
}): LiveRegionQueue {
  const pending: string[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;

  const drain = (): void => {
    const next = pending.shift();
    if (next === undefined) {
      timer = null;
      return;
    }
    const cleared = options.region();
    if (cleared !== null) cleared.textContent = '';
    timer = setTimeout(() => {
      const region = options.region();
      if (region !== null) region.textContent = next;
      timer = setTimeout(drain, options.spacingMs);
    }, CLEAR_TO_WRITE_MS);
  };

  return {
    announce(messages: readonly string[]): void {
      if (messages.length === 0) return;
      pending.push(...messages);
      if (timer === null) drain();
    },
    dispose(): void {
      pending.length = 0;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}

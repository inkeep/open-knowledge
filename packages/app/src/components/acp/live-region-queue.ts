/**
 * Serializing writer for one polite live region.
 *
 * Two properties assistive technology needs that a plain `textContent = message`
 * assignment does not provide:
 *
 * - **Consecutive messages are spaced.** A second write in the same tick
 *   replaces the first before a screen reader has observed it, so a burst of
 *   arrivals is heard as a single announcement, or as only the last one.
 * - **An identical message announces again.** Screen readers speak observed
 *   content *changes*, so re-assigning the same string is a silent no-op. MDN's
 *   live-region guidance is to clear the region before injecting the new
 *   content, and the clear has to land in its own task: a clear and a write
 *   inside one task collapse into a single accessibility-tree update whose net
 *   content is unchanged, which is the very no-op being worked around.
 *
 * Writes are imperative rather than React state because React batches, and a
 * batched pair of state updates collapses to the final string, which is exactly
 * the overwrite this queue exists to prevent.
 *
 * `SelectionAnnouncer` in the editor writes its own region the same way, minus
 * the queue — it announces one debounced selection rather than a burst, so it
 * has nothing to serialize.
 *
 * The alternative shape is an additions-based region — `aria-relevant`
 * `additions`, `aria-atomic` false — that appends one child per message and
 * gets both properties from the append itself, with no timer and no
 * serialization state. `sonner`, already a dependency here, announces toasts
 * that way. It is not adopted for this region because a transcript is
 * long-lived and unbounded, so the region would accrete one child per warning
 * for as long as the thread stays open.
 */
export interface LiveRegionQueue {
  /** Queue messages for announcement, spoken in the order given. */
  announce(messages: readonly string[]): void;
  /** Drop anything still queued and cancel the pending drain. */
  dispose(): void;
}

/**
 * How long the region stays empty before its next message lands. Only has to
 * outlast the browser's own accessibility-tree update so the empty state is
 * observed on its own; it is not a reading pause.
 */
export const CLEAR_TO_WRITE_MS = 50;

export function createLiveRegionQueue(options: {
  /** Resolved per write, since the region's ref is empty until after mount. */
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
      // Keep the slot held even with nothing else queued: an arrival landing a
      // few milliseconds from now must still wait out the spacing rather than
      // overwrite what was just written.
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

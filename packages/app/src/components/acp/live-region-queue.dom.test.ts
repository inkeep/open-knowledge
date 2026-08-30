/**
 * The announcement mechanism on its own, without React: what reaches the live
 * region and in which order. The failure this guards against is silent — a
 * region whose text ends up correct while a screen reader heard one message
 * instead of three — so the assertions watch the region as it changes rather
 * than the settled text.
 */

import { afterEach, describe, expect, test, vi } from 'vitest';
import { CLEAR_TO_WRITE_MS, createLiveRegionQueue } from './live-region-queue';

const SPACING_MS = 150;

/**
 * Records the region's mutation history rather than its settled text. A
 * mutation observer is the closest stand-in available for how a screen reader
 * watches a live region: it sees each change as it happens, not the value left
 * behind at the end.
 *
 * A clear shows up as a removal with nothing added; a write shows up as the
 * inserted text.
 */
function watchRegion(): { region: HTMLElement; steps: string[] } {
  const region = document.createElement('div');
  document.body.append(region);
  const steps: string[] = [];
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.addedNodes.length === 0) {
        steps.push('<cleared>');
        continue;
      }
      for (const node of record.addedNodes) steps.push(node.textContent ?? '');
    }
  });
  observer.observe(region, { childList: true, characterData: true, subtree: true });
  return { region, steps };
}

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe('live region queue', () => {
  test('announces a single message', () => {
    vi.useFakeTimers();
    const { region } = watchRegion();
    const queue = createLiveRegionQueue({ region: () => region, spacingMs: SPACING_MS });

    queue.announce(['first warning']);
    vi.advanceTimersByTime(CLEAR_TO_WRITE_MS);

    expect(region.textContent).toBe('first warning');
    queue.dispose();
  });

  test('spaces a burst so a later message cannot overwrite an unheard one', () => {
    vi.useFakeTimers();
    const { region } = watchRegion();
    const queue = createLiveRegionQueue({ region: () => region, spacingMs: SPACING_MS });

    queue.announce(['first warning', 'second warning', 'third warning']);

    vi.advanceTimersByTime(CLEAR_TO_WRITE_MS);
    expect(region.textContent).toBe('first warning');
    vi.advanceTimersByTime(SPACING_MS + CLEAR_TO_WRITE_MS);
    expect(region.textContent).toBe('second warning');
    vi.advanceTimersByTime(SPACING_MS + CLEAR_TO_WRITE_MS);
    expect(region.textContent).toBe('third warning');
    queue.dispose();
  });

  test('empties the region in its own task before repeating an identical message', () => {
    vi.useFakeTimers();
    const { region } = watchRegion();
    const queue = createLiveRegionQueue({ region: () => region, spacingMs: SPACING_MS });

    queue.announce(['the agent reported a warning', 'the agent reported a warning']);
    vi.advanceTimersByTime(CLEAR_TO_WRITE_MS);
    expect(region.textContent).toBe('the agent reported a warning');

    // The clear has to be observable on its own. A browser folds every DOM
    // change made in one task into a single accessibility-tree update, so a
    // clear and a write landing together leave the region's content
    // unchanged — which is the silent no-op the clear exists to avoid.
    vi.advanceTimersByTime(SPACING_MS);
    expect(region.textContent).toBe('');

    vi.advanceTimersByTime(CLEAR_TO_WRITE_MS);
    expect(region.textContent).toBe('the agent reported a warning');
    queue.dispose();
  });

  test('reaches the region as write, clear, write for a repeated message', async () => {
    const { region, steps } = watchRegion();
    const queue = createLiveRegionQueue({ region: () => region, spacingMs: 0 });

    queue.announce(['the agent reported a warning', 'the agent reported a warning']);
    // Real timers: the drain has to actually run, and a mutation observer
    // delivers on the microtask queue rather than on a timer.
    await new Promise((resolve) => setTimeout(resolve, CLEAR_TO_WRITE_MS * 4));

    expect(steps).toEqual([
      'the agent reported a warning',
      '<cleared>',
      'the agent reported a warning',
    ]);
    queue.dispose();
  });

  test('holds the spacing across separate arrivals, not just within one burst', () => {
    vi.useFakeTimers();
    const { region } = watchRegion();
    const queue = createLiveRegionQueue({ region: () => region, spacingMs: SPACING_MS });

    queue.announce(['first warning']);
    vi.advanceTimersByTime(CLEAR_TO_WRITE_MS);
    queue.announce(['second warning']);

    // Half a spacing interval later the first message is still standing.
    vi.advanceTimersByTime(SPACING_MS / 2);
    expect(region.textContent).toBe('first warning');
    vi.advanceTimersByTime(SPACING_MS / 2 + CLEAR_TO_WRITE_MS);
    expect(region.textContent).toBe('second warning');
    queue.dispose();
  });

  test('announces nothing for an empty batch', () => {
    vi.useFakeTimers();
    const { region } = watchRegion();
    const queue = createLiveRegionQueue({ region: () => region, spacingMs: SPACING_MS });

    queue.announce([]);
    vi.advanceTimersByTime(SPACING_MS * 4);

    expect(region.textContent).toBe('');
    queue.dispose();
  });

  test('drops queued messages once disposed', () => {
    vi.useFakeTimers();
    const { region } = watchRegion();
    const queue = createLiveRegionQueue({ region: () => region, spacingMs: SPACING_MS });

    queue.announce(['first warning', 'second warning']);
    vi.advanceTimersByTime(CLEAR_TO_WRITE_MS);
    queue.dispose();
    vi.advanceTimersByTime(SPACING_MS * 4);

    expect(region.textContent).toBe('first warning');
  });
});

import { afterEach, describe, expect, test, vi } from 'vitest';
import { CLEAR_TO_WRITE_MS, createLiveRegionQueue } from './live-region-queue';

const SPACING_MS = 150;

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

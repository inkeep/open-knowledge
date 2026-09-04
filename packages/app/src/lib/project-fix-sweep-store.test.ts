import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  CAPACITY_PROBLEM_TYPE,
  SWEEP_PACE_DELAY_MS,
  type SweepFixOutcome,
  sweepProgressInterval,
} from '@/components/problems-sweep';
import {
  __resetProjectFixSweepForTests,
  cancelProjectFixSweep,
  getProjectFixSweepProgress,
  type ProjectFixSweepItem,
  startProjectFixSweep,
  subscribeToProjectFixSweepSettled,
} from './project-fix-sweep-store';

const toasts = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn(), info: vi.fn() }));
vi.mock('sonner', () => ({ toast: toasts }));

function recordingSleep(): { sleep: (ms: number) => Promise<void>; waited: number[] } {
  const waited: number[] = [];
  return {
    sleep: async (ms: number) => {
      waited.push(ms);
    },
    waited,
  };
}

function files(count: number): ProjectFixSweepItem[] {
  return Array.from({ length: count }, (_, index) => ({ file: `doc-${index}.md` }));
}

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  __resetProjectFixSweepForTests();
  toasts.error.mockClear();
  toasts.success.mockClear();
  toasts.info.mockClear();
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  __resetProjectFixSweepForTests();
  warn.mockRestore();
});

describe('startProjectFixSweep — progress', () => {
  test('publishes the total up front so the counter reads N/M before the first fix', async () => {
    const seen: (number | null)[] = [];
    await startProjectFixSweep({
      items: files(3),
      sleep: async () => {},
      fixItem: async () => {
        seen.push(getProjectFixSweepProgress()?.total ?? null);
        return { ok: true };
      },
    });
    expect(seen).toEqual([3, 3, 3]);
  });

  test('advances the published count in chunks as the sweep runs', async () => {
    const total = 30;
    const interval = sweepProgressInterval(total);
    expect(interval).toBeGreaterThan(1);
    const seen: number[] = [];
    await startProjectFixSweep({
      items: files(total),
      sleep: async () => {},
      fixItem: async () => {
        seen.push(getProjectFixSweepProgress()?.done ?? -1);
        return { ok: true };
      },
    });
    expect(seen[0]).toBe(0);
    expect([...seen].sort((a, b) => a - b)).toEqual(seen);
    expect(new Set(seen).size).toBeLessThan(total);
    expect(seen.at(-1)).toBe(Math.floor((total - 1) / interval) * interval);
  });

  test('clears progress when the sweep settles, so the Fix all button re-enables', async () => {
    await startProjectFixSweep({
      items: files(2),
      sleep: async () => {},
      fixItem: async () => ({ ok: true }),
    });
    expect(getProjectFixSweepProgress()).toBeNull();
  });

  test('paces between files using the injected sleep', async () => {
    const { sleep, waited } = recordingSleep();
    await startProjectFixSweep({
      items: files(3),
      sleep,
      fixItem: async () => ({ ok: true }),
    });
    expect(waited).toEqual([SWEEP_PACE_DELAY_MS, SWEEP_PACE_DELAY_MS]);
  });

  test('an empty file list starts nothing', async () => {
    const settled = vi.fn();
    subscribeToProjectFixSweepSettled(settled);
    const fixItem = vi.fn(async (): Promise<SweepFixOutcome> => ({ ok: true }));
    await startProjectFixSweep({ items: [], fixItem, sleep: async () => {} });
    expect(fixItem).not.toHaveBeenCalled();
    expect(toasts.success).not.toHaveBeenCalled();
    expect(getProjectFixSweepProgress()).toBeNull();
    expect(settled).not.toHaveBeenCalled();
  });
});

describe('startProjectFixSweep — one sweep at a time', () => {
  test('refuses a second start while one is running, however many panels ask', async () => {
    const attempts: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const firstFixLanded = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let held: (() => void) | undefined;
    const parked = new Promise<void>((resolve) => {
      held = resolve;
    });
    const first = startProjectFixSweep({
      items: files(2),
      sleep: async () => {},
      fixItem: async (item) => {
        attempts.push(item.file);
        if (item.file === 'doc-0.md') {
          releaseFirst?.();
          await parked;
        }
        return { ok: true };
      },
    });
    await firstFixLanded;

    const second = vi.fn(async (): Promise<SweepFixOutcome> => ({ ok: true }));
    await startProjectFixSweep({ items: files(5), fixItem: second, sleep: async () => {} });
    expect(second).not.toHaveBeenCalled();
    expect(getProjectFixSweepProgress()?.total).toBe(2);

    held?.();
    await first;
    expect(attempts).toHaveLength(2);
  });

  test('a stopped sweep does not poison the next one', async () => {
    await startProjectFixSweep({
      items: files(2),
      sleep: async () => {},
      fixItem: async () => {
        cancelProjectFixSweep();
        return { ok: true };
      },
    });
    const attempts: string[] = [];
    await startProjectFixSweep({
      items: files(2),
      sleep: async () => {},
      fixItem: async (item) => {
        attempts.push(item.file);
        return { ok: true };
      },
    });
    expect(attempts).toEqual(['doc-0.md', 'doc-1.md']);
  });
});

describe('startProjectFixSweep — how a sweep ends', () => {
  test('reports a clean run, pluralising the count', async () => {
    await startProjectFixSweep({
      items: files(2),
      sleep: async () => {},
      fixItem: async () => ({ ok: true }),
    });
    expect(toasts.success).toHaveBeenCalledTimes(1);
    expect(String(toasts.success.mock.calls[0]?.[0])).toContain('2 files');
    expect(toasts.error).not.toHaveBeenCalled();
    expect(toasts.info).not.toHaveBeenCalled();
  });

  test('a single-file sweep does not report "1 files"', async () => {
    await startProjectFixSweep({
      items: files(1),
      sleep: async () => {},
      fixItem: async () => ({ ok: true }),
    });
    expect(String(toasts.success.mock.calls[0]?.[0])).toContain('1 file');
    expect(String(toasts.success.mock.calls[0]?.[0])).not.toContain('1 files');
  });

  test('a user stop leaves earlier fixes in place and says so', async () => {
    const attempts: string[] = [];
    await startProjectFixSweep({
      items: files(4),
      sleep: async () => {},
      fixItem: async (item) => {
        attempts.push(item.file);
        cancelProjectFixSweep();
        return { ok: true };
      },
    });
    expect(attempts).toEqual(['doc-0.md']);
    expect(toasts.info).toHaveBeenCalledTimes(1);
    expect(String(toasts.info.mock.calls[0]?.[0])).toContain('already fixed stay fixed');
    expect(toasts.success).not.toHaveBeenCalled();
    expect(toasts.error).not.toHaveBeenCalled();
  });

  test('names the first casualty and logs the whole set when files fail', async () => {
    await startProjectFixSweep({
      items: files(3),
      sleep: async () => {},
      fixItem: async (item) =>
        item.file === 'doc-0.md'
          ? { ok: false, errorDetail: 'conflict', status: 409, problemType: null }
          : { ok: true },
    });
    expect(toasts.error).toHaveBeenCalledTimes(1);
    expect(String(toasts.error.mock.calls[0]?.[0])).toContain('1 of 3');
    expect(toasts.error.mock.calls[0]?.[1]).toEqual({ description: 'doc-0.md — conflict' });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('1 of 3 files failed'), [
      { file: 'doc-0.md', detail: 'conflict' },
    ]);
    expect(toasts.success).not.toHaveBeenCalled();
  });

  test('a stop landing on a failed fix logs it without blaming the user for it', async () => {
    await startProjectFixSweep({
      items: files(3),
      sleep: async () => {},
      fixItem: async () => {
        cancelProjectFixSweep();
        return { ok: false, errorDetail: null, status: 500, problemType: null };
      },
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('1 of 3 files failed'), [
      { file: 'doc-0.md', detail: null },
    ]);
    expect(toasts.error).not.toHaveBeenCalled();
    expect(toasts.info).toHaveBeenCalledTimes(1);
  });

  test('retries a capacity refusal rather than reporting it as a failure', async () => {
    const attempts: string[] = [];
    let refusals = 1;
    const { sleep } = recordingSleep();
    await startProjectFixSweep({
      items: files(1),
      sleep,
      fixItem: async (item) => {
        attempts.push(item.file);
        if (refusals-- > 0) {
          return {
            ok: false,
            errorDetail: null,
            status: 503,
            problemType: CAPACITY_PROBLEM_TYPE,
          };
        }
        return { ok: true };
      },
    });
    expect(attempts).toEqual(['doc-0.md', 'doc-0.md']);
    expect(toasts.error).not.toHaveBeenCalled();
    expect(toasts.success).toHaveBeenCalledTimes(1);
  });

  test('a fixItem that rejects clears the counter instead of wedging it', async () => {
    const settled = vi.fn();
    subscribeToProjectFixSweepSettled(settled);
    await startProjectFixSweep({
      items: files(2),
      sleep: async () => {},
      fixItem: async () => {
        throw new Error('boom');
      },
    });
    expect(getProjectFixSweepProgress()).toBeNull();
    expect(toasts.error).toHaveBeenCalledTimes(1);
    expect(settled).toHaveBeenCalledTimes(1);
  });

  test('settled listeners fire even when reporting the outcome throws', async () => {
    const settled = vi.fn();
    subscribeToProjectFixSweepSettled(settled);
    toasts.success.mockImplementationOnce(() => {
      throw new Error('toast blew up');
    });
    await expect(
      startProjectFixSweep({
        items: files(1),
        sleep: async () => {},
        fixItem: async () => ({ ok: true }),
      }),
    ).rejects.toThrow('toast blew up');
    expect(settled).toHaveBeenCalledTimes(1);
    expect(getProjectFixSweepProgress()).toBeNull();
  });
});

describe('subscribeToProjectFixSweepSettled', () => {
  test('fires on a clean finish, on a stop, and on failures', async () => {
    const settled = vi.fn();
    subscribeToProjectFixSweepSettled(settled);

    await startProjectFixSweep({
      items: files(1),
      sleep: async () => {},
      fixItem: async () => ({ ok: true }),
    });
    expect(settled).toHaveBeenCalledTimes(1);

    await startProjectFixSweep({
      items: files(2),
      sleep: async () => {},
      fixItem: async () => {
        cancelProjectFixSweep();
        return { ok: true };
      },
    });
    expect(settled).toHaveBeenCalledTimes(2);

    await startProjectFixSweep({
      items: files(1),
      sleep: async () => {},
      fixItem: async () => ({ ok: false, errorDetail: null, status: 500, problemType: null }),
    });
    expect(settled).toHaveBeenCalledTimes(3);
  });

  test('fires only after the progress counter has cleared', async () => {
    let progressAtSettle: unknown = 'unset';
    subscribeToProjectFixSweepSettled(() => {
      progressAtSettle = getProjectFixSweepProgress();
    });
    await startProjectFixSweep({
      items: files(1),
      sleep: async () => {},
      fixItem: async () => ({ ok: true }),
    });
    expect(progressAtSettle).toBeNull();
  });

  test('unsubscribes', async () => {
    const settled = vi.fn();
    subscribeToProjectFixSweepSettled(settled)();
    await startProjectFixSweep({
      items: files(1),
      sleep: async () => {},
      fixItem: async () => ({ ok: true }),
    });
    expect(settled).not.toHaveBeenCalled();
  });
});

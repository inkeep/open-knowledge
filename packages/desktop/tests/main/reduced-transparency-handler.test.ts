import { describe, expect, test, vi } from 'vitest';

import {
  applyReducedTransparency,
  type BrowserWindowVibrancyTarget,
  type ReducedTransparencyDeps,
  setPreferredWindowVibrancy,
} from '../../src/main/reduced-transparency-handler.ts';

interface WindowFixture {
  win: BrowserWindowVibrancyTarget;
  setVibrancy: ReturnType<typeof vi.fn>;
  isDestroyed: ReturnType<typeof vi.fn>;
}

function makeWindow(opts?: { destroyed?: boolean }): WindowFixture {
  const setVibrancy = vi.fn(() => {});
  const isDestroyed = vi.fn(() => opts?.destroyed === true);
  return {
    win: {
      setVibrancy: setVibrancy as unknown as (mat: 'sidebar' | 'window' | null) => void,
      isDestroyed: isDestroyed as unknown as () => boolean,
    },
    setVibrancy,
    isDestroyed,
  };
}

describe('applyReducedTransparency — disable path (reduced=true)', () => {
  test('sets setVibrancy(null) on every non-destroyed window', () => {
    const a = makeWindow();
    const b = makeWindow();
    const deps: ReducedTransparencyDeps = {
      getAllWindows: () => [a.win, b.win],
      defaultVibrancy: 'sidebar',
      warn: () => {},
    };

    applyReducedTransparency(deps, true);

    expect(a.setVibrancy).toHaveBeenCalledTimes(1);
    expect(a.setVibrancy.mock.calls[0]).toEqual([null]);
    expect(b.setVibrancy).toHaveBeenCalledTimes(1);
    expect(b.setVibrancy.mock.calls[0]).toEqual([null]);
  });

  test('skips destroyed windows', () => {
    const live = makeWindow();
    const dead = makeWindow({ destroyed: true });
    const deps: ReducedTransparencyDeps = {
      getAllWindows: () => [live.win, dead.win],
      defaultVibrancy: 'sidebar',
    };

    applyReducedTransparency(deps, true);

    expect(live.setVibrancy).toHaveBeenCalledTimes(1);
    expect(dead.setVibrancy).not.toHaveBeenCalled();
  });

  test('a window stub without isDestroyed does not throw (optional-chain guard)', () => {
    const setVibrancy = vi.fn(() => {});
    const win: BrowserWindowVibrancyTarget = {
      setVibrancy: setVibrancy as unknown as (mat: 'sidebar' | 'window' | null) => void,
    };
    const deps: ReducedTransparencyDeps = {
      getAllWindows: () => [win],
      defaultVibrancy: 'sidebar',
    };

    expect(() => applyReducedTransparency(deps, true)).not.toThrow();
    expect(setVibrancy).toHaveBeenCalledWith(null);
  });
});

describe('applyReducedTransparency — restore path (reduced=false)', () => {
  test('sets setVibrancy(defaultVibrancy) on every non-destroyed window', () => {
    const a = makeWindow();
    const b = makeWindow();
    const deps: ReducedTransparencyDeps = {
      getAllWindows: () => [a.win, b.win],
      defaultVibrancy: 'sidebar',
    };

    applyReducedTransparency(deps, false);

    expect(a.setVibrancy.mock.calls[0]).toEqual(['sidebar']);
    expect(b.setVibrancy.mock.calls[0]).toEqual(['sidebar']);
  });

  test('honors defaultVibrancy=window (fallback path)', () => {
    const w = makeWindow();
    const deps: ReducedTransparencyDeps = {
      getAllWindows: () => [w.win],
      defaultVibrancy: 'window',
    };

    applyReducedTransparency(deps, false);

    expect(w.setVibrancy.mock.calls[0]).toEqual(['window']);
  });

  test('restores a preferred material without changing the shared default', () => {
    const editor = makeWindow();
    const note = makeWindow();
    setPreferredWindowVibrancy(note.win, 'window');
    const deps: ReducedTransparencyDeps = {
      getAllWindows: () => [editor.win, note.win],
      defaultVibrancy: 'sidebar',
    };

    applyReducedTransparency(deps, false);

    expect(editor.setVibrancy.mock.calls[0]).toEqual(['sidebar']);
    expect(note.setVibrancy.mock.calls[0]).toEqual(['window']);
  });

  test('reduced transparency disables preferred and default materials alike', () => {
    const editor = makeWindow();
    const note = makeWindow();
    setPreferredWindowVibrancy(note.win, 'window');
    const deps: ReducedTransparencyDeps = {
      getAllWindows: () => [editor.win, note.win],
      defaultVibrancy: 'sidebar',
    };

    applyReducedTransparency(deps, true);

    expect(editor.setVibrancy.mock.calls[0]).toEqual([null]);
    expect(note.setVibrancy.mock.calls[0]).toEqual([null]);
  });
});

describe('applyReducedTransparency — diagnostic logging', () => {
  test('emits structured warn with event/reducedTransparency/vibrancy/windowCount on disable', () => {
    const a = makeWindow();
    const b = makeWindow();
    const warn = vi.fn(() => {});
    const deps: ReducedTransparencyDeps = {
      getAllWindows: () => [a.win, b.win],
      defaultVibrancy: 'sidebar',
      warn,
    };

    applyReducedTransparency(deps, true);

    expect(warn).toHaveBeenCalledTimes(1);
    const line = warn.mock.calls[0]?.[0] as unknown as string;
    expect(typeof line).toBe('string');
    const parsed = JSON.parse(line);
    expect(parsed.event).toBe('reduced-transparency-applied');
    expect(parsed.reducedTransparency).toBe(true);
    expect(parsed.vibrancy).toBe(null);
    expect(parsed.windowCount).toBe(2);
  });

  test('emits structured warn with vibrancy=defaultVibrancy on restore', () => {
    const a = makeWindow();
    const warn = vi.fn(() => {});
    const deps: ReducedTransparencyDeps = {
      getAllWindows: () => [a.win],
      defaultVibrancy: 'sidebar',
      warn,
    };

    applyReducedTransparency(deps, false);

    const line = warn.mock.calls[0]?.[0] as unknown as string;
    const parsed = JSON.parse(line);
    expect(parsed.event).toBe('reduced-transparency-applied');
    expect(parsed.reducedTransparency).toBe(false);
    expect(parsed.vibrancy).toBe('sidebar');
    expect(parsed.windowCount).toBe(1);
  });

  test('reports every material actually restored when windows have preferences', () => {
    const editor = makeWindow();
    const note = makeWindow();
    setPreferredWindowVibrancy(note.win, 'window');
    const warn = vi.fn(() => {});
    const deps: ReducedTransparencyDeps = {
      getAllWindows: () => [editor.win, note.win],
      defaultVibrancy: 'sidebar',
      warn,
    };

    applyReducedTransparency(deps, false);

    const line = warn.mock.calls.at(-1)?.[0] as unknown as string;
    const parsed = JSON.parse(line);
    expect(parsed.vibrancyMaterials).toEqual({ sidebar: 1, window: 1 });
  });

  test('windowCount counts only successfully-applied windows; destroyed windows go to destroyedCount', () => {
    const live = makeWindow();
    const dead = makeWindow({ destroyed: true });
    const warn = vi.fn(() => {});
    const deps: ReducedTransparencyDeps = {
      getAllWindows: () => [live.win, dead.win],
      defaultVibrancy: 'sidebar',
      warn,
    };

    applyReducedTransparency(deps, true);

    const parsed = JSON.parse(warn.mock.calls[0]?.[0] as unknown as string);
    expect(parsed.windowCount).toBe(1);
    expect(parsed.destroyedCount).toBe(1);
  });

  test('summary partition is complete: all counters sum to getAllWindows().length', () => {
    const a = makeWindow();
    const b = makeWindow({ destroyed: true });
    const warn = vi.fn(() => {});
    const deps: ReducedTransparencyDeps = {
      getAllWindows: () => [a.win, b.win],
      defaultVibrancy: 'sidebar',
      warn,
    };

    applyReducedTransparency(deps, true);

    const parsed = JSON.parse(warn.mock.calls[0]?.[0] as unknown as string);
    expect(
      parsed.windowCount + parsed.skippedCount + parsed.failedCount + parsed.destroyedCount,
    ).toBe(deps.getAllWindows().length);
  });

  test('omitting warn dep does not throw (optional sink)', () => {
    const w = makeWindow();
    const deps: ReducedTransparencyDeps = {
      getAllWindows: () => [w.win],
      defaultVibrancy: 'sidebar',
    };

    expect(() => applyReducedTransparency(deps, true)).not.toThrow();
  });

  test('empty windows array still emits structured warn with windowCount=0', () => {
    const warn = vi.fn(() => {});
    const deps: ReducedTransparencyDeps = {
      getAllWindows: () => [],
      defaultVibrancy: 'sidebar',
      warn,
    };

    applyReducedTransparency(deps, true);

    expect(warn).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(warn.mock.calls[0]?.[0] as unknown as string);
    expect(parsed.windowCount).toBe(0);
  });
});

describe('applyReducedTransparency — narrow dep surface (STOP rules)', () => {
  test('deps shape contains getAllWindows + defaultVibrancy + optional warn — no other surface', () => {
    const w = makeWindow();
    const deps: ReducedTransparencyDeps = {
      getAllWindows: () => [w.win],
      defaultVibrancy: 'sidebar',
      warn: () => {},
    };

    const keys = new Set(Object.keys(deps));
    expect(keys).toEqual(new Set(['getAllWindows', 'defaultVibrancy', 'warn']));
  });
});

describe('applyReducedTransparency — per-window throw isolation', () => {
  function makeThrowingWindow(): WindowFixture {
    const error = new Error('setVibrancy: window destroyed');
    const setVibrancy = vi.fn(() => {
      throw error;
    });
    const isDestroyed = vi.fn(() => false);
    return {
      win: {
        setVibrancy: setVibrancy as unknown as (mat: 'sidebar' | 'window' | null) => void,
        isDestroyed: isDestroyed as unknown as () => boolean,
      },
      setVibrancy,
      isDestroyed,
    };
  }

  test('throw on one window does not abort the loop — later windows still toggled', () => {
    const a = makeWindow();
    const b = makeThrowingWindow();
    const c = makeWindow();
    const deps: ReducedTransparencyDeps = {
      getAllWindows: () => [a.win, b.win, c.win],
      defaultVibrancy: 'sidebar',
    };

    expect(() => applyReducedTransparency(deps, true)).not.toThrow();

    expect(a.setVibrancy).toHaveBeenCalledTimes(1);
    expect(b.setVibrancy).toHaveBeenCalledTimes(1);
    expect(c.setVibrancy).toHaveBeenCalledTimes(1);
    expect(a.setVibrancy.mock.calls[0]).toEqual([null]);
    expect(c.setVibrancy.mock.calls[0]).toEqual([null]);
  });

  test('throw on one window emits a structured per-window warn', () => {
    const a = makeWindow();
    const b = makeThrowingWindow();
    const warn = vi.fn(() => {});
    const deps: ReducedTransparencyDeps = {
      getAllWindows: () => [a.win, b.win],
      defaultVibrancy: 'sidebar',
      warn,
    };

    applyReducedTransparency(deps, true);

    const lines = warn.mock.calls.map((call) => JSON.parse(call[0] as unknown as string));
    const failed = lines.find((l) => l.event === 'reduced-transparency-window-failed');
    expect(failed).toBeDefined();
    expect(failed?.error).toContain('setVibrancy');
  });

  test('windowCount counts only successfully-toggled windows when one throws', () => {
    const a = makeWindow();
    const b = makeThrowingWindow();
    const warn = vi.fn(() => {});
    const deps: ReducedTransparencyDeps = {
      getAllWindows: () => [a.win, b.win],
      defaultVibrancy: 'sidebar',
      warn,
    };

    applyReducedTransparency(deps, true);

    const lines = warn.mock.calls.map((call) => JSON.parse(call[0] as unknown as string));
    const summary = lines.find((l) => l.event === 'reduced-transparency-applied');
    expect(summary?.windowCount).toBe(1);
    expect(summary?.skippedCount).toBe(0);
    expect(summary?.failedCount).toBe(1);
  });

  test('per-window failure warn carries the window id for attribution', () => {
    const a = makeWindow();
    const setVibrancy = vi.fn(() => {
      throw new Error('setVibrancy: native failure');
    });
    const b: BrowserWindowVibrancyTarget = {
      id: 42,
      isDestroyed: () => false,
      setVibrancy: setVibrancy as unknown as (mat: 'sidebar' | 'window' | null) => void,
    };
    const warn = vi.fn(() => {});
    const deps: ReducedTransparencyDeps = {
      getAllWindows: () => [a.win, b],
      defaultVibrancy: 'sidebar',
      warn,
    };

    applyReducedTransparency(deps, true);

    const failed = warn.mock.calls
      .map((call) => JSON.parse(call[0] as unknown as string))
      .find((l) => l.event === 'reduced-transparency-window-failed');
    expect(failed?.windowId).toBe(42);
  });
});

describe('applyReducedTransparency — per-window idempotence memo (flicker guard)', () => {
  function summaries(warn: ReturnType<typeof vi.fn>) {
    return warn.mock.calls
      .map((call) => JSON.parse(call[0] as unknown as string))
      .filter((l) => l.event === 'reduced-transparency-applied');
  }

  test('skips a window already at the target material on a repeat call (no redundant setVibrancy)', () => {
    const a = makeWindow();
    const warn = vi.fn(() => {});
    const deps: ReducedTransparencyDeps = {
      getAllWindows: () => [a.win],
      defaultVibrancy: 'sidebar',
      warn,
    };

    applyReducedTransparency(deps, false);
    applyReducedTransparency(deps, false);

    expect(a.setVibrancy).toHaveBeenCalledTimes(1);
    expect(a.setVibrancy.mock.calls[0]).toEqual(['sidebar']);

    const lines = summaries(warn);
    expect(lines[0]).toMatchObject({ windowCount: 1, skippedCount: 0 });
    expect(lines[1]).toMatchObject({ windowCount: 0, skippedCount: 1 });
  });

  test('re-applies when the material actually changes (genuine reduce-transparency toggle)', () => {
    const a = makeWindow();
    const deps: ReducedTransparencyDeps = {
      getAllWindows: () => [a.win],
      defaultVibrancy: 'sidebar',
    };

    applyReducedTransparency(deps, false);
    applyReducedTransparency(deps, true);

    expect(a.setVibrancy).toHaveBeenCalledTimes(2);
    expect(a.setVibrancy.mock.calls[0]).toEqual(['sidebar']);
    expect(a.setVibrancy.mock.calls[1]).toEqual([null]);
  });

  test('applies once to a newly-opened window while skipping already-memoized windows', () => {
    const a = makeWindow();
    const b = makeWindow();
    const warn = vi.fn(() => {});

    applyReducedTransparency(
      { getAllWindows: () => [a.win], defaultVibrancy: 'sidebar', warn },
      true,
    );
    applyReducedTransparency(
      { getAllWindows: () => [a.win, b.win], defaultVibrancy: 'sidebar', warn },
      true,
    );

    expect(a.setVibrancy).toHaveBeenCalledTimes(1);
    expect(b.setVibrancy).toHaveBeenCalledTimes(1);
    expect(b.setVibrancy.mock.calls[0]).toEqual([null]);
    expect(summaries(warn).at(-1)).toMatchObject({ windowCount: 1, skippedCount: 1 });
  });

  test('per-window memo tracks each transition (apply / skip / re-apply on real change)', () => {
    const a = makeWindow();
    const deps: ReducedTransparencyDeps = {
      getAllWindows: () => [a.win],
      defaultVibrancy: 'sidebar',
    };

    applyReducedTransparency(deps, false);
    applyReducedTransparency(deps, false);
    applyReducedTransparency(deps, true);
    applyReducedTransparency(deps, true);
    applyReducedTransparency(deps, false);

    expect(a.setVibrancy.mock.calls).toEqual([['sidebar'], [null], ['sidebar']]);
  });

  test('a window that throws is not memoized — the next apply retries instead of skipping', () => {
    let calls = 0;
    const setVibrancy = vi.fn(() => {
      calls += 1;
      if (calls === 1) throw new Error('setVibrancy: transient native failure');
    });
    const win: BrowserWindowVibrancyTarget = {
      isDestroyed: () => false,
      setVibrancy: setVibrancy as unknown as (mat: 'sidebar' | 'window' | null) => void,
    };
    const deps: ReducedTransparencyDeps = {
      getAllWindows: () => [win],
      defaultVibrancy: 'sidebar',
    };

    applyReducedTransparency(deps, false);
    applyReducedTransparency(deps, false);

    expect(setVibrancy).toHaveBeenCalledTimes(2);
    expect(setVibrancy.mock.calls).toEqual([['sidebar'], ['sidebar']]);
  });
});

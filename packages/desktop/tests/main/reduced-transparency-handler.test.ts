import { describe, expect, mock, test } from 'bun:test';

import {
  applyReducedTransparency,
  type BrowserWindowVibrancyTarget,
  type ReducedTransparencyDeps,
} from '../../src/main/reduced-transparency-handler.ts';

interface WindowFixture {
  win: BrowserWindowVibrancyTarget;
  setVibrancy: ReturnType<typeof mock>;
  isDestroyed: ReturnType<typeof mock>;
}

function makeWindow(opts?: { destroyed?: boolean }): WindowFixture {
  const setVibrancy = mock(() => {});
  const isDestroyed = mock(() => opts?.destroyed === true);
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
    // BrowserWindowVibrancyTarget.isDestroyed is optional; the source guards
    // with `win.isDestroyed?.()`. Pin that the optional chain holds for a
    // window that omits the method entirely — dropping the `?.` would throw
    // TypeError mid-loop and abort vibrancy for every remaining window.
    const setVibrancy = mock(() => {});
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
});

describe('applyReducedTransparency — diagnostic logging', () => {
  test('emits structured warn with event/reducedTransparency/vibrancy/windowCount on disable', () => {
    const a = makeWindow();
    const b = makeWindow();
    const warn = mock(() => {});
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
    const warn = mock(() => {});
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

  test('windowCount counts only successfully-applied windows; destroyed windows go to destroyedCount', () => {
    const live = makeWindow();
    const dead = makeWindow({ destroyed: true });
    const warn = mock(() => {});
    const deps: ReducedTransparencyDeps = {
      getAllWindows: () => [live.win, dead.win],
      defaultVibrancy: 'sidebar',
      warn,
    };

    applyReducedTransparency(deps, true);

    const parsed = JSON.parse(warn.mock.calls[0]?.[0] as unknown as string);
    // windowCount is "successfully applied", not "all non-destroyed" — the
    // destroyed window lands in destroyedCount so the partition stays complete.
    expect(parsed.windowCount).toBe(1);
    expect(parsed.destroyedCount).toBe(1);
  });

  test('summary partition is complete: all counters sum to getAllWindows().length', () => {
    // Pins the contract the source comment documents — applied + skipped +
    // failed + destroyed accounts for every window iterated. Guards a future
    // compact-log change that drops a zero-valued counter and silently breaks
    // the completeness operators rely on to tell convergence from failure.
    const a = makeWindow();
    const b = makeWindow({ destroyed: true });
    const warn = mock(() => {});
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
    const warn = mock(() => {});
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
  // setVibrancy is at a real trust boundary (Electron native NSVisualEffectView
  // call). The isDestroyed guard handles the common race, but a throw can
  // still surface — the destroy event can fire between the guard and the
  // native call on a fast shutdown, and Electron may surface unexpected
  // native errors. Without a per-window try/catch, one throw aborts the
  // whole loop: earlier windows have toggled vibrancy, later windows are
  // untouched, and the diagnostic warn never fires because it follows the
  // loop. The guard isolates each call.
  function makeThrowingWindow(): WindowFixture {
    const error = new Error('setVibrancy: window destroyed');
    const setVibrancy = mock(() => {
      throw error;
    });
    const isDestroyed = mock(() => false);
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
    const warn = mock(() => {});
    const deps: ReducedTransparencyDeps = {
      getAllWindows: () => [a.win, b.win],
      defaultVibrancy: 'sidebar',
      warn,
    };

    applyReducedTransparency(deps, true);

    // Two warns: one per-window failure + the summary `applied` line.
    const lines = warn.mock.calls.map((call) => JSON.parse(call[0] as unknown as string));
    const failed = lines.find((l) => l.event === 'reduced-transparency-window-failed');
    expect(failed).toBeDefined();
    expect(failed?.error).toContain('setVibrancy');
  });

  test('windowCount counts only successfully-toggled windows when one throws', () => {
    const a = makeWindow();
    const b = makeThrowingWindow();
    const warn = mock(() => {});
    const deps: ReducedTransparencyDeps = {
      getAllWindows: () => [a.win, b.win],
      defaultVibrancy: 'sidebar',
      warn,
    };

    applyReducedTransparency(deps, true);

    const lines = warn.mock.calls.map((call) => JSON.parse(call[0] as unknown as string));
    const summary = lines.find((l) => l.event === 'reduced-transparency-applied');
    expect(summary?.windowCount).toBe(1);
    // The summary partition must be complete: a thrown-and-caught window lands
    // in failedCount, not in the applied/skipped buckets — so a degraded window
    // is distinguishable from the healthy converged state.
    expect(summary?.skippedCount).toBe(0);
    expect(summary?.failedCount).toBe(1);
  });

  test('per-window failure warn carries the window id for attribution', () => {
    const a = makeWindow();
    // A throwing window that also exposes a stable id, as real BrowserWindows do.
    const setVibrancy = mock(() => {
      throw new Error('setVibrancy: native failure');
    });
    const b: BrowserWindowVibrancyTarget = {
      id: 42,
      isDestroyed: () => false,
      setVibrancy: setVibrancy as unknown as (mat: 'sidebar' | 'window' | null) => void,
    };
    const warn = mock(() => {});
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
  // The memo is module-level and keyed on window object identity. Each test
  // mints fresh window stubs, so memoized state never leaks across tests — but
  // WITHIN a test, reusing the same stub across calls is what exercises the
  // skip path that collapses the N² theme-change re-apply burst.
  function summaries(warn: ReturnType<typeof mock>) {
    return warn.mock.calls
      .map((call) => JSON.parse(call[0] as unknown as string))
      .filter((l) => l.event === 'reduced-transparency-applied');
  }

  test('skips a window already at the target material on a repeat call (no redundant setVibrancy)', () => {
    const a = makeWindow();
    const warn = mock(() => {});
    const deps: ReducedTransparencyDeps = {
      getAllWindows: () => [a.win],
      defaultVibrancy: 'sidebar',
      warn,
    };

    // Second apply with the same value is the redundant theme-change re-apply
    // that used to rebuild the NSVisualEffectView and flicker the chrome.
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

    applyReducedTransparency(deps, false); // material 'sidebar'
    applyReducedTransparency(deps, true); // material null — changed → re-applies

    expect(a.setVibrancy).toHaveBeenCalledTimes(2);
    expect(a.setVibrancy.mock.calls[0]).toEqual(['sidebar']);
    expect(a.setVibrancy.mock.calls[1]).toEqual([null]);
  });

  test('applies once to a newly-opened window while skipping already-memoized windows', () => {
    const a = makeWindow();
    const b = makeWindow();
    const warn = mock(() => {});

    // a is present for the first toggle; b opens before the second.
    applyReducedTransparency(
      { getAllWindows: () => [a.win], defaultVibrancy: 'sidebar', warn },
      true,
    );
    applyReducedTransparency(
      { getAllWindows: () => [a.win, b.win], defaultVibrancy: 'sidebar', warn },
      true,
    );

    // a already at null → skipped on the second pass; b is new → applied once.
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

    applyReducedTransparency(deps, false); // sidebar — applied
    applyReducedTransparency(deps, false); // sidebar — skipped
    applyReducedTransparency(deps, true); // null — changed, applied
    applyReducedTransparency(deps, true); // null — skipped
    applyReducedTransparency(deps, false); // sidebar — changed back, applied

    expect(a.setVibrancy.mock.calls).toEqual([['sidebar'], [null], ['sidebar']]);
  });

  test('a window that throws is not memoized — the next apply retries instead of skipping', () => {
    // Contract: lastAppliedMaterial.set runs only AFTER a successful setVibrancy,
    // so a transient native failure leaves the window unmemoized and the next
    // pass re-attempts it. Moving the .set before setVibrancy (or into the catch)
    // would permanently skip a window that hit one transient error — this test
    // is the regression pin for that.
    let calls = 0;
    const setVibrancy = mock(() => {
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

    applyReducedTransparency(deps, false); // throws — NOT memoized
    applyReducedTransparency(deps, false); // retries (would skip if memoized on failure)

    expect(setVibrancy).toHaveBeenCalledTimes(2);
    expect(setVibrancy.mock.calls).toEqual([['sidebar'], ['sidebar']]);
  });
});

import type { Page } from '@playwright/test';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { placeCaretAtEndOfText } from '../stress/_helpers/editor-state';

const TARGET = 'Above.';
const INTENDED_CARET = 7;
const STALE_CARET = 1;

type Reading = { from: number; to: number; focused: boolean };

const placed: Reading = { from: INTENDED_CARET, to: INTENDED_CARET, focused: true };
const drifted: Reading = { from: 3, to: 9, focused: false };

function scriptedEditor(readings: Reading[], text = TARGET) {
  let cursor = 0;
  const current = (): Reading => readings[Math.min(cursor, readings.length - 1)];
  const drives: number[] = [];
  const editor = {
    state: {
      doc: {
        descendants(visit: (node: { isText: boolean; text?: string }, pos: number) => boolean) {
          visit({ isText: true, text }, 1);
        },
      },
      get selection() {
        const reading = current();
        return { from: reading.from, to: reading.to, empty: reading.from === reading.to };
      },
    },
    view: {
      hasFocus: () => current().focused,
    },
    chain() {
      return {
        focus: () => ({
          setTextSelection: ({ from }: { from: number }) => {
            drives.push(from);
            return { run: () => true };
          },
        }),
      };
    },
  };
  return {
    editor,
    drives,
    advance() {
      cursor += 1;
    },
  };
}

function timeoutError(timeoutMs: number): Error {
  const error = new Error(`page.waitForFunction: Timeout ${timeoutMs}ms exceeded.`);
  error.name = 'TimeoutError';
  return error;
}

function barrierHandle(settled: unknown, dispose: () => Promise<void> = async () => {}) {
  return {
    jsonValue: async () => settled,
    dispose,
  };
}

function collectedDisposer(): () => Promise<void> {
  return async () => {
    throw new Error('The object has been collected to prevent unbounded heap growth.');
  };
}

function unreadableBarrierPage(
  unreadable: Error,
  dispose: () => Promise<void> = async () => {},
): Page {
  return {
    evaluate: async (fn: (arg: unknown) => unknown, arg: unknown) => fn(arg),
    waitForFunction: async (fn: (arg: unknown) => unknown, arg: unknown) => {
      fn(arg);
      return {
        jsonValue: async () => {
          throw unreadable;
        },
        dispose,
      };
    },
  } as unknown as Page;
}

function jsdomPage(
  rig: ReturnType<typeof scriptedEditor>,
  pollBudget = 8,
  onPoll: (satisfied: boolean) => void = () => {},
  dispose: () => Promise<void> = async () => {},
): Page {
  return {
    evaluate: async (fn: (arg: unknown) => unknown, arg: unknown) => fn(arg),
    waitForFunction: async (
      fn: (arg: unknown) => unknown,
      arg: unknown,
      options: { timeout?: number } = {},
    ) => {
      for (let poll = 0; poll < pollBudget; poll += 1) {
        const settled = fn(arg);
        rig.advance();
        onPoll(Boolean(settled));
        if (settled) return barrierHandle(settled, dispose);
      }
      throw timeoutError(options.timeout ?? 0);
    },
  } as unknown as Page;
}

function pageThatStopsAnswering(
  rig: ReturnType<typeof scriptedEditor>,
  afterBarrier: () => Promise<never>,
): Page {
  let answering = true;
  const live = jsdomPage(rig, 1, () => {
    answering = false;
  }) as unknown as {
    evaluate: (fn: (arg: unknown) => unknown, arg: unknown) => Promise<unknown>;
    waitForFunction: (
      fn: (arg: unknown) => unknown,
      arg: unknown,
      options: unknown,
    ) => Promise<unknown>;
  };
  return {
    evaluate: (fn: (arg: unknown) => unknown, arg: unknown) =>
      answering ? live.evaluate(fn, arg) : afterBarrier(),
    waitForFunction: live.waitForFunction,
  } as unknown as Page;
}

function installEditor(editor: unknown): void {
  vi.stubGlobal('__activeEditor', editor);
}

function install(rig: ReturnType<typeof scriptedEditor>): void {
  installEditor(rig.editor);
}

function uninstall(): void {
  vi.stubGlobal('__activeEditor', undefined);
}

afterEach(() => {
  vi.unstubAllGlobals();
  (window as unknown as { __caretBarrierProbe?: unknown }).__caretBarrierProbe = undefined;
});

describe('placeCaretAtEndOfText barrier', () => {
  test('returns only once every conjunct of the predicate holds', async () => {
    const rig = scriptedEditor([
      { from: STALE_CARET, to: STALE_CARET, focused: true },
      { from: INTENDED_CARET, to: INTENDED_CARET, focused: false },
      placed,
    ]);
    install(rig);

    const placement = await placeCaretAtEndOfText(jsdomPage(rig), TARGET);

    expect(placement).toEqual({
      pmCaret: INTENDED_CARET,
      pmCaretTo: INTENDED_CARET,
      intendedCaret: INTENDED_CARET,
      editorOwnsDomFocus: true,
    });
  });

  test('returns the reading that satisfied the barrier, not one taken after it', async () => {
    const rig = scriptedEditor([placed, drifted]);
    install(rig);

    const placement = await placeCaretAtEndOfText(jsdomPage(rig), TARGET);

    expect(rig.editor.state.selection).toEqual({
      from: drifted.from,
      to: drifted.to,
      empty: false,
    });
    expect(rig.editor.view.hasFocus()).toBe(drifted.focused);
    expect(placement).toEqual({
      pmCaret: INTENDED_CARET,
      pmCaretTo: INTENDED_CARET,
      intendedCaret: INTENDED_CARET,
      editorOwnsDomFocus: true,
    });
  });

  test('keeps waiting while the editor still reports the stale caret', async () => {
    const rig = scriptedEditor([{ from: STALE_CARET, to: STALE_CARET, focused: true }]);
    install(rig);

    await expect(placeCaretAtEndOfText(jsdomPage(rig), TARGET)).rejects.toThrow(
      /gave up after \d+ms with selection-not-at-caret\b.*\bfrom=1 to=1 empty=true focused=true/,
    );
  });

  test('keeps waiting while the selection is anchored at the caret but spans a range', async () => {
    const rig = scriptedEditor([{ from: INTENDED_CARET, to: INTENDED_CARET + 2, focused: true }]);
    install(rig);

    await expect(placeCaretAtEndOfText(jsdomPage(rig), TARGET)).rejects.toThrow(
      /gave up after \d+ms with selection-not-collapsed\b.*\bfrom=7 to=9 empty=false focused=true/,
    );
  });

  test('keeps waiting while a collapsed caret sits at the position without focus', async () => {
    const rig = scriptedEditor([{ from: INTENDED_CARET, to: INTENDED_CARET, focused: false }]);
    install(rig);

    await expect(placeCaretAtEndOfText(jsdomPage(rig), TARGET)).rejects.toThrow(
      /gave up after \d+ms with editor-lacks-dom-focus\b.*\bfrom=7 to=7 empty=true focused=false/,
    );
  });

  test('re-drives the intended caret on every unsatisfied poll', async () => {
    const rig = scriptedEditor([{ from: STALE_CARET, to: STALE_CARET, focused: true }]);
    install(rig);

    await expect(placeCaretAtEndOfText(jsdomPage(rig, 3), TARGET)).rejects.toThrow(
      /gave up after \d+ms with selection-not-at-caret/,
    );

    expect(rig.drives).toEqual([INTENDED_CARET, INTENDED_CARET, INTENDED_CARET, INTENDED_CARET]);
  });

  test('names a barrier handle it could not read back rather than a barrier timeout', async () => {
    const rig = scriptedEditor([placed]);
    install(rig);
    const unreadable = new Error('Target page, context or browser has been closed');
    const disposals: string[] = [];
    const page = unreadableBarrierPage(unreadable, async () => {
      disposals.push('disposed');
    });

    const failure = await placeCaretAtEndOfText(page, TARGET).catch((reason: unknown) => reason);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(
      /the caret barrier held for intended caret 7, but the placement it settled on could not be read back off the barrier handle: Target page, context or browser has been closed/,
    );
    expect((failure as Error).message).not.toMatch(/gave up after/);
    expect((failure as Error).cause).toBe(unreadable);
    expect(disposals).toEqual(['disposed']);
  });

  test('disposes the barrier handle once it has read the placement back', async () => {
    const rig = scriptedEditor([placed]);
    install(rig);
    const disposals: string[] = [];
    const record = async () => {
      disposals.push('disposed');
    };

    const placement = await placeCaretAtEndOfText(
      jsdomPage(rig, 8, () => {}, record),
      TARGET,
    );

    expect(placement.pmCaret).toBe(INTENDED_CARET);
    expect(disposals).toEqual(['disposed']);
  });

  test('returns the placement it read back even when disposing the handle fails', async () => {
    const rig = scriptedEditor([placed]);
    install(rig);

    const placement = await placeCaretAtEndOfText(
      jsdomPage(rig, 8, () => {}, collectedDisposer()),
      TARGET,
    );

    expect(placement).toEqual({
      pmCaret: INTENDED_CARET,
      pmCaretTo: INTENDED_CARET,
      intendedCaret: INTENDED_CARET,
      editorOwnsDomFocus: true,
    });
  });

  test('keeps the unreadable-handle failure and its cause when disposal fails too', async () => {
    const rig = scriptedEditor([placed]);
    install(rig);
    const unreadable = new Error(
      'Execution context was destroyed, most likely because of a navigation',
    );

    const failure = await placeCaretAtEndOfText(
      unreadableBarrierPage(unreadable, collectedDisposer()),
      TARGET,
    ).catch((reason: unknown) => reason);

    expect((failure as Error).message).toMatch(
      /could not be read back off the barrier handle: Execution context was destroyed/,
    );
    expect((failure as Error).message).toMatch(
      /disposing the barrier handle afterwards also failed: The object has been collected to prevent unbounded heap growth\./,
    );
    expect((failure as Error).cause).toBe(unreadable);
  });

  test('names an editor handle lost mid-poll without fabricating a reading', async () => {
    const rig = scriptedEditor([{ from: STALE_CARET, to: STALE_CARET, focused: true }]);
    install(rig);
    const page = jsdomPage(rig, 4, (satisfied) => {
      if (!satisfied) uninstall();
    });

    const failure = await placeCaretAtEndOfText(page, TARGET).catch((reason: unknown) => reason);

    expect((failure as Error).message).toMatch(
      /gave up after \d+ms with editor-handle-absent\b.*\bno editor handle, so it read no selection to report/,
    );
    expect((failure as Error).message).not.toMatch(/from=/);
  });

  test('reports a predicate rejection as a rejection, carrying the causing message', async () => {
    const rig = scriptedEditor([placed]);
    installEditor({
      ...rig.editor,
      view: new Proxy(
        {},
        {
          get: (_target, key) => {
            throw new Error(
              `[tiptap error]: The editor view is not available. Cannot access view['${String(key)}']. The editor may not be mounted yet.`,
            );
          },
        },
      ),
    });

    await expect(placeCaretAtEndOfText(jsdomPage(rig), TARGET)).rejects.toThrow(
      /rejected before its \d+ms budget with no poll reading recorded for intended caret 7; the rejection was: \[tiptap error\]: The editor view is not available\. Cannot access view\['hasFocus'\]/,
    );
  });

  test('separates a read that outran the recovery budget from a reading never recorded', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const rig = scriptedEditor([{ from: STALE_CARET, to: STALE_CARET, focused: true }]);
      install(rig);

      const rejected = expect(
        placeCaretAtEndOfText(
          pageThatStopsAnswering(rig, () => new Promise<never>(() => {})),
          TARGET,
        ),
      ).rejects.toThrow(
        /gave up after \d+ms with the poll reading for intended caret 7 could not be read back: the read outran this helper's own \d+ms recovery budget/,
      );
      await vi.advanceTimersByTimeAsync(60_000);
      await rejected;
    } finally {
      vi.useRealTimers();
    }
  });

  test('separates a read the page rejected from a reading never recorded', async () => {
    const rig = scriptedEditor([{ from: STALE_CARET, to: STALE_CARET, focused: true }]);
    install(rig);
    const closed = pageThatStopsAnswering(rig, () =>
      Promise.reject(new Error('Target page, context or browser has been closed')),
    );

    await expect(placeCaretAtEndOfText(closed, TARGET)).rejects.toThrow(
      /gave up after \d+ms with the poll reading for intended caret 7 could not be read back: Target page, context or browser has been closed/,
    );
  });

  test('refuses text that is not in the document instead of placing nothing', async () => {
    const rig = scriptedEditor([placed]);
    install(rig);

    await expect(placeCaretAtEndOfText(jsdomPage(rig), 'Nowhere')).rejects.toThrow(
      /not found within a single text node/,
    );
    expect(rig.drives).toEqual([]);
  });

  test('refuses text that occurs more than once rather than silently taking the first', async () => {
    const rig = scriptedEditor([placed], `${TARGET} and again ${TARGET}`);
    install(rig);

    await expect(placeCaretAtEndOfText(jsdomPage(rig), TARGET)).rejects.toThrow(
      /occurs 2 times, so the caret this places is the first occurrence/,
    );
    expect(rig.drives).toEqual([]);
  });

  test('refuses when the editor handle is absent', async () => {
    const rig = scriptedEditor([placed]);

    await expect(placeCaretAtEndOfText(jsdomPage(rig), TARGET)).rejects.toThrow(
      /__activeEditor not set/,
    );
  });
});

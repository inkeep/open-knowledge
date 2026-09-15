import { expect, type Page } from '@playwright/test';

export const SELECT_ALL_SETTLE_TIMEOUT_MS = process.env.CI ? 15_000 : 5_000;

type ViewSelectionState = 'covers-document' | 'partial' | 'empty' | 'unreadable';

export interface SelectAllProbe {
  matches: number;
  focusOwnedOnEntry: boolean;
  focusOwnedByEditor: boolean;
  activeElement: string;
  viewSelection: ViewSelectionState;
  docEnd: number | null;
}

export function repairFocusAndReadProbe(sel: string): SelectAllProbe {
  const describe = (node: Element | null | undefined): string => {
    if (!node) return 'none';
    const first =
      typeof node.className === 'string' && node.className.trim().length > 0
        ? `.${node.className.trim().split(/\s+/)[0]}`
        : '';
    return `${node.tagName.toLowerCase()}${first}`;
  };
  const matches = document.querySelectorAll(sel).length;
  const editor = document.querySelector(sel);
  if (!editor) {
    return {
      matches,
      focusOwnedOnEntry: false,
      focusOwnedByEditor: false,
      activeElement: describe(document.activeElement),
      viewSelection: 'unreadable',
      docEnd: null,
    };
  }
  const ownsFocus = (): boolean => document.activeElement === editor;
  const focusOwnedOnEntry = ownsFocus();
  if (!focusOwnedOnEntry && editor instanceof HTMLElement) editor.focus({ preventScroll: true });

  const classify = (from: unknown, to: unknown, end: unknown): ViewSelectionState => {
    if (!Number.isInteger(from) || !Number.isInteger(to) || !Number.isInteger(end)) {
      return 'unreadable';
    }
    if (from === to) return 'empty';
    return from === 0 && to === end ? 'covers-document' : 'partial';
  };
  let viewSelection: ViewSelectionState = 'unreadable';
  let docEnd: number | null = null;
  const read = (from: unknown, to: unknown, end: unknown): void => {
    viewSelection = classify(from, to, end);
    docEnd = viewSelection === 'unreadable' ? null : (end as number);
  };
  const prosemirror = (
    window.__activeEditor as unknown as {
      editorView?: {
        dom?: Element;
        state?: {
          selection?: { from?: number; to?: number };
          doc?: { content?: { size?: number } };
        };
      };
    } | null
  )?.editorView;
  if (prosemirror && prosemirror.dom === editor) {
    read(
      prosemirror.state?.selection?.from,
      prosemirror.state?.selection?.to,
      prosemirror.state?.doc?.content?.size,
    );
  } else {
    const handle = editor as Element & {
      cmTile?: { root?: { view?: unknown } };
      cmView?: { rootView?: { view?: unknown } };
    };
    const codemirror = (handle.cmTile?.root?.view ?? handle.cmView?.rootView?.view) as
      | {
          state?: {
            doc?: { length?: number };
            selection?: { main?: { from?: number; to?: number } };
          };
        }
      | undefined;
    if (codemirror) {
      read(
        codemirror.state?.selection?.main?.from,
        codemirror.state?.selection?.main?.to,
        codemirror.state?.doc?.length,
      );
    }
  }

  return {
    matches,
    focusOwnedOnEntry,
    focusOwnedByEditor: ownsFocus(),
    activeElement: describe(document.activeElement),
    viewSelection,
    docEnd,
  };
}

function repairFocusAndProbe(page: Page, selector: string): Promise<SelectAllProbe> {
  return page.evaluate(repairFocusAndReadProbe, selector);
}

const SETTLED_READING = {
  focus: { focusOwnedByEditor: true },
  'select-all': { viewSelection: 'covers-document' },
} as const satisfies { [S in 'focus' | 'select-all']: Partial<SelectAllProbe> };

/* UPSTREAM(@playwright/test@1.59.1): lib/matchers/expect.js pollMatcher returns
   { continuePolling: false } without ever calling the poll generator once the test that armed the
   poll is no longer the running test, so the barrier resolves holding whatever reading the previous
   iteration left — undefined if there was none. Neither the public expect.poll reference nor the
   upstream test suite states this, so re-verify it on a Playwright bump. */
export function abandonedPollRefusal(
  selector: string,
  stage: 'focus' | 'select-all',
  settled: SelectAllProbe | undefined,
): string | null {
  const approved =
    settled !== undefined &&
    (Object.entries(SETTLED_READING[stage]) as [keyof SelectAllProbe, unknown][]).every(
      ([field, expected]) => settled[field] === expected,
    );
  if (approved) return null;
  return `selectAllAndWaitForSelection: the ${stage} poll for "${selector}" resolved on a reading its own matcher rejects, which Playwright does only once the test that armed this barrier has stopped being the running test — the page is no longer this test's to drive, so every reading taken from here on would describe someone else's run`;
}

function refusePollIfAbandoned(
  selector: string,
  stage: 'focus' | 'select-all',
  settled: SelectAllProbe | undefined,
): asserts settled is SelectAllProbe {
  const refusal = abandonedPollRefusal(selector, stage, settled);
  if (refusal !== null) throw new Error(refusal);
}

/* Category C (select-all / focus flush) per precedent #20(a): the double-rAF yield this replaces
   established neither that DOM focus was committed before the key dispatch nor that select-all
   applied, so the helper could return with the view's selection in any state. */
export async function selectAllAndWaitForSelection(
  page: Page,
  selector: string,
  budgets: { focusMs?: number; selectionMs?: number } = {},
): Promise<void> {
  const focusMs = budgets.focusMs ?? SELECT_ALL_SETTLE_TIMEOUT_MS;
  const selectionMs = budgets.selectionMs ?? SELECT_ALL_SETTLE_TIMEOUT_MS;
  await page.focus(selector);
  let settled: SelectAllProbe | undefined;
  await expect
    .poll(
      async () => {
        settled = await repairFocusAndProbe(page, selector);
        return settled;
      },
      {
        message: `selectAllAndWaitForSelection: "${selector}" never took DOM focus, so ControlOrMeta+A would land outside the editor`,
        timeout: focusMs,
      },
    )
    .toMatchObject({
      ...SETTLED_READING.focus,
      matches: expect.any(Number),
      activeElement: expect.any(String),
    });

  refusePollIfAbandoned(selector, 'focus', settled);

  if (settled.docEnd === 0) {
    throw new Error(
      `selectAllAndWaitForSelection: the view behind "${selector}" holds a zero-length document, so ControlOrMeta+A leaves exactly the 0,0 reading an untouched caret leaves and no select-all is observable — assert the editor has content before taking this barrier`,
    );
  }

  let selected: SelectAllProbe | undefined;
  await expect
    .poll(
      async () => {
        await page.keyboard.press('ControlOrMeta+a');
        selected = await repairFocusAndProbe(page, selector);
        return selected;
      },
      {
        message: `selectAllAndWaitForSelection: ControlOrMeta+A left no full-document selection in the view behind "${selector}"`,
        timeout: selectionMs,
      },
    )
    .toMatchObject({
      ...SETTLED_READING['select-all'],
      focusOwnedOnEntry: expect.any(Boolean),
      matches: expect.any(Number),
      activeElement: expect.any(String),
    });

  refusePollIfAbandoned(selector, 'select-all', selected);
}

/** Category C (cursor / focus flush) per precedent #20(a). */
export async function focusEditor(page: Page, timeoutMs = 5_000): Promise<void> {
  await page.evaluate(() => {
    const editor = window.__activeEditor;
    if (!editor) return;
    editor.view.focus();
  });
  await page.waitForFunction(
    () => {
      const editor = window.__activeEditor;
      if (!editor) return false;
      if (!editor.view.hasFocus()) return false;
      editor.view.focus();
      return true;
    },
    null,
    { timeout: timeoutMs },
  );
}

export async function selectText(page: Page, text: string): Promise<void> {
  await page.evaluate((target) => {
    const editor = window.__activeEditor;
    if (!editor) throw new Error('selectText: window.__activeEditor not set');
    let from = -1;
    editor.state.doc.descendants((node, pos) => {
      if (from !== -1) return false;
      const nodeText = node.isText ? node.text : undefined;
      if (nodeText) {
        const idx = nodeText.indexOf(target);
        if (idx !== -1) {
          from = pos + idx;
          return false;
        }
      }
      return true;
    });
    if (from === -1) {
      throw new Error(`selectText: "${target}" not found within a single text node`);
    }
    editor
      .chain()
      .focus()
      .setTextSelection({ from, to: from + target.length })
      .run();
  }, text);
  await page.waitForFunction(
    (target) => {
      const editor = window.__activeEditor;
      if (!editor) return false;
      const { from, to } = editor.state.selection;
      return to > from && editor.state.doc.textBetween(from, to) === target;
    },
    text,
    { timeout: 5_000 },
  );
}

/** Category C per precedent #20(a). */
/* WARN: walks `$from` ancestors, so it can never match a NodeSelection; a caller arming a
   NodeSelection needs its own predicate. */
export async function waitForPmSelectionInNode(
  page: Page,
  nodeType: string,
  timeoutMs = 5_000,
): Promise<void> {
  await page.waitForFunction(
    (expected) => {
      const editor = window.__activeEditor;
      if (!editor) return false;
      const $from = editor.state.selection.$from;
      for (let d = $from.depth; d >= 0; d--) {
        if ($from.node(d).type.name === expected) return true;
      }
      return false;
    },
    nodeType,
    { timeout: timeoutMs },
  );
}

export async function primeFullLayout(page: Page): Promise<void> {
  let lastHeight = -1;
  await expect
    .poll(
      async () => {
        const h = await page.evaluate(() => {
          const s = document.querySelector('[data-testid="editor-scroll-container"]');
          if (!(s instanceof HTMLElement)) return -1;
          s.scrollTop = s.scrollHeight;
          return s.scrollHeight;
        });
        const stable = h > 0 && h === lastHeight;
        lastHeight = h;
        return stable;
      },
      { timeout: 6_000, intervals: [150, 250, 350] },
    )
    .toBe(true);

  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const s = document.querySelector('[data-testid="editor-scroll-container"]');
          if (!(s instanceof HTMLElement)) return -1;
          if (s.scrollTop !== 0) s.scrollTop = 0;
          return s.scrollTop;
        }),
      { timeout: 3_000, intervals: [100, 200] },
    )
    .toBe(0);
}

import { expect, type Page } from '@playwright/test';

export const SELECT_ALL_SETTLE_TIMEOUT_MS = process.env.CI ? 15_000 : 5_000;

type ViewSelectionState = 'covers-document' | 'partial' | 'empty' | 'unreadable';

interface SelectAllProbe {
  matches: number;
  focusOwnedOnEntry: boolean;
  focusOwnedByEditor: boolean;
  activeElement: string;
  viewSelection: ViewSelectionState;
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
    };
  }
  const ownsFocus = (): boolean => document.activeElement === editor;
  const focusOwnedOnEntry = ownsFocus();
  if (!focusOwnedOnEntry && editor instanceof HTMLElement) editor.focus({ preventScroll: true });

  const classify = (from: unknown, to: unknown, docEnd: unknown): ViewSelectionState => {
    if (!Number.isInteger(from) || !Number.isInteger(to) || !Number.isInteger(docEnd)) {
      return 'unreadable';
    }
    if (from === 0 && to === docEnd) return 'covers-document';
    return from === to ? 'empty' : 'partial';
  };
  let viewSelection: ViewSelectionState = 'unreadable';
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
    viewSelection = classify(
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
      viewSelection = classify(
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
  };
}

function repairFocusAndProbe(page: Page, selector: string): Promise<SelectAllProbe> {
  return page.evaluate(repairFocusAndReadProbe, selector);
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
  await expect
    .poll(() => repairFocusAndProbe(page, selector), {
      message: `selectAllAndWaitForSelection: "${selector}" never took DOM focus, so ControlOrMeta+A would land outside the editor`,
      timeout: focusMs,
    })
    .toMatchObject({
      focusOwnedByEditor: true,
      matches: expect.any(Number),
      activeElement: expect.any(String),
    });

  await expect
    .poll(
      async () => {
        await page.keyboard.press('ControlOrMeta+a');
        return repairFocusAndProbe(page, selector);
      },
      {
        message: `selectAllAndWaitForSelection: ControlOrMeta+A left no full-document selection in the view behind "${selector}"`,
        timeout: selectionMs,
      },
    )
    .toMatchObject({
      viewSelection: 'covers-document',
      focusOwnedOnEntry: expect.any(Boolean),
      matches: expect.any(Number),
      activeElement: expect.any(String),
    });
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

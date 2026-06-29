
import type { Page } from '@playwright/test';

export async function selectAllAndWaitForSelection(page: Page, selector: string): Promise<void> {
  await page.focus(selector);
  await page.keyboard.press('ControlOrMeta+a');
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}

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

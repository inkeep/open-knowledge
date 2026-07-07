/**
 * Clipboard interaction helpers for E2E tests.
 *
 * Dispatches synthetic `ClipboardEvent`s with an intercepted
 * `DataTransfer.setData` so the test can read the MIME map the app's copy /
 * cut handlers wrote, without depending on the real browser clipboard. The
 * programmatic approach bypasses `navigator.clipboard` permission prompts
 * and browser-specific clipboard quirks — same-machine-same-clipboard
 * pollution between concurrent Playwright workers is impossible with this
 * pattern.
 *
 * Precedent #19 (clipboard pipeline is mdast-canonical with per-view hook
 * mechanisms) is what these helpers exercise. See paste-fidelity.e2e.ts for
 * the MIME-shape assertions that rely on this.
 */

import type { Page } from '@playwright/test';
import { selectAllAndWaitForSelection } from './editor-state';

/**
 * Select all content, then dispatch a `copy` event while intercepting
 * `DataTransfer.setData` to capture the MIME map the editor's clipboard hook
 * wrote. Returns `{ plain, html }` — use for assertions (text/plain
 * markdown + text/html with data-pm-slice).
 *
 * @param view - 'wysiwyg' (selects `.ProseMirror`) or 'source' (selects `.cm-content`)
 */
export async function simulateCopyAndRead(
  page: Page,
  view: 'wysiwyg' | 'source' = 'wysiwyg',
): Promise<{ plain: string; html: string }> {
  const selector = view === 'source' ? '.cm-content' : '.ProseMirror:not(.composer-prosemirror)';
  // PM / CM6 sync their internal selection state on Meta+A; the DOM Selection
  // becomes non-empty within a frame. Poll for that signal rather than
  // yielding a fixed 50ms. Empty-doc callers catch the throw.
  await selectAllAndWaitForSelection(page, selector);
  return page.evaluate((sel) => {
    const editor = document.querySelector(sel) as HTMLElement | null;
    if (!editor) {
      const editorCount = document.querySelectorAll(
        '.ProseMirror:not(.composer-prosemirror), .cm-content',
      ).length;
      const rootPreview = (document.body?.outerHTML ?? '').slice(0, 400);
      throw new Error(
        `simulateCopyAndRead: editor "${sel}" not found — editor views on page: ${editorCount}. document.body head:\n${rootPreview}`,
      );
    }
    const captured: Record<string, string> = {};
    const dt = new DataTransfer();
    const origSetData = dt.setData.bind(dt);
    dt.setData = (key: string, value: string): void => {
      captured[key] = value;
      origSetData(key, value);
    };
    const event = new ClipboardEvent('copy', {
      clipboardData: dt,
      bubbles: true,
      cancelable: true,
    });
    editor.dispatchEvent(event);
    return {
      plain: captured['text/plain'] ?? '',
      html: captured['text/html'] ?? '',
    };
  }, selector);
}

/**
 * Cut-side parallel to {@link simulateCopyAndRead}. WYSIWYG's cut path
 * is PM's default path that calls our clipboard hooks + dispatches
 * `deleteSelection`; Source's cut path is our explicit dispatch. Both write
 * text/plain + text/html; both delete the selection.
 *
 * @returns `{ plain, html, contentAfter }` — the last field lets callers
 *          assert the selection was actually removed from the DOM.
 */
export async function simulateCutAndRead(
  page: Page,
  view: 'wysiwyg' | 'source' = 'wysiwyg',
): Promise<{ plain: string; html: string; contentAfter: string }> {
  const selector = view === 'source' ? '.cm-content' : '.ProseMirror:not(.composer-prosemirror)';
  await selectAllAndWaitForSelection(page, selector);
  return page.evaluate((sel) => {
    const editor = document.querySelector(sel) as HTMLElement | null;
    if (!editor) {
      const editorCount = document.querySelectorAll(
        '.ProseMirror:not(.composer-prosemirror), .cm-content',
      ).length;
      const rootPreview = (document.body?.outerHTML ?? '').slice(0, 400);
      throw new Error(
        `simulateCutAndRead: editor "${sel}" not found — editor views on page: ${editorCount}. document.body head:\n${rootPreview}`,
      );
    }
    const captured: Record<string, string> = {};
    const dt = new DataTransfer();
    const origSetData = dt.setData.bind(dt);
    dt.setData = (key: string, value: string): void => {
      captured[key] = value;
      origSetData(key, value);
    };
    const event = new ClipboardEvent('cut', {
      clipboardData: dt,
      bubbles: true,
      cancelable: true,
    });
    editor.dispatchEvent(event);
    return {
      plain: captured['text/plain'] ?? '',
      html: captured['text/html'] ?? '',
      contentAfter: editor.textContent ?? '',
    };
  }, selector);
}

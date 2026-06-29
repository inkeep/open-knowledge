
import type { Page } from '@playwright/test';
import { selectAllAndWaitForSelection } from './editor-state';

export async function simulateCopyAndRead(
  page: Page,
  view: 'wysiwyg' | 'source' = 'wysiwyg',
): Promise<{ plain: string; html: string }> {
  const selector = view === 'source' ? '.cm-content' : '.ProseMirror';
  await selectAllAndWaitForSelection(page, selector);
  return page.evaluate((sel) => {
    const editor = document.querySelector(sel) as HTMLElement | null;
    if (!editor) {
      const editorCount = document.querySelectorAll('.ProseMirror, .cm-content').length;
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

export async function simulateCutAndRead(
  page: Page,
  view: 'wysiwyg' | 'source' = 'wysiwyg',
): Promise<{ plain: string; html: string; contentAfter: string }> {
  const selector = view === 'source' ? '.cm-content' : '.ProseMirror';
  await selectAllAndWaitForSelection(page, selector);
  return page.evaluate((sel) => {
    const editor = document.querySelector(sel) as HTMLElement | null;
    if (!editor) {
      const editorCount = document.querySelectorAll('.ProseMirror, .cm-content').length;
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

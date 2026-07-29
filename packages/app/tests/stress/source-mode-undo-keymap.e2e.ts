/**
 * Source-mode undo keymap — real browser end to end.
 *
 * The source editor's only undo authority is the origin-aware y-codemirror
 * Y.UndoManager, driven by `yUndoManagerKeymap`; CodeMirror's native history is
 * removed. Unit and integration tiers pin the origin discrimination and the
 * single-undo-system invariant against a real EditorView; this rung proves the
 * remaining link they cannot: a real Mod-z keydown in a real browser resolves
 * through the installed keymap and reverts the user's typing.
 */

import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import { expect, test, waitForActiveProviderSynced as waitForProvider } from './_helpers';

const SENTINEL = 'undo-me-sentinel-xyz';

/**
 * The redo chord differs by platform. `yUndoManagerKeymap` binds redo to
 * `Mod-y` with a `mac` override of `Mod-Shift-z`, plus a platform-agnostic
 * `Mod-Shift-z`. Press what a user on this platform actually presses, so the
 * assertion tracks the binding that ships rather than one chord that happens
 * to resolve on the author's machine.
 */
const REDO_CHORD = process.platform === 'darwin' ? 'Meta+Shift+z' : 'Control+y';

/** Read the shared Y.Text('source') off the active provider. */
function readSource(page: Page): Promise<string> {
  return page.evaluate(() => window.__activeProvider?.document.getText('source').toString() ?? '');
}

test.describe('source-mode undo keymap', () => {
  let docName: string;

  test.beforeEach(async ({ page, api }) => {
    docName = `test-source-undo-${randomUUID().slice(0, 8)}`;
    await api.createPage(`${docName}.md`);
    await page.goto(`/#/${docName}`);
    await waitForProvider(page);
    await page.waitForSelector('.ProseMirror:not(.composer-prosemirror)');
    await page.getByRole('radio', { name: 'Markdown source' }).click();
    await page.waitForSelector('.cm-content', { timeout: 10_000 });
  });

  test('Mod-z in source mode reverts the user typing via the origin-aware undo', async ({
    page,
  }) => {
    await page.locator('.cm-content').click();
    await page.keyboard.type(SENTINEL);

    await expect.poll(() => readSource(page), { timeout: 10_000 }).toContain(SENTINEL);

    await page.keyboard.press('ControlOrMeta+z');

    await expect.poll(() => readSource(page), { timeout: 10_000 }).not.toContain(SENTINEL);
  });

  test('the platform redo chord redoes the reverted typing', async ({ page }) => {
    await page.locator('.cm-content').click();
    await page.keyboard.type(SENTINEL);
    await expect.poll(() => readSource(page), { timeout: 10_000 }).toContain(SENTINEL);

    await page.keyboard.press('ControlOrMeta+z');
    await expect.poll(() => readSource(page), { timeout: 10_000 }).not.toContain(SENTINEL);

    await page.keyboard.press(REDO_CHORD);
    await expect.poll(() => readSource(page), { timeout: 10_000 }).toContain(SENTINEL);
  });
});

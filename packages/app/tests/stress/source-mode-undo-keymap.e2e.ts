/**
 * Source-mode undo keymap — real browser end to end.
 *
 * The source editor's only undo authority is the origin-aware y-codemirror
 * Y.UndoManager, driven by `yUndoManagerKeymap`; CodeMirror's native history is
 * removed. Unit and integration tiers pin the origin discrimination and the
 * single-undo-system invariant against a real EditorView; this rung proves the
 * remaining link they cannot: a real keydown in a real browser resolves through
 * the installed keymap and moves the user's typing.
 */

import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import { expect, test, waitForActiveProviderSynced as waitForProvider } from './_helpers';

const SENTINEL = 'undo-me-sentinel-xyz';

interface RedoChord {
  /** Playwright `press()` spelling. */
  press: string;
  /** `KeyboardEvent.key` a physical keyboard produces for this chord. */
  key: string;
  shiftKey: boolean;
}

/**
 * Redo chords a user on this platform actually presses.
 *
 * `yUndoManagerKeymap` binds redo to `Mod-y` with a `mac` override of
 * `Mod-Shift-z`, plus a platform-agnostic `Mod-Shift-z`. CodeMirror resolves a
 * binding as `b[platform] || b.key`, so the `mac` property replaces rather than
 * adds: macOS gets `Shift-Meta-z` alone, and every other platform gets both
 * `Ctrl-y` and `Shift-Ctrl-z`. That keymap declares neither `win` nor `linux`,
 * so the Windows and Linux columns of this matrix are the same two chords by
 * construction; there is no Windows runner in CI and the Linux arm covers it.
 *
 * The `Z` is uppercase on purpose, and must stay that way. Playwright applies
 * the shift transform only to the `'Z'` and `'KeyZ'` spellings, so the
 * lowercase `'Control+Shift+z'` delivers `key: 'z'`. CodeMirror's first keymap
 * lookup deliberately drops `Shift-` for printable characters, so that lands on
 * `Ctrl-z` and runs undo instead; y-codemirror's commands are `undo() || true`,
 * so the no-op undo still reports handled and calls `preventDefault`, and redo
 * silently never runs. A physical keyboard emits `key: 'Z'` and reaches redo.
 * macOS hides this: `w3c-keyname` rebuilds the key from the keycode when Shift
 * and Cmd are held together, so the mac arm passes on either spelling.
 */
const REDO_CHORDS: RedoChord[] =
  process.platform === 'darwin'
    ? [{ press: 'Meta+Shift+Z', key: 'Z', shiftKey: true }]
    : [
        { press: 'Control+y', key: 'y', shiftKey: false },
        { press: 'Control+Shift+Z', key: 'Z', shiftKey: true },
      ];

type DeliveredKeydown = { key: string; shiftKey: boolean };

interface KeydownProbeWindow {
  __redoKeydowns?: DeliveredKeydown[];
}

/** Read the shared Y.Text('source') off the active provider. */
function readSource(page: Page): Promise<string> {
  return page.evaluate(() => window.__activeProvider?.document.getText('source').toString() ?? '');
}

/**
 * Record the non-modifier keydowns the page actually receives. Without this the
 * suite cannot tell a keymap regression from a chord that was never delivered
 * in the spelling the assertion assumes, and it fails at the sentinel instead
 * of at the cause.
 */
async function installKeydownProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    const probed = window as unknown as KeydownProbeWindow;
    probed.__redoKeydowns = [];
    window.addEventListener(
      'keydown',
      (event) => {
        if (['Control', 'Shift', 'Meta', 'Alt'].includes(event.key)) return;
        probed.__redoKeydowns?.push({ key: event.key, shiftKey: event.shiftKey });
      },
      { capture: true },
    );
  });
}

function readKeydownProbe(page: Page): Promise<DeliveredKeydown[]> {
  return page.evaluate(() => (window as unknown as KeydownProbeWindow).__redoKeydowns ?? []);
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

  for (const chord of REDO_CHORDS) {
    test(`${chord.press} redoes the reverted typing`, async ({ page }) => {
      await page.locator('.cm-content').click();
      await page.keyboard.type(SENTINEL);
      await expect.poll(() => readSource(page), { timeout: 10_000 }).toContain(SENTINEL);

      await page.keyboard.press('ControlOrMeta+z');
      await expect.poll(() => readSource(page), { timeout: 10_000 }).not.toContain(SENTINEL);

      await installKeydownProbe(page);
      await page.keyboard.press(chord.press);

      // Delivery first, so a spelling that stopped producing the physical
      // keyboard's event fails here rather than looking like a keymap gap.
      expect(await readKeydownProbe(page)).toEqual([{ key: chord.key, shiftKey: chord.shiftKey }]);

      await expect.poll(() => readSource(page), { timeout: 10_000 }).toContain(SENTINEL);
    });
  }
});

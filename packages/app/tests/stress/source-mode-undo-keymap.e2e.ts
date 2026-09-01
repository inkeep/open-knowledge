import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import { expect, test, waitForActiveProviderSynced as waitForProvider } from './_helpers';

const SENTINEL = 'undo-me-sentinel-xyz';

interface RedoChord {
  press: string;
  key: string;
  shiftKey: boolean;
}

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

function readSource(page: Page): Promise<string> {
  return page.evaluate(() => window.__activeProvider?.document.getText('source').toString() ?? '');
}

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

      expect(await readKeydownProbe(page)).toEqual([{ key: chord.key, shiftKey: chord.shiftKey }]);

      await expect.poll(() => readSource(page), { timeout: 10_000 }).toContain(SENTINEL);
    });
  }
});

import type { Page } from '@playwright/test';
import {
  createMp3Buffer,
  createMp4Buffer,
  createPngBuffer,
  escapeRegExp,
  expect,
  test,
  uniqueAssetName,
  waitForActiveProviderSynced as waitForProvider,
} from './_helpers';

const PROP_PANEL_TIMEOUT = 1_500;

async function dropFileIntoEditor(
  page: Page,
  bytes: number[],
  filename: string,
  mime: string,
): Promise<void> {
  await page.evaluate(
    ({ bytes: byteArr, filename: fn, mime: mt }) => {
      const active = (window as unknown as { __activeEditor?: { view?: { dom?: HTMLElement } } })
        .__activeEditor;
      const editor = active?.view?.dom ?? null;
      if (!editor) throw new Error('no active editor (window.__activeEditor.view.dom)');
      const file = new File([new Uint8Array(byteArr)], fn, { type: mt });
      const dt = new DataTransfer();
      dt.items.add(file);
      const rect = editor.getBoundingClientRect();
      const cx = rect.left + Math.floor(rect.width / 2);
      const cy = rect.top + Math.floor(rect.height / 2);
      editor.dispatchEvent(
        new DragEvent('dragover', {
          dataTransfer: dt,
          bubbles: true,
          cancelable: true,
          clientX: cx,
          clientY: cy,
        }),
      );
      editor.dispatchEvent(
        new DragEvent('drop', {
          dataTransfer: dt,
          bubbles: true,
          cancelable: true,
          clientX: cx,
          clientY: cy,
        }),
      );
    },
    { bytes, filename, mime },
  );
}

async function getSourceText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const provider = window.__activeProvider;
    return provider?.document?.getText('source')?.toString() ?? '';
  });
}

const cases = [
  {
    name: 'png-image',
    label: 'image/png',
    filename: 'photo.png',
    mime: 'image/png',
    bytes: (runId: string) => Array.from(createPngBuffer(`drop-noautoopen-png-${runId}`)),
  },
  {
    name: 'mp4-video',
    label: 'video/mp4',
    filename: 'clip.mp4',
    mime: 'video/mp4',
    bytes: (runId: string) => Array.from(createMp4Buffer(`drop-noautoopen-mp4-${runId}`)),
  },
  {
    name: 'mp3-audio',
    label: 'audio/mpeg',
    filename: 'sound.mp3',
    mime: 'audio/mpeg',
    bytes: (runId: string) => Array.from(createMp3Buffer(`drop-noautoopen-mp3-${runId}`)),
  },
] as const;

test.describe('Drop pipeline does not auto-open the descriptor PropPanel', () => {
  for (const c of cases) {
    test(`DROP-NOAUTOOPEN-${c.name.toUpperCase()}: dropped ${c.label} is selected, popover stays closed`, async ({
      page,
      api,
    }) => {
      const runId = Math.random().toString(36).slice(2, 10);
      const assetName = uniqueAssetName(c.filename, runId);
      const docName = `drop-noautoopen-${c.name}-${runId}`;
      await api.createPage(`${docName}.md`);
      await page.goto(`/#/${docName}`);
      await waitForProvider(page);
      await page.waitForSelector('.ProseMirror:not(.composer-prosemirror)');
      await page.click('.ProseMirror:not(.composer-prosemirror)');

      await dropFileIntoEditor(page, c.bytes(runId), assetName, c.mime);

      await expect
        .poll(async () => await getSourceText(page), { timeout: 5_000 })
        .toMatch(new RegExp(escapeRegExp(assetName)));

      await expect(page.locator('[data-prop-panel]')).toBeHidden({
        timeout: PROP_PANEL_TIMEOUT,
      });
    });
  }
});

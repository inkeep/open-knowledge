import type { Locator, Page } from '@playwright/test';
import { expect, test, waitForActiveProviderSynced } from './_helpers';

const FILE_LIST = '[data-slot="sidebar-container"]';
const RAIL = '[data-sidebar="rail"]';
const EDITOR_CARD = '[data-slot="pane-card"][data-pane="editor"]';
const BOOT_TIMEOUT_MS = 30_000;
const FIRST_MOVE_PX = 8;
const DRAG_PX = 80;
const WIDTH_TOLERANCE_PX = 1;
const REM_PX = 16;
const GRABS = [
  { label: 'the middle of the edge', offsetPx: 0 },
  { label: 'just inside the file list', offsetPx: -4 },
  { label: 'just inside the document', offsetPx: 4 },
] as const;

async function widthOf(locator: Locator): Promise<number> {
  return locator.evaluate((element) => element.getBoundingClientRect().width);
}

async function savedWidthPx(page: Page): Promise<number | null> {
  const raw = await page.evaluate(
    () =>
      document.cookie
        .split('; ')
        .find((row) => row.startsWith('sidebar_width='))
        ?.split('=')[1] ?? null,
  );
  if (raw == null) return null;
  const value = Number.parseFloat(raw);
  return raw.endsWith('rem') ? value * REM_PX : value;
}

async function waitForEditorWithFileList(page: Page): Promise<void> {
  await waitForActiveProviderSynced(page);
  await expect(page.locator('.ProseMirror:not(.composer-prosemirror)').first()).toBeVisible({
    timeout: BOOT_TIMEOUT_MS,
  });
  await expect(page.locator('[data-slot="sidebar"]').first()).toHaveAttribute(
    'data-state',
    'expanded',
  );
}

for (const grab of GRABS) {
  test(`dragging the file list edge from ${grab.label} saves the width the user sees`, async ({
    page,
    api,
  }) => {
    const docName = `editor-card-file-list-drag-${test.info().workerIndex}-${grab.offsetPx + 4}`;
    await api.seedDocs([{ name: docName, markdown: `# ${docName}\n\nbody\n` }]);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`/#/${docName}`);
    await waitForEditorWithFileList(page);

    const fileList = page.locator(FILE_LIST);
    await expect(
      page.locator(EDITOR_CARD).locator(FILE_LIST),
      'the file list lives in the editor card',
    ).toHaveCount(1);
    const widthBefore = await widthOf(fileList);

    const railBox = await page.locator(RAIL).boundingBox();
    if (railBox == null) throw new Error('the file list edge has no bounds');
    const x = railBox.x + railBox.width / 2 + grab.offsetPx;
    const y = railBox.y + railBox.height / 2;
    expect(
      await page.evaluate(
        ([px, py]) => document.elementFromPoint(px, py)?.closest('[data-sidebar="rail"]') != null,
        [x, y] as const,
      ),
      'the grab point lands on the file list edge',
    ).toBe(true);

    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + FIRST_MOVE_PX, y);
    await expect
      .poll(async () => Math.abs((await widthOf(fileList)) - (widthBefore + FIRST_MOVE_PX)), {
        message: 'the first move does not jump',
      })
      .toBeLessThanOrEqual(WIDTH_TOLERANCE_PX);
    await page.mouse.move(x + DRAG_PX, y, { steps: 10 });
    await expect
      .poll(async () => Math.abs((await widthOf(fileList)) - (widthBefore + DRAG_PX)), {
        message: 'mid-drag the edge follows the pointer',
      })
      .toBeLessThanOrEqual(WIDTH_TOLERANCE_PX);
    await page.mouse.up();

    const seen = await widthOf(fileList);
    expect(Math.abs(seen - (widthBefore + DRAG_PX))).toBeLessThanOrEqual(WIDTH_TOLERANCE_PX);
    const saved = await savedWidthPx(page);
    expect(saved, 'the drag saved a width').not.toBeNull();
    expect(
      Math.abs((saved ?? 0) - seen),
      'the saved width is the width on screen',
    ).toBeLessThanOrEqual(WIDTH_TOLERANCE_PX);

    await page.reload();
    await waitForEditorWithFileList(page);
    await expect
      .poll(async () => Math.abs((await widthOf(fileList)) - seen), {
        message: 'the saved width comes back after a reload',
      })
      .toBeLessThanOrEqual(WIDTH_TOLERANCE_PX);
  });
}

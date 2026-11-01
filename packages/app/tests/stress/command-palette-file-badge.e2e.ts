import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from './_helpers';

test.describe('command-palette — file rows (real cmdk)', () => {
  test('a long file-extension badge stays inside the palette', async ({
    page,
    api,
    workerServer,
  }) => {
    await api.seedDocs([{ name: 'note', markdown: '# note\n\nHello there.\n' }]);
    mkdirSync(join(workerServer.contentDir, 'boards'), { recursive: true });
    writeFileSync(
      join(workerServer.contentDir, 'boards', 'sync-plan.excalidraw'),
      JSON.stringify({ type: 'excalidraw', version: 2, elements: [], appState: {}, files: {} }),
    );

    await page.goto('/');
    await page.waitForSelector('[role="treeitem"]', { timeout: 15_000 });
    await page.keyboard.press('ControlOrMeta+k');
    const list = page.locator('[data-slot="command-list"]');
    await expect(list).toBeVisible({ timeout: 5_000 });
    await page.keyboard.type('sync-plan');

    const row = page.getByTestId('command-palette-nav-file-boards/sync-plan.excalidraw');
    await expect(row).toBeVisible({ timeout: 10_000 });

    const overflowPx = await row.evaluate((rowElement) => {
      const listElement = rowElement.closest('[data-slot="command-list"]');
      if (!listElement) throw new Error('row is not inside the command list');
      const listLeft = listElement.getBoundingClientRect().left;
      const leftmost = Math.min(
        ...[...rowElement.querySelectorAll('*')].map((el) => el.getBoundingClientRect().left),
      );
      return listLeft - leftmost;
    });
    expect(overflowPx).toBeLessThanOrEqual(0);
  });
});

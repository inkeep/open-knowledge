import type { Page } from '@playwright/test';
import {
  type DockUnitRect,
  dockUnitRect,
  expect,
  type HeaderPane,
  identityOf,
  openDesktopLayout,
  openWebLayout,
  runPaletteCommand,
  SAME_NODE,
  setHeaderPane,
  test,
  waitForActiveProviderSynced,
} from './_helpers';

const VIEWPORT = { width: 1600, height: 900 };
const CHIP = '[data-dock-drag-chip]';

async function seedDoc(
  api: { seedDocs: (docs: { name: string; markdown: string }[]) => Promise<unknown> },
  slug: string,
) {
  const name = `dock-redock-${slug}-${test.info().workerIndex}`;
  await api.seedDocs([{ name, markdown: `# ${name}\n\nRe-docking fixture.\n` }]);
  return name;
}

async function rectOf(page: Page, pane: HeaderPane): Promise<DockUnitRect> {
  const rect = await dockUnitRect(page, pane);
  if (rect === null) throw new Error(`the ${pane} unit is not showing`);
  return rect;
}

async function grabPoint(page: Page, pane: HeaderPane): Promise<{ x: number; y: number }> {
  const point = await page.evaluate((target) => {
    const handle = document.querySelector(`[data-dock-unit="${target}"] [data-dock-handle]`);
    if (!(handle instanceof HTMLElement)) return null;
    const box = handle.getBoundingClientRect();
    const y = box.top + box.height / 2;
    const controls =
      'button, a[href], input, textarea, select, [role="tab"], [role="button"], [role="menuitem"], [role="combobox"]';
    for (let x = box.right - 6; x > box.left; x -= 6) {
      const hit = document.elementFromPoint(x, y);
      if (hit === null || !handle.contains(hit)) continue;
      const control = hit.closest(controls);
      if (control === null || !handle.contains(control)) return { x, y };
    }
    return null;
  }, pane);
  if (point === null) throw new Error(`the ${pane} tab strip has no free spot to grab`);
  return point;
}

async function dragHeaderTo(
  page: Page,
  pane: HeaderPane,
  to: { x: number; y: number },
  whileDragging?: () => Promise<void>,
): Promise<void> {
  const from = await grabPoint(page, pane);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 10 });
  await whileDragging?.();
  await page.mouse.up();
}

async function agentsSitsLeftOfEditor(page: Page): Promise<boolean> {
  const agents = await dockUnitRect(page, 'agents');
  const editor = await dockUnitRect(page, 'editor');
  return agents !== null && editor !== null && agents.x + agents.width <= editor.x;
}

test.describe('re-docking a pane by its tab strip', () => {
  test('dragging the Agents tab strip onto the left half of the editor docks it there, and a reload keeps it', async ({
    page,
    api,
  }) => {
    const docName = await seedDoc(api, 'left-of-editor');
    await openWebLayout(page, docName, VIEWPORT);
    await setHeaderPane(page, 'agents', true);
    expect(await agentsSitsLeftOfEditor(page)).toBe(false);
    const editor = await rectOf(page, 'editor');

    await dragHeaderTo(
      page,
      'agents',
      { x: editor.x + 40, y: editor.y + editor.height / 2 },
      async () => {
        await expect(
          page.locator('[data-dock-drop-zone="start"][data-dock-drop-pane="editor"]'),
        ).toBeVisible();
        await expect(page.locator(CHIP)).toHaveText('Agents');
      },
    );

    await expect(page.locator(CHIP)).toHaveCount(0);
    await expect.poll(() => agentsSitsLeftOfEditor(page)).toBe(true);

    await page.reload();
    await waitForActiveProviderSynced(page);
    await setHeaderPane(page, 'agents', true);
    await expect.poll(() => agentsSitsLeftOfEditor(page)).toBe(true);
  });

  test('dropping the Agents tab strip on the middle of the editor swaps the two', async ({
    page,
    api,
  }) => {
    const docName = await seedDoc(api, 'swap');
    await openWebLayout(page, docName, VIEWPORT);
    await setHeaderPane(page, 'agents', true);
    const editor = await rectOf(page, 'editor');
    const agents = await rectOf(page, 'agents');

    await dragHeaderTo(page, 'agents', {
      x: editor.x + editor.width / 2,
      y: editor.y + editor.height / 2,
    });

    await expect.poll(async () => (await rectOf(page, 'agents')).x).toBeCloseTo(editor.x, 0);
    expect((await rectOf(page, 'agents')).width).toBeCloseTo(editor.width, 0);
    expect((await rectOf(page, 'editor')).width).toBeCloseTo(agents.width, 0);
  });

  test('Escape cancels a drag, and the release leaves the layout as it was', async ({
    page,
    api,
  }) => {
    const docName = await seedDoc(api, 'escape');
    await openWebLayout(page, docName, VIEWPORT);
    await setHeaderPane(page, 'agents', true);
    const before = { agents: await rectOf(page, 'agents'), editor: await rectOf(page, 'editor') };

    await dragHeaderTo(
      page,
      'agents',
      { x: before.editor.x + 40, y: before.editor.y + 200 },
      async () => {
        await expect(page.locator(CHIP)).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(page.locator(CHIP)).toHaveCount(0);
      },
    );

    expect({ agents: await rectOf(page, 'agents'), editor: await rectOf(page, 'editor') }).toEqual(
      before,
    );
  });

  test('the palette moves Agents to the left edge and shows it', async ({ page, api }) => {
    const docName = await seedDoc(api, 'palette');
    await openWebLayout(page, docName, VIEWPORT);
    await expect(page.locator('[data-dock-unit="agents"]')).toHaveAttribute(
      'data-dock-unit-off',
      '',
    );

    await runPaletteCommand(page, 'Move Agents to the left', 'move-agents-left');

    await expect.poll(() => agentsSitsLeftOfEditor(page)).toBe(true);
  });

  test('dragging the Terminal tab strip onto the bottom half of Agents docks it under Agents without restarting it', async ({
    page,
    api,
    workerServer,
  }) => {
    const docName = await seedDoc(api, 'terminal-under-agents');
    await openDesktopLayout(page, workerServer, docName, {
      viewport: VIEWPORT,
      terminalPlacement: 'bottom',
    });
    await setHeaderPane(page, 'agents', true);
    await setHeaderPane(page, 'terminal', true);
    const mount = await page.locator('[data-terminal-panel-mount]').elementHandle();
    if (mount === null) throw new Error('no terminal mount');
    const agents = await rectOf(page, 'agents');

    await dragHeaderTo(page, 'terminal', {
      x: agents.x + agents.width / 2,
      y: agents.y + agents.height - 40,
    });

    await expect
      .poll(async () => {
        const terminal = await rectOf(page, 'terminal');
        const above = await rectOf(page, 'agents');
        return (
          terminal.y >= above.y + above.height &&
          Math.abs(terminal.x - above.x) <= 1 &&
          Math.abs(terminal.width - above.width) <= 1
        );
      })
      .toBe(true);
    expect(await identityOf(mount, page.locator('[data-terminal-panel-mount]'))).toEqual(SAME_NODE);
  });
});

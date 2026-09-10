import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { expect, test } from './_helpers';

const EDITOR = '.ProseMirror:not(.composer-prosemirror)';

test('third-level items keep their target for dragging and keyboard reordering', async ({
  page,
  api,
}) => {
  const docName = `list-depth-three-${randomUUID()}`;
  await api.createPage(`${docName}.md`);
  await api.replaceDoc(
    docName,
    '- Root\n  - Middle\n    - Deep first\n    - Deep second\n  - Uncle\n- End\n',
  );
  await page.goto(`/#/${docName}`);
  const deep = page.locator(`${EDITOR} li`).filter({ hasText: /^Deep (first|second)$/ });
  await expect(deep).toHaveText(['Deep first', 'Deep second']);
  expect(
    await deep.first().evaluate((item) => {
      let depth = 0;
      for (let ancestor = item.parentElement; ancestor; ancestor = ancestor.parentElement) {
        if (ancestor.matches('ul, ol')) depth++;
      }
      return depth;
    }),
  ).toBe(3);
  await dragItem(page, deep.nth(1), deep.nth(0), 'before');
  await expect(deep).toHaveText(['Deep second', 'Deep first']);
  await deep.nth(0).locator('p').click();
  await page.keyboard.press('ControlOrMeta+Shift+ArrowDown');
  await expect(deep).toHaveText(['Deep first', 'Deep second']);
  await expect(page.locator(`${EDITOR} > ul > li`)).toHaveText([
    'RootMiddleDeep firstDeep secondUncle',
    'End',
  ]);
});

for (const [kind, markdown] of [
  ['bullet', '- Parent\n  - Child\n  - Sibling\n- Following\n'],
  ['ordered', '1. Parent\n   1. Child\n   2. Sibling\n2. Following\n'],
  ['task', '- [ ] Parent\n  - [ ] Child\n  - [x] Sibling\n- [ ] Following\n'],
] as const) {
  test(`nested ${kind} handle stays reachable while moving slowly through its gutter`, async ({
    page,
    api,
  }) => {
    const docName = `list-reach-${randomUUID()}`;
    await api.createPage(`${docName}.md`);
    await api.replaceDoc(docName, markdown);
    await page.goto(`/#/${docName}`);
    const child = page.locator(`${EDITOR} li`).filter({ hasText: /^Child$/ });
    await child.hover();
    const grip = page.locator('.ok-drag-grip:visible');
    await expect(grip).toBeVisible();
    const start = await child.boundingBox();
    const handle = await grip.boundingBox();
    if (!start || !handle) throw new Error('Nested item and handle must be visible');
    const fromX = start.x + 40;
    const toX = handle.x + handle.width / 2;
    const y = handle.y + handle.height / 2;
    await page.mouse.move(fromX, y);
    for (let step = 1; step <= 24; step++) {
      await page.mouse.move(fromX + ((toX - fromX) * step) / 24, y);
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );
      const current = await grip.boundingBox();
      expect(current).not.toBeNull();
      expect(Math.abs((current?.y ?? -1000) - handle.y)).toBeLessThan(1);
    }
    await page.mouse.down();
    const following = page.locator(`${EDITOR} > :is(ul, ol) > li`).last();
    const destination = await following.boundingBox();
    if (!destination) throw new Error('Drop target must be visible');
    await page.mouse.move(destination.x + 15, destination.y + 1, { steps: 20 });
    await page.mouse.up();
    await expect(page.locator(`${EDITOR} > :is(ul, ol) > li`)).toHaveText([
      'ParentSibling',
      'Child',
      'Following',
    ]);
  });
}

test('nested handle is dismissed after a document update and returns on hover', async ({
  page,
  api,
}) => {
  const docName = `list-hover-update-${randomUUID()}`;
  await api.createPage(`${docName}.md`);
  await api.replaceDoc(docName, '- Parent\n  - Child\n  - Sibling\n- Following\n');
  await page.goto(`/#/${docName}`);
  const child = page.locator(`${EDITOR} li`).filter({ hasText: /^Child$/ });
  await child.hover();
  const grip = page.locator('.ok-drag-grip:visible');
  await expect(grip).toBeVisible();
  const before = await grip.boundingBox();
  if (!before) throw new Error('Nested handle must be visible');
  await api.replaceDoc(docName, '- Parent\n  - Child edited\n  - Sibling\n- Following\n');
  const updated = page.locator(`${EDITOR} li`).filter({ hasText: /^Child edited$/ });
  await expect(updated).toBeVisible();
  await expect(grip).toBeHidden();
  const updatedRect = await updated.boundingBox();
  if (!updatedRect) throw new Error('Updated nested item must be visible');
  await page.mouse.move(updatedRect.x + 40, updatedRect.y + updatedRect.height / 2);
  await expect
    .poll(async () => {
      const after = await grip.boundingBox();
      return Math.abs((after?.y ?? -1000) - before.y);
    })
    .toBeLessThan(1);
  await grip.click();
  await expect(updated).toHaveClass(/ProseMirror-selectednode/);
});

test('handle appears again over the same item after cancelling a drag', async ({ page, api }) => {
  const docName = `list-reappear-${randomUUID()}`;
  await api.createPage(`${docName}.md`);
  await api.replaceDoc(docName, '- Alpha\n- Beta\n');
  await page.goto(`/#/${docName}`);
  const item = page.locator(`${EDITOR} > ul > li`).first();
  await item.hover();
  const grip = page.locator('.ok-drag-grip:visible');
  await expect(grip).toBeVisible();
  const handle = await grip.boundingBox();
  const itemRect = await item.boundingBox();
  if (!handle || !itemRect) throw new Error('Drag endpoints must be visible');
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(itemRect.x + 30, itemRect.y + itemRect.height / 2, { steps: 20 });
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await page.mouse.move(itemRect.x + 40, itemRect.y + itemRect.height / 2);
  await expect(grip).toBeVisible();
  await expect(page.locator(`${EDITOR} > ul > li`)).toHaveText(['Alpha', 'Beta']);
});

test('list handles share a gutter outside bullets, numbers, and checkboxes', async ({
  page,
  api,
}, testInfo) => {
  const docName = `list-gutter-${randomUUID()}`;
  await api.createPage(`${docName}.md`);
  await api.replaceDoc(
    docName,
    '- Bullet one\n- Bullet two\n\nBetween lists\n\n99. Number one\n100. Number two\n\nBetween lists again\n\n- [ ] Task one\n- [x] Task two\n',
  );
  await page.goto(`/#/${docName}`);
  const lists = page.locator(`${EDITOR} > :is(ul, ol)`);
  await expect(lists).toHaveCount(3);
  const rightEdges: number[] = [];
  for (let index = 0; index < 3; index++) {
    const list = lists.nth(index);
    const items = list.locator(':scope > li');
    for (let itemIndex = 0; itemIndex < 2; itemIndex++) {
      await items.nth(itemIndex).hover();
      const controls = page.locator('.ok-block-controls:visible');
      await expect(controls).toBeVisible();
      await expect
        .poll(async () => {
          const listRect = await list.boundingBox();
          const handleRect = await controls.boundingBox();
          if (!listRect || !handleRect) return Number.POSITIVE_INFINITY;
          return Math.abs(handleRect.x + handleRect.width - (listRect.x - 10));
        })
        .toBeLessThan(1);
      const handleRect = await controls.boundingBox();
      if (!handleRect) throw new Error('List controls are not measurable');
      rightEdges.push(handleRect.x + handleRect.width);
    }
  }
  expect(Math.max(...rightEdges) - Math.min(...rightEdges)).toBeLessThan(1);
  await page.screenshot({ path: testInfo.outputPath('list-gutter.png') });
});

async function dragItem(page: Page, item: Locator, target: Locator, edge: 'before' | 'after') {
  await item.hover();
  const grip = page.locator('.ok-drag-grip:visible');
  await expect(grip).toBeVisible();
  const start = await grip.boundingBox();
  const end = await target.boundingBox();
  if (!start || !end) throw new Error('Drag endpoints are not visible');
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(end.x + 12, edge === 'before' ? end.y + 1 : end.y + end.height - 1, {
    steps: 20,
  });
  await expect(page.getByTestId('bubble-menu-bar')).toBeHidden();
  await expect(page.locator('.prosemirror-dropcursor-block')).toBeVisible();
  await page.mouse.up();
}

for (const [kind, markdown] of [
  ['bullet', '- Alpha\n- Beta\n- Gamma\n'],
  ['ordered', '1. Alpha\n2. Beta\n3. Gamma\n'],
  ['task', '- [ ] Alpha\n- [ ] Beta\n- [x] Gamma\n'],
] as const) {
  test(`reorder one ${kind} item using its grip`, async ({ page, api, workerServer }) => {
    const docName = `list-drag-${randomUUID()}`;
    await api.createPage(`${docName}.md`);
    await api.replaceDoc(docName, markdown);
    await page.goto(`/#/${docName}`);
    const items = page.locator(`${EDITOR} > :is(ul, ol) > li`);
    await expect(items).toHaveCount(3);
    const peer = kind === 'ordered' ? await page.context().newPage() : null;
    if (peer) {
      await peer.goto(`/#/${docName}`);
      await expect(peer.locator(`${EDITOR} > ol > li`)).toHaveText(['Alpha', 'Beta', 'Gamma']);
    }
    await dragItem(page, items.nth(2), items.nth(1), 'before');
    await expect(items).toHaveText(['Alpha', 'Gamma', 'Beta']);
    if (kind === 'task') {
      await expect(items.nth(1).getByRole('checkbox')).toBeChecked();
    }
    if (kind === 'ordered') {
      await expect
        .poll(() => readFile(join(workerServer.contentDir, `${docName}.md`), 'utf8'))
        .toBe('1. Alpha\n2. Gamma\n3. Beta\n');
    }
    if (peer) {
      await expect(peer.locator(`${EDITOR} > ol > li`)).toContainText(['Alpha', 'Gamma', 'Beta']);
      await peer.close();
    }
    await page.reload();
    await expect(items).toHaveText(['Alpha', 'Gamma', 'Beta']);
  });
}

test('move an ordered item outside its list and undo once', async ({ page, api }) => {
  const docName = `list-outside-${randomUUID()}`;
  await api.createPage(`${docName}.md`);
  await api.replaceDoc(docName, '1. Alpha\n2. Beta\n3. Gamma\n\nSeparator\n\nEnd\n');
  await page.goto(`/#/${docName}`);
  const editor = page.locator(EDITOR);
  const items = editor.locator(':scope > ol > li');
  await expect(items).toHaveCount(3);
  await dragItem(page, items.nth(2), editor.locator(':scope > p').last(), 'before');
  await expect(editor.locator(':scope > ol')).toHaveCount(2);
  await expect(editor.locator(':scope > ol').nth(0).locator('li')).toHaveText(['Alpha', 'Beta']);
  await expect(editor.locator(':scope > ol').nth(1).locator('li')).toHaveText(['Gamma']);
  await page.keyboard.press('ControlOrMeta+z');
  await expect(editor.locator(':scope > ol')).toHaveCount(1);
  await expect(items).toHaveText(['Alpha', 'Beta', 'Gamma']);
});

test('move the selected whole list as one block', async ({ page, api }) => {
  const docName = `list-whole-${randomUUID()}`;
  await api.createPage(`${docName}.md`);
  await api.replaceDoc(docName, '- Alpha\n- Beta\n- Gamma\n\nSeparator\n\nEnd\n');
  await page.goto(`/#/${docName}`);
  const editor = page.locator(EDITOR);
  const items = editor.locator(':scope > ul > li');
  await expect(items).toHaveCount(3);
  await page.evaluate(() => {
    const editor = window.__activeEditor;
    if (!editor) throw new Error('Editor unavailable');
    const list = editor.state.doc.firstChild;
    if (!list) throw new Error('List unavailable');
    editor.commands.setTextSelection({ from: 3, to: list.nodeSize - 3 });
  });
  await dragItem(page, items.nth(1), editor.locator(':scope > p').last(), 'before');
  await expect(editor.locator(':scope > :is(p, ul)')).toHaveText([
    'Separator',
    'AlphaBetaGamma',
    'End',
  ]);
});

test('drag a selected subset of list items together', async ({ page, api }) => {
  const docName = `list-selection-${randomUUID()}`;
  await api.createPage(`${docName}.md`);
  await api.replaceDoc(docName, '- Alpha\n- Beta\n- Gamma\n- Delta\n');
  await page.goto(`/#/${docName}`);
  const items = page.locator(`${EDITOR} > ul > li`);
  await expect(items).toHaveCount(4);
  await page.evaluate(() => {
    const editor = window.__activeEditor;
    if (!editor) throw new Error('Editor unavailable');
    let from = 0;
    let to = 0;
    editor.state.doc.descendants((node, pos) => {
      if (node.type.name === 'paragraph' && node.textContent === 'Beta') from = pos + 1;
      if (node.type.name === 'paragraph' && node.textContent === 'Gamma') {
        to = pos + 1 + node.content.size;
      }
    });
    editor.commands.setTextSelection({ from, to });
  });
  await expect(page.getByTestId('bubble-menu-bar')).toBeVisible();
  await dragItem(page, items.nth(1), items.nth(0), 'before');
  await expect(items).toHaveText(['Beta', 'Gamma', 'Alpha', 'Delta']);
  await expect(page.getByTestId('bubble-menu-bar')).toBeHidden();
});

for (const [kind, ending] of [
  ['list', 'Escape'],
  ['list', 'same position'],
  ['list', 'outside editor'],
  ['paragraph', 'Escape'],
] as const) {
  test(`${kind} grip restores the unchanged selection toolbar after ${ending}`, async ({
    page,
    api,
  }) => {
    const docName = `drag-toolbar-${randomUUID()}`;
    await api.createPage(`${docName}.md`);
    await api.replaceDoc(
      docName,
      kind === 'list' ? '- Alpha\n- Beta\n- Gamma\n- Delta\n' : 'Alpha\n\nBeta\n\nGamma\n\nDelta\n',
    );
    await page.goto(`/#/${docName}`);
    const blocks = page.locator(kind === 'list' ? `${EDITOR} > ul > li` : `${EDITOR} > p`);
    await expect(blocks).toHaveText(['Alpha', 'Beta', 'Gamma', 'Delta']);
    const selection = await page.evaluate((list) => {
      const editor = window.__activeEditor;
      if (!editor) throw new Error('Editor unavailable');
      let from = 0;
      let to = 0;
      editor.state.doc.descendants((node, pos) => {
        if (node.type.name === 'paragraph' && node.textContent === 'Beta') from = pos;
        if (node.type.name === 'paragraph' && node.textContent === 'Gamma')
          to = pos + 1 + node.content.size;
      });
      if (list) editor.commands.setTextSelection({ from: from + 1, to });
      else editor.commands.setNodeSelection(from);
      return editor.state.selection.toJSON();
    }, kind === 'list');
    const menu = page.getByTestId('bubble-menu-bar');
    await expect(menu).toBeVisible();
    await blocks.nth(1).hover();
    const grip = page.locator('.ok-drag-grip:visible');
    await expect(grip).toBeVisible();
    const handle = await grip.boundingBox();
    const source = await blocks.nth(1).boundingBox();
    const destination = await blocks.last().boundingBox();
    if (!handle || !source || !destination) throw new Error('Drag endpoints unavailable');
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
    await page.mouse.down();
    await page.mouse.move(destination.x + 30, destination.y + destination.height - 1, {
      steps: 20,
    });
    await expect(menu).toBeHidden();
    await expect.poll(() => page.evaluate(() => !!window.__activeEditor?.view.dragging)).toBe(true);
    if (ending === 'Escape') {
      await page.keyboard.press('Escape');
    } else if (ending === 'same position') {
      await page.mouse.move(source.x + 12, source.y + 1, { steps: 10 });
    } else {
      await page.mouse.move(8, 8, { steps: 10 });
    }
    await page.mouse.up();
    await expect(menu).toBeVisible();
    await expect(blocks).toHaveText(['Alpha', 'Beta', 'Gamma', 'Delta']);
    expect(await page.evaluate(() => window.__activeEditor?.state.selection.toJSON())).toEqual(
      selection,
    );
    expect(await page.evaluate(() => window.__activeEditor?.view.dragging === null)).toBe(true);
  });
}

test('drag a nested item independently and keep the plus control adding below the list', async ({
  page,
  api,
}, testInfo) => {
  const docName = `list-nested-${randomUUID()}`;
  await api.createPage(`${docName}.md`);
  await api.replaceDoc(docName, '- Alpha\n  - Child\n  - Sibling\n- Beta\n- Gamma\n');
  await page.goto(`/#/${docName}`);
  const editor = page.locator(EDITOR);
  const topItems = editor.locator(':scope > ul > li');
  await expect(topItems).toHaveCount(3);
  const child = editor.locator('li').filter({ hasText: /^Child$/ });
  await dragItem(page, child, topItems.nth(1), 'before');
  await expect(topItems).toHaveCount(4);
  await expect(topItems.nth(1)).toHaveText('Child');
  await expect(topItems.nth(0).locator('li')).toHaveText(['Sibling']);
  await topItems.nth(1).hover();
  await page.screenshot({ path: testInfo.outputPath('nested-list-drag.png') });
  await page.locator('.ok-add-block-btn:visible').click();
  await expect(topItems).toHaveCount(4);
  await expect(editor.locator(':scope > p').last()).toHaveText('/');
});

for (const handle of ['item', 'paragraph'] as const) {
  test(`move a mixed selection using its ${handle} handle without moving other items`, async ({
    page,
    api,
  }) => {
    const docName = `list-mixed-${randomUUID()}`;
    await api.createPage(`${docName}.md`);
    await api.replaceDoc(docName, '- Alpha\n- Beta\n- Gamma\n\nIncluded\n\nGap\n\nEnd\n');
    await page.goto(`/#/${docName}`);
    const editor = page.locator(EDITOR);
    const items = editor.locator(':scope > ul > li');
    await expect(items).toHaveCount(3);
    await page.evaluate(() => {
      const editor = window.__activeEditor;
      if (!editor) throw new Error('Editor unavailable');
      let from = 0;
      let to = 0;
      editor.state.doc.descendants((node, pos) => {
        if (node.type.name !== 'paragraph') return;
        if (node.textContent === 'Gamma') from = pos + 1;
        if (node.textContent === 'Included') to = pos + node.nodeSize - 1;
      });
      editor.commands.setTextSelection({ from, to });
    });
    const gripTarget = handle === 'item' ? items.nth(2) : editor.locator(':scope > p').first();
    await dragItem(page, gripTarget, editor.locator(':scope > p').last(), 'before');
    await expect(editor.locator(':scope > :is(p, ul)')).toHaveText([
      'AlphaBeta',
      'Gap',
      'Gamma',
      'Included',
      'End',
    ]);
  });
}

test('move nested items and following blocks without moving unselected parent text', async ({
  page,
  api,
}) => {
  const docName = `list-nested-mixed-${randomUUID()}`;
  await api.createPage(`${docName}.md`);
  await api.replaceDoc(
    docName,
    '- Parent\n  - Child\n  - Sibling\n- Outer\n\nIncluded\n\nGap\n\nEnd\n',
  );
  await page.goto(`/#/${docName}`);
  const editor = page.locator(EDITOR);
  const child = editor.locator('li').filter({ hasText: /^Child$/ });
  await expect(child).toBeVisible();
  await page.evaluate(() => {
    const editor = window.__activeEditor;
    if (!editor) throw new Error('Editor unavailable');
    let from = 0;
    let to = 0;
    editor.state.doc.descendants((node, pos) => {
      if (node.type.name !== 'paragraph') return;
      if (node.textContent === 'Child') from = pos + 1;
      if (node.textContent === 'Included') to = pos + node.nodeSize - 1;
    });
    editor.commands.setTextSelection({ from, to });
  });
  await dragItem(page, child, editor.locator(':scope > p').last(), 'before');
  await expect(editor.locator(':scope > :is(p, ul)')).toHaveText([
    'Parent',
    'Gap',
    'ChildSiblingOuter',
    'Included',
    'End',
  ]);
  await page.evaluate(() => window.__activeEditor?.state.doc.check());
  await page.reload();
  await expect(editor.locator('li')).toHaveText(['Parent', 'Child', 'Sibling', 'Outer']);
});

test.describe('Spanish selection announcements', () => {
  test.use({ locale: 'es-ES' });

  test('announces list moves and block selection changes in Spanish', async ({ page, api }) => {
    const docName = `list-announcements-${randomUUID()}`;
    await api.createPage(`${docName}.md`);
    await api.replaceDoc(
      docName,
      '- Alpha\n- Beta\n\n<Callout type="note">\n\nInside\n\n</Callout>\n\nOutside\n',
    );
    await page.goto(`/#/${docName}`);
    await expect(page.locator('html')).toHaveAttribute('lang', 'es');
    const editor = page.locator(EDITOR);
    const status = page
      .getByTestId('editor-scroll-container')
      .locator('[role="status"][aria-live="polite"]');
    await editor
      .locator('p')
      .filter({ hasText: /^Inside$/ })
      .click();
    await expect(status).toHaveText('Seleccionado: Callout');
    await editor
      .locator('p')
      .filter({ hasText: /^Outside$/ })
      .click();
    await expect(status).toHaveText('Fuera de cualquier bloque');
    const items = editor.locator(':scope > ul > li');
    await items
      .nth(1)
      .locator('p')
      .click({ position: { x: 10, y: 10 } });
    await expect
      .poll(() =>
        page.evaluate(() => window.__activeEditor?.state.selection.$from.parent.textContent),
      )
      .toBe('Beta');
    await page.keyboard.press('ControlOrMeta+Shift+ArrowUp');
    await expect(items).toHaveText(['Beta', 'Alpha']);
    await expect(status).toHaveText('Se movió hacia arriba.');
    await page.keyboard.press('ControlOrMeta+Shift+ArrowDown');
    await expect(items).toHaveText(['Alpha', 'Beta']);
    await expect(status).toHaveText('Se movió hacia abajo.');
  });
});

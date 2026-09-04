import type { Page } from '@playwright/test';
import { expect, resetContentToFixtureBaseline, test } from './_helpers';

async function dragRowToEmptyRootArea(
  page: Page,
  sourcePath: string,
  isFolder: boolean,
): Promise<void> {
  const setup = await page.evaluate(
    ({ sourcePath, isFolder }) => {
      const host = document
        .querySelector('[data-slot="sidebar-container"]')
        ?.querySelector('file-tree-container');
      const shadow = (host as Element & { shadowRoot: ShadowRoot | null })?.shadowRoot;
      if (!shadow) return { ok: false as const, reason: 'no-shadow-root' };

      const rows = Array.from(shadow.querySelectorAll<HTMLElement>('[data-type="item"]'));
      const sourceRow = rows.find((r) => {
        const path = (r.dataset.itemPath ?? '').replace(/\/$/, '').replace(/\.(md|mdx)$/i, '');
        const rowIsFolder = r.dataset.itemType === 'folder';
        return rowIsFolder === isFolder && path === sourcePath;
      });
      const scroll = shadow.querySelector<HTMLElement>('[data-file-tree-virtualized-scroll]');
      if (!sourceRow || !scroll) {
        return {
          ok: false as const,
          reason: 'missing-elements',
          paths: rows.map((r) => `${r.dataset.itemPath}|${r.dataset.itemType}`),
        };
      }

      const dataTransfer = new DataTransfer();
      const fire = (el: Element, type: string, extra: DragEventInit = {}) =>
        el.dispatchEvent(
          new DragEvent(type, {
            bubbles: true,
            cancelable: true,
            composed: true,
            dataTransfer,
            ...extra,
          }),
        );

      const rect = scroll.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.bottom - 4;
      (window as unknown as { __dndState: unknown }).__dndState = {
        dataTransfer,
        sourceRow,
        scroll,
        x,
        y,
        fire,
      };

      fire(sourceRow, 'dragstart', { clientX: 0, clientY: 0 });
      fire(scroll, 'dragover', { clientX: x, clientY: y });
      return { ok: true as const };
    },
    { sourcePath, isFolder },
  );

  expect(setup.ok, `drag setup failed: ${JSON.stringify(setup)}`).toBe(true);

  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const host = document
            .querySelector('[data-slot="sidebar-container"]')
            ?.querySelector('file-tree-container');
          const shadow = (host as Element & { shadowRoot: ShadowRoot | null })?.shadowRoot;
          return !!shadow?.querySelector(
            '[data-file-tree-virtualized-root][data-file-tree-root-drag-target="true"]',
          );
        }),
      { timeout: 5_000 },
    )
    .toBe(true);

  await page.evaluate(() => {
    const state = (
      window as unknown as {
        __dndState: {
          sourceRow: Element;
          scroll: Element;
          x: number;
          y: number;
          fire: (el: Element, type: string, extra?: DragEventInit) => void;
        };
      }
    ).__dndState;
    state.fire(state.scroll, 'drop', { clientX: state.x, clientY: state.y });
    state.fire(state.sourceRow, 'dragend', { clientX: state.x, clientY: state.y });
  });
}

async function expectDocNames(
  page: Page,
  baseURL: string,
  { present, absent }: { present: string; absent: string },
): Promise<void> {
  await expect(async () => {
    const docs = await page.evaluate(async (url) => {
      const r = await fetch(`${url}/api/documents`);
      return r.ok ? await r.json() : null;
    }, baseURL);
    const names: string[] = (docs?.documents ?? [])
      .map((d: { docName?: string; path?: string }) => d.docName ?? d.path ?? '')
      .filter(Boolean);
    expect(names).toContain(present);
    expect(names).not.toContain(absent);
  }).toPass({ timeout: 15_000 });
}

test.describe('file-tree drag-to-root (PRD-7043)', () => {
  test.beforeEach(async ({ workerServer }) => {
    await resetContentToFixtureBaseline(workerServer.baseURL, workerServer.contentDir);
  });

  test('dropping a nested folder on empty tree space promotes it to the project root', async ({
    page,
    api,
    workerServer,
  }) => {
    await api.seedDocs([
      { name: 'parent/child/note', markdown: '# Note\n\nNested.\n' },
      { name: 'top', markdown: '# Top\n' },
    ]);

    await page.goto('/');
    const sidebar = page.locator('[data-slot="sidebar-container"]');
    const parentRow = sidebar.getByRole('treeitem', { name: 'parent', exact: true });
    await expect(parentRow).toBeVisible({ timeout: 20_000 });

    await parentRow.click();
    await expect(sidebar.getByRole('treeitem', { name: 'child', exact: true })).toBeVisible({
      timeout: 10_000,
    });

    await dragRowToEmptyRootArea(page, 'parent/child', true);

    await expectDocNames(page, workerServer.baseURL, {
      present: 'child/note',
      absent: 'parent/child/note',
    });

    await expect(sidebar.locator('[role="treeitem"][data-item-path="child/"]')).toBeVisible({
      timeout: 10_000,
    });
    await expect(sidebar.getByRole('treeitem', { name: 'child', exact: true })).toHaveCount(1, {
      timeout: 10_000,
    });
  });

  test('dropping a nested file on empty tree space promotes it to the project root', async ({
    page,
    api,
    workerServer,
  }) => {
    await api.seedDocs([
      { name: 'folder/note', markdown: '# Note\n\nNested file.\n' },
      { name: 'top', markdown: '# Top\n' },
    ]);

    await page.goto('/');
    const sidebar = page.locator('[data-slot="sidebar-container"]');
    const folderRow = sidebar.getByRole('treeitem', { name: 'folder', exact: true });
    await expect(folderRow).toBeVisible({ timeout: 20_000 });

    await folderRow.click();
    await expect(sidebar.getByRole('treeitem', { name: 'note.md', exact: true })).toBeVisible({
      timeout: 10_000,
    });

    await dragRowToEmptyRootArea(page, 'folder/note', false);

    await expectDocNames(page, workerServer.baseURL, { present: 'note', absent: 'folder/note' });

    await expect(sidebar.locator('[role="treeitem"][data-item-path="note.md"]')).toBeVisible({
      timeout: 10_000,
    });
    await expect(sidebar.getByRole('treeitem', { name: 'note.md', exact: true })).toHaveCount(1, {
      timeout: 10_000,
    });
  });
});

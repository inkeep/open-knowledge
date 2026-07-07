/**
 * drag-and-drop can promote a nested folder (or file) back to the
 * project root.
 *
 * The native HTML5 drag gesture is owned by `@pierre/trees` (third-party). Its
 * stock build only emits a `kind: 'root'` drop target when the pointer is over a
 * top-level file row, so a drop on the tree's empty content area (the natural
 * "send this to the top level" gesture) was a no-op. The repo patch teaches
 * `resolveDropTargetFromElement` to resolve the empty scroll area to a root
 * target, and tags the tree root with `data-file-tree-root-drag-target` so the
 * app can paint a drop affordance.
 *
 * Unlike `rename-consolidation.e2e.ts` (which verifies the move OUTCOME by
 * calling `/api/rename-path` directly), this test drives the real native DnD
 * event sequence through Pierre's React handlers so the patched gesture itself
 * is exercised end-to-end. The drop handler re-resolves its target from
 * `clientX/clientY` via `elementFromPoint`, so the drop is dispatched with real
 * coordinates over the empty area below the last row.
 *
 * Both item kinds are covered because `handleDropComplete` dispatches a distinct
 * `/api/rename-path` payload shape per kind (`folder` vs `file`).
 */
import type { Page } from '@playwright/test';
import { expect, resetContentToFixtureBaseline, test } from './_helpers';

/**
 * Drive the real native DnD sequence inside the tree's shadow root: drag the row
 * whose extension-less tree path is `sourcePath` onto the empty scroll area, and
 * assert the root drop affordance lights up on dragover. `isFolder` selects the
 * matching row (folder rows carry a trailing slash + `data-item-type="folder"`).
 *
 * The sequence is split around an affordance poll because React applies the
 * `data-file-tree-root-drag-target` attribute on its next render after the
 * library's synchronous `setDragTarget` — checking it inside the dispatch
 * evaluate would race that render.
 */
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
      // Stash the live drag state so the drop step reuses the same session +
      // DataTransfer after the affordance poll.
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

  // The patched library flags the tree root as the live drop target on
  // dragover; React applies the attribute on its next render.
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

  // Complete the drop over the empty area, reusing the stashed session.
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
  // The worker server is shared and `seedDocs`' `testReset()` only clears the
  // `test-doc` doc, so a root `note` / `child` promoted by an earlier run of
  // these tests — plus every other spec's docs — survives into the next run.
  // The leftover promotion target collides with this run's promotion, leaving
  // two same-named rows, and a tree filled past the viewport puts the drop
  // point (`rect.bottom - 4`) on a real row instead of the empty root area.
  // Start each test from the boot-seeded baseline.
  test.beforeEach(async ({ workerServer }) => {
    await resetContentToFixtureBaseline(workerServer.baseURL, workerServer.contentDir);
  });

  test('dropping a nested folder on empty tree space promotes it to the project root', async ({
    page,
    api,
    workerServer,
  }) => {
    // A two-level nest (`parent/child`) plus a root-level doc so the tree has
    // content. Promoting `parent/child` to root turns `parent/child/note` into
    // `child/note`.
    await api.seedDocs([
      { name: 'parent/child/note', markdown: '# Note\n\nNested.\n' },
      { name: 'top', markdown: '# Top\n' },
    ]);

    await page.goto('/');
    const sidebar = page.locator('[data-slot="sidebar-container"]');
    const parentRow = sidebar.getByRole('treeitem', { name: 'parent', exact: true });
    await expect(parentRow).toBeVisible({ timeout: 20_000 });

    // Expand `parent` so the `child` folder row mounts and is draggable.
    await parentRow.click();
    await expect(sidebar.getByRole('treeitem', { name: 'child', exact: true })).toBeVisible({
      timeout: 10_000,
    });

    await dragRowToEmptyRootArea(page, 'parent/child', true);

    // The promoted folder is now at the root: `child/note` exists and the old
    // `parent/child/note` is gone.
    await expectDocNames(page, workerServer.baseURL, {
      present: 'child/note',
      absent: 'parent/child/note',
    });

    // Sidebar reflects the promotion: the top-level `child` folder row appears
    // and the tree settles to a single `child` row. The stale `parent/child`
    // row and the promoted root `child` row both carry aria-label `child`, so a
    // `name: 'child'` treeitem locator strict-mode-matches both during the
    // post-promotion render window. Target the unique root path (folders carry a
    // trailing slash), then assert the name resolves to exactly one row.
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
    // A file one level deep so promoting it exercises the `kind: 'file'` branch
    // of handleDropComplete. `folder/note` → `note` at root.
    await api.seedDocs([
      { name: 'folder/note', markdown: '# Note\n\nNested file.\n' },
      { name: 'top', markdown: '# Top\n' },
    ]);

    await page.goto('/');
    const sidebar = page.locator('[data-slot="sidebar-container"]');
    const folderRow = sidebar.getByRole('treeitem', { name: 'folder', exact: true });
    await expect(folderRow).toBeVisible({ timeout: 20_000 });

    // Expand `folder` so the `note.md` file row mounts and is draggable.
    await folderRow.click();
    await expect(sidebar.getByRole('treeitem', { name: 'note.md', exact: true })).toBeVisible({
      timeout: 10_000,
    });

    await dragRowToEmptyRootArea(page, 'folder/note', false);

    // The promoted file is now at the root: `note` exists and `folder/note` is gone.
    await expectDocNames(page, workerServer.baseURL, { present: 'note', absent: 'folder/note' });

    // Assert the sidebar settles to the single promoted root row. The new root
    // row and the stale `folder/note.md` source row both carry aria-label
    // `note.md`, so while they coexist a `name: 'note.md'` treeitem locator
    // strict-mode-matches two elements and `.toBeVisible()` throws before it can
    // retry. Target the unique root path, then assert the name resolves to
    // exactly one row — `.toHaveCount(1)` polls through the 2->1 convergence
    // window (the stale source row clearing) instead of throwing on the 2-match.
    await expect(sidebar.locator('[role="treeitem"][data-item-path="note.md"]')).toBeVisible({
      timeout: 10_000,
    });
    await expect(sidebar.getByRole('treeitem', { name: 'note.md', exact: true })).toHaveCount(1, {
      timeout: 10_000,
    });
  });
});

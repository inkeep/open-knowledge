// Show .ok folders — the request-scoped `.ok` reveal with read-only posture.
// Flipping the toggle fetches the listing with `showOk=true` and renders the
// `.ok` rows (minus `worktrees/` and `local/`, which the server excludes at
// every depth); clicks land on sanctioned surfaces only — template files on
// the template editor, everything else on the read-only text viewer — and no
// `.ok` row exposes a mutate context action. The doc-open guard is
// visibility-independent: a direct hash to a raw `.ok` docName lands on the
// read-only viewer (never the editable / create-mode editor), whether or not
// the reveal is on. Mutation affordances stay dead even when a `.ok` row is
// the activated target: toolbar create falls back to the workspace root and
// keyboard delete opens no dialog.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from './_helpers';

function uniqueStamp(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

const sidebar = (page: Page) => page.locator('[data-slot="sidebar-container"]');
const fileRow = (page: Page, fileName: string) =>
  sidebar(page).getByRole('treeitem', { name: fileName, exact: true });
const folderRow = (page: Page, folderName: string) =>
  sidebar(page).getByRole('treeitem', { name: folderName, exact: true });
const treeScroller = (page: Page) => sidebar(page).locator('[data-file-tree-virtualized-scroll]');
const textViewer = (page: Page) => page.locator('[data-text-viewer]');

async function toggleShowOkFolders(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Tree view options' }).click();
  await page.getByTestId('tree-options-show-ok-folders').click();
}

test('toggle reveals .ok rows, routes clicks to sanctioned surfaces, and keeps rows mutate-free', async ({
  page,
  api,
  workerServer,
}) => {
  const stamp = uniqueStamp();
  const controlDoc = `ok-reveal-control-${stamp}`;
  const templateName = `greeting-${stamp}`;
  const rawDocBase = `notes-probe-${stamp}`;

  await api.createPage(`${controlDoc}.md`);
  const okDir = join(workerServer.contentDir, '.ok');
  mkdirSync(join(okDir, 'templates'), { recursive: true });
  mkdirSync(join(okDir, 'worktrees', 'checkout'), { recursive: true });
  mkdirSync(join(okDir, 'local'), { recursive: true });
  writeFileSync(join(okDir, 'templates', `${templateName}.md`), '# Greeting template\n', 'utf-8');
  writeFileSync(join(okDir, `${rawDocBase}.md`), `# Raw probe ${stamp}\n`, 'utf-8');
  writeFileSync(join(okDir, 'worktrees', 'checkout', 'README.md'), '# checkout\n', 'utf-8');

  await page.goto(`/#/${controlDoc}`);
  await fileRow(page, `${controlDoc}.md`).waitFor({ state: 'visible', timeout: 15_000 });

  // Default state: the reveal is off and no `.ok` row exists.
  await expect(folderRow(page, '.ok')).toHaveCount(0);

  await toggleShowOkFolders(page);
  await treeScroller(page).evaluate((el) => {
    el.scrollTop = 0;
  });
  await folderRow(page, '.ok').waitFor({ state: 'visible', timeout: 15_000 });

  // Expand `.ok`: templates + the raw doc appear; the server never lists
  // `worktrees/` or `local/` (excluded at every depth even while revealed).
  await folderRow(page, '.ok').click();
  await folderRow(page, 'templates').waitFor({ state: 'visible', timeout: 15_000 });
  await fileRow(page, `${rawDocBase}.md`).waitFor({ state: 'visible', timeout: 15_000 });
  await expect(folderRow(page, 'worktrees')).toHaveCount(0);
  await expect(folderRow(page, 'local')).toHaveCount(0);

  // No mutate context actions on .ok rows — folder first…
  await folderRow(page, 'templates').click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: /copy path/i })).toBeVisible({
    timeout: 5_000,
  });
  await expect(page.getByRole('menuitem', { name: /new file/i })).toHaveCount(0);
  await expect(page.getByRole('menuitem', { name: /rename/i })).toHaveCount(0);
  await expect(page.getByRole('menuitem', { name: /duplicate/i })).toHaveCount(0);
  await expect(page.getByRole('menuitem', { name: /^delete/i })).toHaveCount(0);
  await expect(page.getByRole('menuitem', { name: /hide/i })).toHaveCount(0);
  await page.keyboard.press('Escape');

  // …then a file row.
  await fileRow(page, `${rawDocBase}.md`).click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: /copy path/i })).toBeVisible({
    timeout: 5_000,
  });
  await expect(page.getByRole('menuitem', { name: /rename/i })).toHaveCount(0);
  await expect(page.getByRole('menuitem', { name: /duplicate/i })).toHaveCount(0);
  await expect(page.getByRole('menuitem', { name: /^delete/i })).toHaveCount(0);
  await expect(page.getByRole('menuitem', { name: /hide/i })).toHaveCount(0);
  await page.keyboard.press('Escape');

  // A raw `.ok` doc row opens the read-only text viewer, not an editor.
  // Read-only is enforced at the CodeMirror dispatch level (the DOM stays
  // contenteditable for selection/copy UX), so the honest check is
  // behavioral: typing changes nothing.
  await fileRow(page, `${rawDocBase}.md`).click();
  await expect(textViewer(page)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(`Raw probe ${stamp}`)).toBeVisible({ timeout: 15_000 });
  await page.locator('[data-text-viewer] .cm-content').click();
  await page.keyboard.type('MUTATION-ATTEMPT');
  await expect(page.getByText('MUTATION-ATTEMPT')).toHaveCount(0);
  await expect(page.getByText(`Raw probe ${stamp}`)).toBeVisible();

  // A template file row routes to the managed-artifact template editor.
  await folderRow(page, 'templates').click();
  await fileRow(page, `${templateName}.md`).waitFor({ state: 'visible', timeout: 15_000 });
  await fileRow(page, `${templateName}.md`).click();
  await expect
    .poll(async () => decodeURIComponent(await page.evaluate(() => window.location.hash)), {
      timeout: 15_000,
    })
    .toBe(`#/__template__/${templateName}`);

  // Restore the worker-shared default from the same popover; the `.ok` rows
  // retire with the flip.
  await toggleShowOkFolders(page);
  await expect(folderRow(page, '.ok')).toHaveCount(0, { timeout: 15_000 });
});

test('a direct hash to a raw .ok docName lands read-only — existing shows bytes, missing never offers create', async ({
  page,
  api,
  workerServer,
}) => {
  const stamp = uniqueStamp();
  const anchorDoc = `ok-guard-anchor-${stamp}`;
  const rawDocBase = `guard-probe-${stamp}`;

  await api.createPage(`${anchorDoc}.md`);
  mkdirSync(join(workerServer.contentDir, '.ok'), { recursive: true });
  writeFileSync(
    join(workerServer.contentDir, '.ok', `${rawDocBase}.md`),
    `# Guard probe ${stamp}\n`,
    'utf-8',
  );

  await page.goto(`/#/${anchorDoc}`);
  await fileRow(page, `${anchorDoc}.md`).waitFor({ state: 'visible', timeout: 15_000 });

  // Existing raw `.ok` file, reveal OFF (the guard is visibility-blind): the
  // bytes open in the read-only viewer, never an editable editor.
  await page.evaluate((docName) => {
    window.location.hash = `#/${docName}`;
  }, `.ok/${rawDocBase}`);
  await expect(textViewer(page)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(`Guard probe ${stamp}`)).toBeVisible({ timeout: 15_000 });
  // Behavioral read-only pin: CodeMirror rejects the write at dispatch level.
  await page.locator('[data-text-viewer] .cm-content').click();
  await page.keyboard.type('MUTATION-ATTEMPT');
  await expect(page.getByText('MUTATION-ATTEMPT')).toHaveCount(0);
  await expect(page.getByText(`Guard probe ${stamp}`)).toBeVisible();

  // Nonexistent `.ok` docName: the viewer's error pane is the non-create
  // missing surface — typing-to-create is never offered.
  await page.evaluate((docName) => {
    window.location.hash = `#/${docName}`;
  }, `.ok/ghost-${stamp}`);
  await expect(textViewer(page)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByPlaceholder('Start writing to create this page')).toHaveCount(0);
  await expect(page.getByText('Start writing to create this page')).toHaveCount(0);
});

test('an activated .ok folder row never becomes a mutation target — create falls back to root, keyboard delete no-ops', async ({
  page,
  api,
  workerServer,
}) => {
  const stamp = uniqueStamp();
  const anchorDoc = `ok-mutation-anchor-${stamp}`;
  const controlFolder = `ok-delete-control-${stamp}`;
  const createdDoc = `ok-create-fallback-${stamp}`;
  const probeDocBase = `activation-probe-${stamp}`;

  await api.createPage(`${anchorDoc}.md`);
  await api.createPage(`${controlFolder}/inside.md`);
  const okDir = join(workerServer.contentDir, '.ok');
  mkdirSync(okDir, { recursive: true });
  writeFileSync(join(okDir, `${probeDocBase}.md`), `# Activation probe ${stamp}\n`, 'utf-8');

  await page.goto(`/#/${anchorDoc}`);
  await fileRow(page, `${anchorDoc}.md`).waitFor({ state: 'visible', timeout: 15_000 });

  await toggleShowOkFolders(page);
  await treeScroller(page).evaluate((el) => {
    el.scrollTop = 0;
  });
  await folderRow(page, '.ok').waitFor({ state: 'visible', timeout: 15_000 });

  // Activate the revealed `.ok` folder row; the expansion (probe file
  // appearing) proves the click landed and `.ok` is the active folder.
  await folderRow(page, '.ok').click();
  await fileRow(page, `${probeDocBase}.md`).waitFor({ state: 'visible', timeout: 15_000 });

  // Toolbar New file with `.ok` active: the create target falls back to the
  // workspace root. The inline rename input opens against the auto-
  // incrementing default (`Untitled.md` if not taken, else `Untitled 2.md`).
  await page.getByRole('button', { name: 'New file', exact: true }).click();
  const renameInput = page.getByRole('textbox', { name: /rename Untitled/i });
  await expect(renameInput).toBeVisible({ timeout: 10_000 });
  await renameInput.fill(createdDoc);
  await renameInput.press('Enter');
  await fileRow(page, `${createdDoc}.md`).waitFor({ state: 'visible', timeout: 15_000 });

  // Disk is the authority: the doc landed at the root, never inside `.ok`.
  await expect
    .poll(() => existsSync(join(workerServer.contentDir, `${createdDoc}.md`)), {
      timeout: 15_000,
    })
    .toBe(true);
  expect(existsSync(join(okDir, `${createdDoc}.md`))).toBe(false);

  // Keyboard delete, positive control first: the same Delete key on a normal
  // folder row opens the confirm dialog — proving key routing and tree focus
  // work in this harness, so the `.ok` absence assertion below cannot pass
  // vacuously. The tree's keydown handler requires focus inside the tree
  // host, and a click alone doesn't guarantee it — focus the row explicitly
  // (same pattern as file-tree-create's select-all helper). Escape cancels
  // without deleting.
  // The tree is virtualized with sticky ancestor headers: a folder row
  // scrolled past the viewport top leaves the DOM entirely (its sticky
  // stand-in renders as a button, not a treeitem), so re-locating a
  // top-sorted folder row after interactions that scrolled the tree (the
  // created-doc reveal above) requires parking the scroll back at the top
  // first — same idiom as the post-toggle reveal earlier in this test.
  await treeScroller(page).evaluate((el) => {
    el.scrollTop = 0;
  });
  const controlRow = folderRow(page, controlFolder);
  await controlRow.waitFor({ state: 'visible', timeout: 15_000 });
  await controlRow.click();
  await controlRow.focus();
  await expect(controlRow).toBeFocused();
  await page.keyboard.press('Delete');
  await expect(page.getByRole('dialog')).toBeVisible({ timeout: 10_000 });
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);

  // The same key on the selected-and-focused `.ok` row: no dialog opens, and
  // the folder (with its probe file) stays on disk.
  // Park the scroll again before re-locating `.ok` (top-sorted; the control
  // row interactions above may have scrolled it out of the virtualized DOM).
  await treeScroller(page).evaluate((el) => {
    el.scrollTop = 0;
  });
  const okRow = folderRow(page, '.ok');
  await okRow.waitFor({ state: 'visible', timeout: 15_000 });
  await okRow.click();
  await okRow.focus();
  await expect(okRow).toBeFocused();
  await page.keyboard.press('Delete');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(okRow).toBeVisible();
  expect(existsSync(join(okDir, `${probeDocBase}.md`))).toBe(true);

  // Restore the worker-shared default from the same popover.
  await toggleShowOkFolders(page);
  await expect(folderRow(page, '.ok')).toHaveCount(0, { timeout: 15_000 });
});

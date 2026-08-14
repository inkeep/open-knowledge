/**
 * A comment is read in the doc panel, never over the document.
 *
 * Clicking a highlighted passage (or its margin icon) used to float the thread
 * up as a card pinned to the text, Google-Docs style. It covered the paragraphs
 * around the passage — the ones you need in order to judge the comment — and
 * printed the same comment twice, since the panel was showing it as well.
 *
 * This is the tier that can tell those two apart: the card portalled to
 * `document.body`, so no unit test of either surface sees the doubling. What
 * this pins is the whole user-visible contract — one copy of the comment, and
 * that copy inside the Comments tab.
 *
 * Requires: Playwright browsers installed. Server provided per-worker by the
 * `workerServer` fixture in `_helpers/fixtures.ts`.
 */

import { expect, test, waitForActiveProviderSynced } from './_helpers';

const PASSAGE = 'toast the pepitas';
const SEED = `Warm the bowl, then ${PASSAGE} until they pop.\n\nServe with the dressing on the side.`;
const COMMENT = 'Toast or roast? Say which.';

/** The comment body, wherever in the page it is rendered. */
const commentBodies = '[data-testid="thread-comment-body"]';

test('clicking a commented passage shows the comment in the panel, not over the doc', async ({
  page,
  api,
}) => {
  const docName = `comment-in-panel-${Date.now()}`;
  await api.seedDocs([{ name: docName, markdown: SEED }]);

  const created = await page.request.post('/api/comments', {
    data: { docName, quote: PASSAGE, body: COMMENT },
  });
  expect(created.ok()).toBe(true);

  await page.goto(`/#/${docName}`);
  await waitForActiveProviderSynced(page);

  const editor = page.locator('.tiptap-editor .ProseMirror').first();
  await expect(editor).toContainText('Warm the bowl');

  // The highlight the thread anchors to — the thing a reader clicks.
  const highlight = editor.locator('[data-comment-thread]').first();
  await expect(highlight).toBeVisible();
  // Nothing is showing the comment yet: the panel opens on the click, and this
  // is what makes the assertions below about THIS click.
  await expect(page.locator(commentBodies)).toHaveCount(0);

  await highlight.click();

  // The Comments tab came up on its own — a collapsed rail expands, and a rail
  // on another tab switches.
  const panel = page.locator('#panel-comments');
  await expect(panel.locator(commentBodies)).toHaveText(COMMENT);

  // Exactly one copy in the whole page. A card floating over the passage lives
  // outside this panel (it portals to `document.body`), so it would show up
  // here as a second body even though the panel assertion above passed.
  await expect(page.locator(commentBodies)).toHaveCount(1);
});

test('clicking unrelated text stands the comment down again', async ({ page, api }) => {
  const docName = `comment-stand-down-${Date.now()}`;
  await api.seedDocs([{ name: docName, markdown: SEED }]);

  const created = await page.request.post('/api/comments', {
    data: { docName, quote: PASSAGE, body: COMMENT },
  });
  expect(created.ok()).toBe(true);

  await page.goto(`/#/${docName}`);
  await waitForActiveProviderSynced(page);

  const editor = page.locator('.tiptap-editor .ProseMirror').first();
  await expect(editor).toContainText('Warm the bowl');

  // The rail marker's own label is the state, in the vocabulary a screen reader
  // gets: "Close comment" while this thread is the open one, "Open comment"
  // when it is not. Truer than a CSS class, and it moves with the same signal
  // the passage highlight and the panel card's wash read.
  const marker = page.getByRole('button', { name: 'Open comment', exact: true });
  const litMarker = page.getByRole('button', { name: 'Close comment', exact: true });

  await editor.locator('[data-comment-thread]').first().click();
  await expect(litMarker).toBeVisible();

  // Click a paragraph that carries no comment — the reader has moved on.
  await editor.getByText('Serve with the dressing').click();

  await expect(marker).toBeVisible();
  await expect(litMarker).toHaveCount(0);
  // The panel keeps the comment listed. Standing down from one comment says
  // nothing about the panel the reader opened.
  await expect(page.locator('#panel-comments').locator(commentBodies)).toHaveText(COMMENT);
});

test('Escape stands the comment down from inside the panel', async ({ page, api }) => {
  const docName = `comment-escape-${Date.now()}`;
  await api.seedDocs([{ name: docName, markdown: SEED }]);

  const created = await page.request.post('/api/comments', {
    data: { docName, quote: PASSAGE, body: COMMENT },
  });
  expect(created.ok()).toBe(true);

  await page.goto(`/#/${docName}`);
  await waitForActiveProviderSynced(page);

  const editor = page.locator('.tiptap-editor .ProseMirror').first();
  await expect(editor).toContainText('Warm the bowl');
  await editor.locator('[data-comment-thread]').first().click();

  const litMarker = page.getByRole('button', { name: 'Close comment', exact: true });
  await expect(litMarker).toBeVisible();

  // Focus inside the card, the way a keyboard reader arrives at it — the panel
  // is a sibling rail, not a descendant of the editor, so this is the position
  // an editor-scoped key handler cannot serve.
  await page
    .locator('#panel-comments')
    .getByRole('button', { name: /edit this comment/i })
    .focus();
  await page.keyboard.press('Escape');

  await expect(page.getByRole('button', { name: 'Open comment', exact: true })).toBeVisible();
  await expect(litMarker).toHaveCount(0);
});

test('the margin icon opens the same comment in the same place', async ({ page, api }) => {
  const docName = `comment-in-panel-rail-${Date.now()}`;
  await api.seedDocs([{ name: docName, markdown: SEED }]);

  const created = await page.request.post('/api/comments', {
    data: { docName, quote: PASSAGE, body: COMMENT },
  });
  expect(created.ok()).toBe(true);

  await page.goto(`/#/${docName}`);
  await waitForActiveProviderSynced(page);
  await expect(page.locator('.tiptap-editor .ProseMirror').first()).toContainText('Warm the bowl');

  // The rail marker sits beside the line it is anchored to, outside the editor.
  // `exact`, because the editor's own tab strip carries an "Open …" / "Close
  // <file>.md" pair that a substring match sweeps up with it.
  await page.getByRole('button', { name: 'Open comment', exact: true }).click();

  await expect(page.locator('#panel-comments').locator(commentBodies)).toHaveText(COMMENT);
  await expect(page.locator(commentBodies)).toHaveCount(1);

  // Clicking the lit marker again stands the comment down without closing the
  // panel — the reader opened that, and the second click is about the comment.
  await page.getByRole('button', { name: 'Close comment', exact: true }).click();
  await expect(page.locator('#panel-comments').locator(commentBodies)).toHaveText(COMMENT);
});

test('the margin icon is still lit for the open comment after leaving and returning', async ({
  page,
  api,
}) => {
  // The rail is remounted on every visit to a document, and which thread is
  // open outlives that mount. A rail that learned the answer only from the next
  // signal came back unlit — and, worse, backwards: its close/open toggle reads
  // the same value, so the first click on the marker for the comment already
  // open re-opened it instead of standing it down.
  const docName = `comment-rail-remount-${Date.now()}`;
  const other = `comment-rail-elsewhere-${Date.now()}`;
  await api.seedDocs([
    { name: docName, markdown: SEED },
    { name: other, markdown: 'Somewhere else entirely.' },
  ]);

  const created = await page.request.post('/api/comments', {
    data: { docName, quote: PASSAGE, body: COMMENT },
  });
  expect(created.ok()).toBe(true);

  await page.goto(`/#/${docName}`);
  await waitForActiveProviderSynced(page);
  await expect(page.locator('.tiptap-editor .ProseMirror').first()).toContainText('Warm the bowl');

  await page.getByRole('button', { name: 'Open comment', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Close comment', exact: true })).toBeVisible();

  // Away, then back — the round trip that rebuilds the rail from scratch.
  await page.goto(`/#/${other}`);
  await expect(page.locator('.tiptap-editor .ProseMirror').first()).toContainText(
    'Somewhere else entirely',
  );
  await page.goto(`/#/${docName}`);
  await waitForActiveProviderSynced(page);
  await expect(page.locator('.tiptap-editor .ProseMirror').first()).toContainText('Warm the bowl');

  // Lit for the comment that is still open, so the next click closes it.
  const litMarker = page.getByRole('button', { name: 'Close comment', exact: true });
  await expect(litMarker).toBeVisible();
  await litMarker.click();
  await expect(page.getByRole('button', { name: 'Open comment', exact: true })).toBeVisible();
});

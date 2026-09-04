import { expect, test, waitForActiveProviderSynced } from './_helpers';

const PASSAGE = 'toast the pepitas';
const SEED = `Warm the bowl, then ${PASSAGE} until they pop.\n\nServe with the dressing on the side.`;
const COMMENT = 'Toast or roast? Say which.';

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

  const highlight = editor.locator('[data-comment-thread]').first();
  await expect(highlight).toBeVisible();
  await expect(page.locator(commentBodies)).toHaveCount(0);

  await highlight.click();

  const panel = page.locator('#panel-comments');
  await expect(panel.locator(commentBodies)).toHaveText(COMMENT);

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

  const marker = page.getByRole('button', { name: 'Open comment', exact: true });
  const litMarker = page.getByRole('button', { name: 'Close comment', exact: true });

  await editor.locator('[data-comment-thread]').first().click();
  await expect(litMarker).toBeVisible();

  await editor.getByText('Serve with the dressing').click();

  await expect(marker).toBeVisible();
  await expect(litMarker).toHaveCount(0);
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

  await page.getByRole('button', { name: 'Open comment', exact: true }).click();

  await expect(page.locator('#panel-comments').locator(commentBodies)).toHaveText(COMMENT);
  await expect(page.locator(commentBodies)).toHaveCount(1);

  await page.getByRole('button', { name: 'Close comment', exact: true }).click();
  await expect(page.locator('#panel-comments').locator(commentBodies)).toHaveText(COMMENT);
});

test('the margin icon is still lit for the open comment after leaving and returning', async ({
  page,
  api,
}) => {
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

  await page.goto(`/#/${other}`);
  await expect(page.locator('.tiptap-editor .ProseMirror').first()).toContainText(
    'Somewhere else entirely',
  );
  await page.goto(`/#/${docName}`);
  await waitForActiveProviderSynced(page);
  await expect(page.locator('.tiptap-editor .ProseMirror').first()).toContainText('Warm the bowl');

  const litMarker = page.getByRole('button', { name: 'Close comment', exact: true });
  await expect(litMarker).toBeVisible();
  await litMarker.click();
  await expect(page.getByRole('button', { name: 'Open comment', exact: true })).toBeVisible();
});

import { randomUUID } from 'node:crypto';
import { acpCatalogBody, expect, test, waitForActiveProviderSynced } from './_helpers';
import { startHiddenChatAgent } from './hidden-chat-transport.test-helper';

const EDITOR_CARD = '[data-slot="pane-card"][data-pane="editor"]';
const CHAT_CARD = '[data-slot="pane-card"][data-pane="agents"]';
const THREAD_COMPOSER = '[data-testid="agent-thread-composer"]';

test.beforeEach(async ({ page }) => {
  await page.route('**/api/acp/catalog', (route) => route.fulfill({ json: acpCatalogBody([]) }));
});
test('hidden Chat retains a live draft and unread completed stream until the thread is viewed', async ({
  page,
  api,
  workerServer,
}) => {
  const docName = `hidden-chat-${randomUUID()}`;
  await api.seedDocs([{ name: docName, markdown: '# Hidden Chat activity\n' }]);
  const fixture = await startHiddenChatAgent(workerServer);
  try {
    await page.setViewportSize({ width: 767, height: 800 });
    await page.goto(`/#/${docName}`);
    await waitForActiveProviderSynced(page);

    const editorButton = page.getByTestId('header-pane-button-editor');
    const chatButton = page.getByTestId('header-pane-button-agents');
    const chatCard = page.locator(CHAT_CARD);
    await chatButton.click();
    await expect(chatCard).toBeVisible();
    const threadTab = chatCard.locator(`[role="tab"][data-tab-id="${fixture.threadId}"]`);
    await threadTab.click();
    const composer = chatCard.getByRole('textbox', { name: 'Message Hidden activity fixture' });
    const threadSurface = composer.locator('xpath=ancestor::*[@data-session-id][1]');
    await expect(composer).toBeVisible();
    await composer.click();
    await page.keyboard.insertText('Start the controlled response');
    await threadSurface.getByTestId('agent-thread-send').click();
    await expect(threadSurface.getByTestId('agent-thread-agent-message')).toContainText(
      'Streaming',
    );
    await expect(threadTab).toContainText('Working');

    await composer.click();
    await page.keyboard.insertText('Draft survives the stream');
    await expect(composer).toContainText('Draft survives the stream');
    const sessionId = await threadSurface.getAttribute('data-session-id');
    expect(sessionId).not.toBeNull();

    await threadSurface.getByTestId('agent-thread-add-to-prompt').click();
    const fileChooser = page.waitForEvent('filechooser');
    await page.getByRole('menuitem', { name: 'Attach files' }).click();
    await (await fileChooser).setFiles({
      name: 'staged-note.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('Pending Chat context'),
    });
    await expect(
      threadSurface.getByTestId('agent-thread-pending-images').getByTitle('staged-note.txt'),
    ).toBeVisible();

    await editorButton.click();
    await expect(page.locator(EDITOR_CARD)).toBeVisible();
    await expect(chatCard).toBeHidden();
    await expect(chatCard).toHaveAttribute('inert', '');
    fixture.release();
    await fixture.waitForFinalChunk();
    fixture.finish();
    await expect(threadTab).toContainText('new activity');

    await chatButton.click();
    await expect(chatCard).toBeVisible();
    await expect(threadSurface.getByTestId('agent-thread-agent-message')).toContainText(
      'Streaming and completed while hidden',
    );
    await expect(composer).toContainText('Draft survives the stream');
    await expect(
      threadSurface.getByTestId('agent-thread-pending-images').getByTitle('staged-note.txt'),
    ).toBeVisible();
    await expect(
      chatCard.locator(`[data-session-id="${sessionId}"] ${THREAD_COMPOSER}`),
    ).toBeVisible();
    await expect(threadTab).not.toContainText('new activity');

    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(chatCard).toBeHidden();
    await page.setViewportSize({ width: 767, height: 800 });
    await expect(chatCard).toBeVisible();
    await expect(composer).toContainText('Draft survives the stream');
  } finally {
    fixture.release();
    fixture.finish();
    await fixture.close();
  }
});

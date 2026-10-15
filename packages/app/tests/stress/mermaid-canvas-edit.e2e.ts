import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import { expect, test, waitForActiveProviderSynced } from './_helpers';

async function readDocumentContent(page: Page, docName: string): Promise<string> {
  const response = await page.request.get(`/api/document?docName=${encodeURIComponent(docName)}`);
  expect(response.ok()).toBe(true);
  const body: { content?: string } = await response.json();
  return body.content ?? '';
}

test('mermaid canvas renders a flowchart and Escape cancels an in-place label edit', async ({
  page,
  api,
}) => {
  const docName = `mermaid-${randomUUID().slice(0, 8)}`;
  await api.createPage(`${docName}.md`);
  await api.replaceDoc(
    docName,
    '# Diagram\n\n```mermaid\nflowchart TD\n  A[Start] --> B[Finish]\n```\n',
  );

  await page.goto(`/#/${docName}`);
  await waitForActiveProviderSynced(page, { timeout: 15_000 });

  const diagram = page.locator('[data-component-type="mermaid"].mermaid-ready');
  const startLabel = diagram.locator('.nodeLabel', { hasText: 'Start' });
  await expect(startLabel).toBeVisible();
  await expect(diagram.locator('.nodeLabel', { hasText: 'Finish' })).toBeVisible();

  await startLabel.dblclick();
  const editing = diagram.locator('[contenteditable="true"]');
  await expect(editing).toHaveText('Start');
  await page.keyboard.type('Cancelled');
  await expect(editing).toHaveText('Cancelled');
  await expect
    .poll(() => readDocumentContent(page, docName), { timeout: 10_000 })
    .toContain('Cancelled');
  await page.keyboard.press('Escape');

  await expect(editing).toHaveCount(0);
  await expect(startLabel).toHaveText('Start');
  await expect
    .poll(() => readDocumentContent(page, docName), { timeout: 10_000 })
    .not.toContain('Cancelled');
  expect(await readDocumentContent(page, docName)).toContain('A[Start] --> B[Finish]');
});

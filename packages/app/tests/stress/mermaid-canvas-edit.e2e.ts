import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import { type ApiHelpers, expect, test, waitForActiveProviderSynced } from './_helpers';

async function readDocumentContent(page: Page, docName: string): Promise<string> {
  const response = await page.request.get(`/api/document?docName=${encodeURIComponent(docName)}`);
  expect(response.ok()).toBe(true);
  const body: { content?: string } = await response.json();
  return body.content ?? '';
}

async function openDiagram(page: Page, api: ApiHelpers, docName: string, flowchart: string) {
  await api.createPage(`${docName}.md`);
  await api.replaceDoc(docName, `# Diagram\n\n\`\`\`mermaid\n${flowchart}\n\`\`\`\n`);
  await page.goto(`/#/${docName}`);
  await waitForActiveProviderSynced(page, { timeout: 15_000 });
  return page.locator('[data-component-type="mermaid"].mermaid-ready');
}

test('mermaid canvas renders a flowchart and Escape cancels an in-place label edit', async ({
  page,
  api,
}) => {
  const docName = `mermaid-${randomUUID().slice(0, 8)}`;
  const diagram = await openDiagram(page, api, docName, 'flowchart TD\n  A[Start] --> B[Finish]');
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

test('Escape restores a formatted label exactly as mermaid rendered it', async ({ page, api }) => {
  const diagram = await openDiagram(
    page,
    api,
    `mermaid-formatted-${randomUUID().slice(0, 8)}`,
    'flowchart TD\n  A["`**bold** text`"] --> B[Finish]',
  );
  const label = diagram.locator('.nodeLabel', { hasText: 'bold text' });
  await expect(label.locator('strong')).toHaveText('bold');

  await label.dblclick();
  await expect(diagram.locator('[contenteditable="true"]')).toHaveCount(1);
  await page.keyboard.press('Escape');

  await expect(diagram.locator('[contenteditable="true"]')).toHaveCount(0);
  await expect(label).toHaveText('bold text');
  await expect(label.locator('strong')).toHaveText('bold');
});

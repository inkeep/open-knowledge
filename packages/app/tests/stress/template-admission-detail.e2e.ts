import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripFrontmatter } from '@inkeep/open-knowledge-core';
import { expect, test } from './_helpers';

test('template creation shows actionable admission detail and accepts explicit printable repair', async ({
  page,
  workerServer,
}, testInfo) => {
  const name = `admission-${randomUUID()}`;
  const path = join(workerServer.contentDir, '.ok', 'templates', `${name}.md`);
  const unsafe = 'x😀\u0000private-tail\n';
  const cleaned = 'x😀\\u0000private-tail\n';
  await page.goto('/#settings');
  await page.getByTestId('settings-sidebar-item-project-templates').click();
  await page.getByTestId('settings-project-templates-new-button').click();
  const dialog = page.getByRole('dialog', { name: 'New template' });
  await dialog.getByTestId('template-name-input').fill(name);
  await dialog.getByLabel('Starter content', { exact: true }).fill(unsafe);
  const refused = page.waitForResponse(
    (response) => response.url().endsWith('/api/template') && response.request().method() === 'PUT',
  );
  await dialog.getByRole('button', { name: 'Create template', exact: true }).click();
  const response = await refused;
  expect(response.status()).toBe(400);
  const problem = await response.json();
  expect(problem.detail).toContain('U+0000');
  expect(problem.detail).toMatch(/offset\D*3\b/);
  const toast = page.locator('[data-sonner-toast]').filter({ hasText: 'U+0000' });
  await expect(toast).toBeVisible();
  await expect(toast).toHaveCSS('opacity', '1');
  await expect(toast).toContainText(problem.detail);
  await expect(toast).not.toContainText('private-tail');
  await expect(dialog).toBeVisible();
  expect(existsSync(path)).toBe(false);
  await testInfo.attach('Actionable template refusal', {
    body: await toast.screenshot({ animations: 'disabled' }),
    contentType: 'image/png',
  });
  await toast.getByRole('button', { name: 'Close toast' }).click();
  await expect(toast).not.toBeVisible();
  await dialog.getByLabel('Starter content', { exact: true }).fill(cleaned);
  const accepted = page.waitForResponse(
    (candidate) =>
      candidate.url().endsWith('/api/template') && candidate.request().method() === 'PUT',
  );
  await dialog.getByRole('button', { name: 'Create template', exact: true }).click();
  expect((await accepted).status()).toBe(200);
  await expect(dialog).not.toBeVisible();
  expect(stripFrontmatter(readFileSync(path, 'utf8')).body).toBe(cleaned);
});

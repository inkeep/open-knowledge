/**
 * Browser coverage for the OKF recommendation's complete install path.
 *
 * The dedicated worker owns its skill roots because the test authors a real
 * project skill. Reloading after installation drops the card's optimistic state,
 * proving the server's skills listing recognizes what the install endpoint wrote.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from './_helpers';

test.use({
  workerServerEnv: { OK_TEST_OKF_RECOMMENDED_SKILL: 'isolated-content-v1' },
});

async function openOkfSettings(page: Page): Promise<void> {
  await page.goto('/#settings/plugins-manage');
  await expect(page.getByTestId('settings-plugins-manage')).toBeVisible({ timeout: 30_000 });

  const okfToggle = page.getByTestId('settings-plugin-toggle-okf');
  await expect(okfToggle).toBeVisible();
  if ((await okfToggle.getAttribute('aria-checked')) !== 'true') await okfToggle.click();
  await expect(okfToggle).toHaveAttribute('aria-checked', 'true');

  await page.goto('/#settings/plugin:okf');
  await expect(page.getByTestId('settings-plugin-okf')).toBeVisible({ timeout: 30_000 });
}

test('installs the recommended skill through the real endpoint and recognizes it after reload', async ({
  page,
  workerServer,
}) => {
  const platformSkillDir = join(workerServer.contentDir, '.claude', 'skills', 'open-knowledge');
  mkdirSync(platformSkillDir, { recursive: true });
  writeFileSync(
    join(platformSkillDir, 'SKILL.md'),
    '---\nname: open-knowledge\ndescription: project skill\n---\n',
    'utf-8',
  );

  await openOkfSettings(page);
  const card = page.getByTestId('settings-okf-recommended-skill');
  await expect(card).toBeVisible();
  await card.getByRole('button', { name: 'Install skill' }).click();

  const dialog = page.getByRole('dialog', { name: 'Install from OKF' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('Project');
  await expect(dialog).toContainText('okf-knowledge-base');
  await dialog.getByRole('button', { name: 'Install selected' }).click();

  const installedSkill = join(
    workerServer.contentDir,
    '.claude',
    'skills',
    'okf-knowledge-base',
    'SKILL.md',
  );
  await expect.poll(() => existsSync(installedSkill), { timeout: 15_000 }).toBe(true);
  expect(readFileSync(installedSkill, 'utf-8')).toContain('name: okf-knowledge-base');
  await expect(card).toContainText('Installed');

  await page.reload();
  await expect(page.getByTestId('settings-plugin-okf')).toBeVisible({ timeout: 30_000 });
  const reloadedCard = page.getByTestId('settings-okf-recommended-skill');
  await expect(reloadedCard).toContainText('Installed');
  await expect(reloadedCard.getByRole('button', { name: 'Open skill' })).toBeVisible();
  await expect(reloadedCard.getByRole('button', { name: 'Install skill' })).toHaveCount(0);
});

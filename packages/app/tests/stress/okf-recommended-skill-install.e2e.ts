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
import {
  expect,
  openProjectPluginsPanel,
  openSettingsSection,
  setPluginEnabled,
  test,
  waitForSettingsPanel,
} from './_helpers';

test.use({
  workerServerEnv: { OK_TEST_OKF_RECOMMENDED_SKILL: 'isolated-content-v1' },
});

async function openOkfSettings(page: Page): Promise<void> {
  await openProjectPluginsPanel(page);
  await setPluginEnabled(page, 'okf', true);
  await openSettingsSection(page, 'plugin:okf', 'settings-plugin-okf');
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
  await waitForSettingsPanel(page, 'settings-plugin-okf');
  const reloadedCard = page.getByTestId('settings-okf-recommended-skill');
  await expect(reloadedCard).toContainText('Installed');
  await expect(reloadedCard.getByRole('button', { name: 'Open skill' })).toBeVisible();
  await expect(reloadedCard.getByRole('button', { name: 'Install skill' })).toHaveCount(0);
});

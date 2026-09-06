import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { parse } from 'yaml';
import {
  expect,
  openProjectPluginsPanel,
  openSettingsSection,
  setPluginEnabled,
  test,
} from './_helpers';

test.use({
  workerServerEnv: { OK_TEST_OKF_GENERATED_INDEX_SETTINGS: 'isolated-content-v1' },
});

type OkfProjectConfig = {
  contentRules?: {
    okf?: {
      enabled?: boolean;
      generate?: { index?: boolean };
    };
  };
};

function readProjectConfig(configPath: string): OkfProjectConfig {
  if (!existsSync(configPath)) return {};
  return parse(readFileSync(configPath, 'utf-8')) as OkfProjectConfig;
}

async function openOkfSettings(page: Page): Promise<void> {
  await openProjectPluginsPanel(page);
  await setPluginEnabled(page, 'okf', true);
  await openSettingsSection(page, 'plugin:okf', 'settings-plugin-okf');
}

async function expectDisclosureContrast(page: Page, theme: 'light' | 'dark'): Promise<void> {
  await page.evaluate((nextTheme) => {
    const transitionBlocker = document.createElement('style');
    transitionBlocker.id = 'ok-test-disable-disclosure-transitions';
    transitionBlocker.textContent = `
      [data-testid="settings-okf-generate-index-confirm"],
      [data-testid="settings-okf-generate-index-confirm"]::before,
      [data-testid="settings-okf-generate-index-confirm"]::after,
      [data-testid="settings-okf-generate-index-confirm"] *,
      [data-testid="settings-okf-generate-index-confirm"] *::before,
      [data-testid="settings-okf-generate-index-confirm"] *::after {
        transition: none !important;
      }
    `;
    document.head.append(transitionBlocker);
    void document.body.offsetHeight;

    document.documentElement.removeAttribute('data-color-theme');
    document.getElementById('ok-custom-theme')?.remove();
    document.documentElement.classList.toggle('dark', nextTheme === 'dark');
    void document.body.offsetHeight;
  }, theme);

  try {
    const results = await new AxeBuilder({ page })
      .include('[data-testid="settings-okf-generate-index-confirm"]')
      .withRules(['color-contrast'])
      .analyze();

    expect(results.violations).toEqual([]);
  } finally {
    await page.evaluate(() => {
      document.getElementById('ok-test-disable-disclosure-transitions')?.remove();
    });
  }
}

test('Escape decline restores focus, confirmation creates indexes, and disabling preserves them', async ({
  page,
  api,
  workerServer,
}) => {
  execFileSync('git', ['init', '-q'], { cwd: workerServer.contentDir });
  await api.seedDocs([
    {
      name: 'home',
      markdown: '---\ntitle: Home\ntype: note\n---\n\n# Home\n',
    },
    {
      name: 'guides/intro',
      markdown: '---\ntitle: Intro\ntype: guide\n---\n\n# Intro\n',
    },
  ]);

  const configPath = join(workerServer.contentDir, '.ok', 'config.yml');
  const rootIndexPath = join(workerServer.contentDir, 'index.md');
  const nestedIndexPath = join(workerServer.contentDir, 'guides', 'index.md');
  const attributesPath = join(workerServer.contentDir, '.gitattributes');

  await openOkfSettings(page);
  await expect.poll(() => readProjectConfig(configPath).contentRules?.okf?.enabled).toBe(true);

  const configBeforeDisclosure = readFileSync(configPath, 'utf-8');
  const generateToggle = page.getByTestId('settings-okf-generate-index');
  await expect(generateToggle).toHaveAttribute('aria-checked', 'false');

  await generateToggle.press('Space');
  const disclosure = page.getByRole('dialog', {
    name: 'Maintain generated indexes in every folder?',
  });
  await expect(disclosure).toBeVisible();
  await expect(disclosure).toContainText('index.md');
  await expect(disclosure).toContainText('every folder');
  await expectDisclosureContrast(page, 'light');
  await expectDisclosureContrast(page, 'dark');
  await page.evaluate(() => {
    document.documentElement.classList.remove('dark');
  });

  expect(readFileSync(configPath, 'utf-8')).toBe(configBeforeDisclosure);
  expect(existsSync(rootIndexPath)).toBe(false);
  expect(existsSync(nestedIndexPath)).toBe(false);

  await expect(disclosure).toContainText('.gitattributes');
  const cancelButton = disclosure.getByRole('button', { name: 'Cancel' });
  const confirmButton = disclosure.getByRole('button', { name: 'Enable indexes' });
  await expect(confirmButton).toHaveCSS('text-transform', 'uppercase');
  await expect(cancelButton).toHaveCSS('text-transform', 'uppercase');
  await expect(cancelButton).toHaveCSS('font-family', /JetBrains Mono/);
  const dialogBox = await disclosure.boundingBox();
  expect(dialogBox).not.toBeNull();
  for (const button of [cancelButton, confirmButton]) {
    const buttonBox = await button.boundingBox();
    expect(buttonBox).not.toBeNull();
    expect(buttonBox?.x ?? -1).toBeGreaterThanOrEqual(dialogBox?.x ?? 0);
    expect((buttonBox?.x ?? 0) + (buttonBox?.width ?? 0)).toBeLessThanOrEqual(
      (dialogBox?.x ?? 0) + (dialogBox?.width ?? 0),
    );
  }
  await cancelButton.press('Tab');
  await expect(confirmButton).toBeFocused();
  await confirmButton.press('Escape');
  await expect(disclosure).toBeHidden();
  await expect(generateToggle).toBeFocused();
  await expect(generateToggle).toHaveAttribute('aria-checked', 'false');
  expect(readFileSync(configPath, 'utf-8')).toBe(configBeforeDisclosure);
  expect(existsSync(rootIndexPath)).toBe(false);
  expect(existsSync(nestedIndexPath)).toBe(false);
  expect(existsSync(attributesPath)).toBe(false);

  await generateToggle.click();
  await disclosure.getByRole('button', { name: 'Enable indexes' }).click();
  await expect(generateToggle).toHaveAttribute('aria-checked', 'true');
  await expect
    .poll(() => readProjectConfig(configPath).contentRules?.okf?.generate?.index, {
      timeout: 15_000,
    })
    .toBe(true);
  await expect
    .poll(
      () => ({
        root: existsSync(rootIndexPath),
        nested: existsSync(nestedIndexPath),
      }),
      { timeout: 20_000 },
    )
    .toEqual({ root: true, nested: true });

  expect(readFileSync(rootIndexPath, 'utf-8')).toContain('./guides/index.md');
  expect(readFileSync(nestedIndexPath, 'utf-8')).toContain('./intro.md');
  expect(readFileSync(attributesPath, 'utf-8')).toContain('/**/index.md merge=union');

  const generatedFiles = [rootIndexPath, nestedIndexPath].map((path) => ({
    path,
    bytes: readFileSync(path),
    mtimeMs: statSync(path).mtimeMs,
  }));

  await generateToggle.click();
  await expect(generateToggle).toHaveAttribute('aria-checked', 'false');
  await expect
    .poll(() => readProjectConfig(configPath).contentRules?.okf?.generate?.index, {
      timeout: 15_000,
    })
    .toBe(false);

  for (const snapshot of generatedFiles) {
    expect(existsSync(snapshot.path)).toBe(true);
    expect(readFileSync(snapshot.path)).toEqual(snapshot.bytes);
    expect(statSync(snapshot.path).mtimeMs).toBe(snapshot.mtimeMs);
  }

  expect(existsSync(attributesPath)).toBe(false);

  writeFileSync(attributesPath, 'index.md merge=ours\n', 'utf-8');
  await generateToggle.click();
  await disclosure.getByRole('button', { name: 'Enable indexes' }).click();
  await expect(generateToggle).toHaveAttribute('aria-checked', 'false');
  await expect(page.getByTestId('settings-okf-generate-index-status')).toContainText(
    'another Git attribute controls index.md',
  );
  expect(readProjectConfig(configPath).contentRules?.okf?.generate?.index).toBe(false);
  expect(readFileSync(attributesPath, 'utf-8')).toBe('index.md merge=ours\n');
});

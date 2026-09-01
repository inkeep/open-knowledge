import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from './_helpers';

function assetHash(assetPath: string): string {
  return `/#/__asset__/${assetPath.split('/').map(encodeURIComponent).join('/')}`;
}

const configEditor = (page: Page) => page.locator('[data-lint-config-editor]');
const rulesSegment = (page: Page) =>
  configEditor(page).getByRole('radio', { name: 'Rules', exact: true });
const sourceSegment = (page: Page) =>
  configEditor(page).getByRole('radio', { name: 'Source', exact: true });
const loadedSource = (page: Page) =>
  configEditor(page).locator('[data-text-viewer][data-text-viewer-state="loaded"]');
const ruleBrowser = (page: Page) =>
  page.locator('[data-testid="settings-linting-markdownlint-rules"]');

const CLEANUP_PATHS = [
  '.markdownlint.json',
  '.markdownlint.jsonc',
  'base.json',
  'docs/.markdownlint.json',
  'lint-cfg-package.json',
] as const;

function cleanupConfigs(contentDir: string): void {
  for (const rel of CLEANUP_PATHS) {
    rmSync(join(contentDir, rel), { force: true });
  }
}

test.describe('lint-config Source/Rules toggle — running-app E2E (PRD-7378)', () => {
  test.afterEach(({ workerServer }) => {
    cleanupConfigs(workerServer.contentDir);
  });

  test('root .markdownlint.json opens with a Source/Rules toggle, Source default, byte-faithful', async ({
    page,
    workerServer,
  }) => {
    const assetPath = '.markdownlint.json';
    const fileBytes = '{\n   "MD013": false,\n   "MD033": false\n}\n';
    writeFileSync(join(workerServer.contentDir, assetPath), fileBytes, 'utf-8');

    await page.goto(assetHash(assetPath));

    await expect(configEditor(page)).toBeVisible({ timeout: 15_000 });

    await expect(sourceSegment(page)).toBeVisible();
    await expect(rulesSegment(page)).toBeVisible();
    await expect(loadedSource(page)).toBeVisible({ timeout: 15_000 });
    await expect(ruleBrowser(page)).toHaveCount(0);

    const served = await page.request.get(`/api/asset-text?path=${encodeURIComponent(assetPath)}`);
    expect(served.status()).toBe(200);
    const servedText = await served.text();
    const diskText = readFileSync(join(workerServer.contentDir, assetPath), 'utf-8');
    expect(servedText).toBe(diskText);
    expect(servedText).toBe(fileBytes);
  });

  test('toggling a rule in Rules writes to disk, Source reflects it, and the preference persists', async ({
    page,
    api,
    workerServer,
  }) => {
    const assetPath = '.markdownlint.json';
    writeFileSync(join(workerServer.contentDir, assetPath), '{\n  "MD013": false\n}\n', 'utf-8');

    await page.goto(assetHash(assetPath));
    await expect(configEditor(page)).toBeVisible({ timeout: 15_000 });

    await expect(rulesSegment(page)).toBeEnabled({ timeout: 15_000 });
    await rulesSegment(page).click();

    await expect(ruleBrowser(page)).toBeVisible({ timeout: 15_000 });
    await expect(loadedSource(page)).toHaveCount(0);

    await page.locator('[data-testid="markdownlint-rule-search"]').fill('MD013');
    const md013Toggle = page.locator('[data-testid="markdownlint-rule-toggle-MD013"]');
    await expect(md013Toggle).toBeEnabled({ timeout: 15_000 });
    await md013Toggle.click();

    await expect
      .poll(
        () => {
          const raw = readFileSync(join(workerServer.contentDir, assetPath), 'utf-8');
          return JSON.parse(raw).MD013;
        },
        { timeout: 15_000, message: 'MD013 must be written to .markdownlint.json on disk' },
      )
      .toBe(true);

    await sourceSegment(page).click();
    await expect(loadedSource(page)).toBeVisible({ timeout: 15_000 });
    await expect(loadedSource(page).locator('.cm-content')).toContainText(/"MD013"\s*:\s*true/, {
      timeout: 15_000,
    });

    await sourceSegment(page).click();
    await rulesSegment(page).click();
    await expect(ruleBrowser(page)).toBeVisible({ timeout: 15_000 });

    await api.createPage('lint-cfg-away.md');
    await page.goto(`/#/lint-cfg-away`);
    await page.waitForSelector('.ProseMirror:not(.composer-prosemirror)', { timeout: 15_000 });

    await page.goto(assetHash(assetPath));
    await expect(configEditor(page)).toBeVisible({ timeout: 15_000 });
    await expect(ruleBrowser(page)).toBeVisible({ timeout: 15_000 });
    await expect(loadedSource(page)).toHaveCount(0);
  });

  test('editing a .jsonc rule preserves comment, extends, trailing comma, and default:false', async ({
    page,
    workerServer,
  }) => {
    const assetPath = '.markdownlint.jsonc';
    writeFileSync(join(workerServer.contentDir, 'base.json'), '{}\n', 'utf-8');
    const jsoncBytes = [
      '// project markdownlint config',
      '{',
      '  "extends": "./base.json",',
      '  "default": false,',
      '  "MD013": false,',
      '  "MD033": false,',
      '}',
      '',
    ].join('\n');
    writeFileSync(join(workerServer.contentDir, assetPath), jsoncBytes, 'utf-8');

    await page.goto(assetHash(assetPath));
    await expect(configEditor(page)).toBeVisible({ timeout: 15_000 });

    await expect(loadedSource(page)).toHaveAttribute('data-text-viewer-extension', 'jsonc', {
      timeout: 15_000,
    });

    await expect(rulesSegment(page)).toBeEnabled({ timeout: 15_000 });
    await rulesSegment(page).click();
    await expect(ruleBrowser(page)).toBeVisible({ timeout: 15_000 });
    await page.locator('[data-testid="markdownlint-rule-search"]').fill('MD009');
    const md009Toggle = page.locator('[data-testid="markdownlint-rule-toggle-MD009"]');
    await expect(md009Toggle).toBeEnabled({ timeout: 15_000 });
    await md009Toggle.click();

    await expect
      .poll(() => readFileSync(join(workerServer.contentDir, assetPath), 'utf-8'), {
        timeout: 15_000,
        message: 'the MD009 write must land in .markdownlint.jsonc',
      })
      .toContain('MD009');
    const roundTripped = readFileSync(join(workerServer.contentDir, assetPath), 'utf-8');
    expect(roundTripped).toContain('// project markdownlint config');
    expect(roundTripped).toContain('"extends": "./base.json"');
    expect(roundTripped).toContain('"default": false');
    expect(roundTripped).toMatch(/"MD033":\s*false,/);
  });

  test('a nested docs/.markdownlint.json disables Rules with a tooltip while Source still works', async ({
    page,
    workerServer,
  }) => {
    writeFileSync(
      join(workerServer.contentDir, '.markdownlint.json'),
      '{\n  "MD013": false\n}\n',
      'utf-8',
    );
    mkdirSync(join(workerServer.contentDir, 'docs'), { recursive: true });
    const nestedPath = 'docs/.markdownlint.json';
    writeFileSync(join(workerServer.contentDir, nestedPath), '{\n  "MD041": false\n}\n', 'utf-8');

    await page.goto(assetHash(nestedPath));
    await expect(configEditor(page)).toBeVisible({ timeout: 15_000 });

    await expect(loadedSource(page)).toBeVisible({ timeout: 15_000 });

    const rules = rulesSegment(page);
    await expect(rules).toHaveCount(1);
    await expect(rules).toBeDisabled({ timeout: 15_000 });
    const nestedCfg = await page.request.get('/api/lint/config');
    expect(nestedCfg.status()).toBe(200);
    expect((await nestedCfg.json()).configFile).not.toBe(nestedPath);
    await expect(rules).toBeDisabled();

    await rules.locator('xpath=..').hover();
    await expect(page.getByRole('tooltip')).toContainText(
      "Rule editing is available for the project's root markdownlint config",
      { timeout: 15_000 },
    );
  });

  test('a normal package.json opens in the plain read-only preview with no Source/Rules toggle', async ({
    page,
    workerServer,
  }) => {
    const assetPath = 'lint-cfg-package.json';
    writeFileSync(
      join(workerServer.contentDir, assetPath),
      '{\n  "name": "not-a-lint-config",\n  "version": "1.0.0"\n}\n',
      'utf-8',
    );

    await page.goto(assetHash(assetPath));

    const preview = page.locator('[data-text-viewer][data-text-viewer-state="loaded"]');
    await expect(preview).toBeVisible({ timeout: 15_000 });
    await expect(preview.locator('.cm-content')).toContainText('not-a-lint-config', {
      timeout: 15_000,
    });

    await expect(configEditor(page)).toHaveCount(0);
    await expect(page.getByRole('radio', { name: 'Rules', exact: true })).toHaveCount(0);
  });
  test('when no native config governs (configFile null), Rules is disabled and Source works', async ({
    page,
    workerServer,
  }) => {
    mkdirSync(join(workerServer.contentDir, 'docs'), { recursive: true });
    const nestedPath = 'docs/.markdownlint.json';
    writeFileSync(join(workerServer.contentDir, nestedPath), '{\n  "MD041": false\n}\n', 'utf-8');

    await page.goto(assetHash(nestedPath));
    await expect(configEditor(page)).toBeVisible({ timeout: 15_000 });

    await expect(loadedSource(page)).toBeVisible({ timeout: 15_000 });

    const rules = rulesSegment(page);
    await expect(rules).toBeDisabled({ timeout: 15_000 });

    const cfg = await page.request.get('/api/lint/config');
    expect(cfg.status()).toBe(200);
    expect((await cfg.json()).configFile).toBeNull();
    await expect(rules).toBeDisabled();
  });
});

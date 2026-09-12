import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import {
  expect,
  SETTINGS_PANEL_TIMEOUT_MS,
  setPluginEnabled,
  test,
  waitForSettingsPanel,
} from './_helpers';

async function openSettings(page: import('@playwright/test').Page) {
  await page.goto('/#settings');
  await expect(page.getByTestId('settings-dialog')).toBeVisible({ timeout: 10_000 });
}

test.describe('Settings search — navigation + pinned layout', () => {
  test('the search box stays pinned while the section list scrolls', async ({ page }) => {
    await page.setViewportSize({ width: 1000, height: 460 });
    await openSettings(page);

    const search = page.getByTestId('settings-search-input');
    await expect(search).toBeVisible();
    const before = await search.boundingBox();

    await page.getByTestId('settings-sidebar-item-okignore').scrollIntoViewIfNeeded();

    const after = await search.boundingBox();
    await expect(search).toBeInViewport();
    expect(before).not.toBeNull();
    expect(after).not.toBeNull();
    expect(Math.round(after?.y ?? -1)).toBe(Math.round(before?.y ?? -2));
  });

  test('typing a section name filters to a result that navigates on click', async ({ page }) => {
    await openSettings(page);

    await page.getByTestId('settings-search-input').fill('Hotkeys');
    const result = page.getByTestId('settings-search-result-section:hotkeys');
    await expect(result).toBeVisible({ timeout: 5_000 });

    await result.click();
    await expect(page.getByTestId('settings-hotkeys')).toBeVisible({
      timeout: SETTINGS_PANEL_TIMEOUT_MS,
    });
    await expect(page.getByTestId('settings-sidebar-item-preferences')).toBeVisible();
  });

  test('a no-match query shows the empty state', async ({ page }) => {
    await openSettings(page);
    await page.getByTestId('settings-search-input').fill('zzzznomatch');
    await expect(page.getByTestId('settings-search-empty')).toBeVisible({ timeout: 5_000 });
  });

  test('a field result scrolls its field into view and flashes it', async ({ page }) => {
    await openSettings(page);

    await page.getByTestId('settings-search-input').fill('Word wrap');
    const result = page.getByTestId('settings-search-result-field:preferences:editor.wordWrap');
    await expect(result).toBeVisible({ timeout: 5_000 });
    await result.click();

    const field = page.locator('[data-field="editor.wordWrap"]');
    await expect(field).toBeVisible({ timeout: SETTINGS_PANEL_TIMEOUT_MS });
    await expect(field).toBeInViewport();
    await expect(field).toHaveClass(/animate-settings-nav-flash/, { timeout: 2_000 });
    await expect(field).not.toHaveClass(/animate-settings-nav-flash/, { timeout: 3_000 });
  });

  test('a merged former section is searchable and lands on its block in the absorbing page', async ({
    page,
  }) => {
    await openSettings(page);

    await page.getByTestId('settings-search-input').fill('Config sharing');
    const result = page.getByTestId('settings-search-result-subsection:sync:sharing');
    await expect(result).toBeVisible({ timeout: 5_000 });
    await result.click();

    const block = page.locator('[data-field="section:sharing"]');
    await expect(block).toBeVisible({ timeout: SETTINGS_PANEL_TIMEOUT_MS });
    await expect(block).toBeInViewport();
    await expect(block).toHaveClass(/animate-settings-nav-flash/, { timeout: 2_000 });
  });

  test('Preview tabs is searchable from its catalog-backed label and description', async ({
    page,
  }) => {
    await openSettings(page);

    for (const query of ['preview', 'reuse']) {
      await page.getByTestId('settings-search-input').fill(query);
      const result = page.getByTestId(
        'settings-search-result-field:preferences:editor.previewTabs',
      );
      await expect(result).toBeVisible({ timeout: 5_000 });
      await result.click();

      const field = page.locator('[data-field="editor.previewTabs"]');
      await expect(field).toBeVisible({ timeout: SETTINGS_PANEL_TIMEOUT_MS });
      await expect(field).toBeInViewport();
    }
  });
});

test.describe('Settings search — scope badges + markdownlint rules', () => {
  test('the Themes plugin panel shows a User scope badge', async ({ page }) => {
    await openSettings(page);
    await page.getByTestId('settings-sidebar-item-plugin:theme').click();
    await expect(page.getByTestId('settings-scope-badge-user')).toBeVisible({
      timeout: SETTINGS_PANEL_TIMEOUT_MS,
    });
    await expect(page.getByTestId('settings-scope-badge-project')).toHaveCount(0);
  });

  test('markdownlint rules are searchable only while the plugin is enabled, and a rule result pre-filters the panel', async ({
    page,
  }) => {
    await openSettings(page);

    await page.getByTestId('settings-sidebar-item-plugins-manage').click();
    await waitForSettingsPanel(page, 'settings-plugins-manage');
    await setPluginEnabled(page, 'markdownlint', true);

    await page.getByTestId('settings-search-input').fill('MD013');
    const ruleResult = page.getByTestId('settings-search-result-rule:MD013');
    await expect(ruleResult).toBeVisible({ timeout: 5_000 });
    await ruleResult.click();

    await expect(page.getByTestId('settings-plugin-markdownlint')).toBeVisible();
    await expect(page.getByTestId('settings-scope-badge-project')).toBeVisible();
    await expect(page.getByTestId('markdownlint-rule-search')).toHaveValue('MD013');
    await expect(page.getByTestId('markdownlint-rule-row-MD013')).toBeVisible();
    await expect(page.getByTestId('markdownlint-rule-row-MD001')).toHaveCount(0);

    await page.getByTestId('settings-sidebar-item-plugins-manage').click();
    await setPluginEnabled(page, 'markdownlint', false);

    await page.getByTestId('settings-search-input').fill('MD013');
    await expect(page.getByTestId('settings-search-result-rule:MD013')).toHaveCount(0);
    await expect(page.getByTestId('settings-search-empty')).toBeVisible({ timeout: 5_000 });
  });
});

test.describe('Settings → Search — embedding request settings', () => {
  test('persists overrides and hot-applies request batching without restarting the server', async ({
    page,
    api,
    workerServer,
  }) => {
    test.setTimeout(90_000);
    const requests: string[][] = [];
    const fakeProvider = createServer((request, response) => {
      let body = '';
      request.setEncoding('utf8');
      request.on('data', (chunk) => {
        body += chunk;
      });
      request.on('end', () => {
        const input = (JSON.parse(body) as { input?: string[] }).input ?? [];
        requests.push(input);
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            data: input.map((_, index) => ({ index, embedding: [1, 0, 0, 0, 0, 0, 0, 0] })),
            usage: { total_tokens: input.length },
          }),
        );
      });
    });
    await new Promise<void>((resolve) => fakeProvider.listen(0, '127.0.0.1', resolve));

    try {
      const address = fakeProvider.address();
      if (address === null || typeof address === 'string')
        throw new Error('fake provider did not bind');
      const providerBaseUrl = `http://127.0.0.1:${address.port}/v1`;
      await api.seedDocs(
        Array.from({ length: 5 }, (_, index) => ({
          name: `embedding-default-${index}`,
          markdown: `# Default ${index}\n\nDEFAULT-BATCH-DOCUMENT-${index} unique semantic content.`,
        })),
      );

      await openSettings(page);
      await page.getByTestId('settings-sidebar-item-search').click();
      await page.getByTestId('settings-search-custom-endpoint-trigger').click();
      await page.getByTestId('settings-search-base-url').fill(providerBaseUrl);
      await page.getByTestId('settings-search-base-url').press('Enter');
      await page.getByTestId('settings-search-provider-confirm-apply').click();
      await page.getByTestId('settings-search-semantic-toggle').click();
      await page.getByTestId('settings-search-confirm-enable').click();

      const configPath = join(workerServer.contentDir, '.ok', 'local', 'config.yml');
      const readConfig = () => (existsSync(configPath) ? readFileSync(configPath, 'utf8') : '');
      await expect.poll(readConfig, { timeout: 10_000 }).toMatch(/enabled:\s*true/);

      const runSemanticSearch = async (query: string) => {
        const result = await page.request.post('/api/search', {
          data: { query, intent: 'full_text', semantic: true },
        });
        expect(result.ok()).toBe(true);
      };
      await runSemanticSearch('default embedding batch');
      await expect
        .poll(
          () =>
            requests.some(
              (input) =>
                input.length >= 5 && input.some((text) => text.includes('DEFAULT-BATCH-DOCUMENT')),
            ),
          { timeout: 20_000 },
        )
        .toBe(true);

      const readEmbeddedCount = async () => {
        const status = await page.request.get('/api/semantic-status');
        expect(status.ok()).toBe(true);
        return ((await status.json()) as { embedded: number }).embedded;
      };
      await expect.poll(readEmbeddedCount, { timeout: 10_000 }).toBeGreaterThanOrEqual(5);
      const initialEmbeddedCount = await readEmbeddedCount();
      requests.length = 0;

      await page.getByTestId('settings-search-performance-trigger').click();
      for (const [testId, value] of [
        ['settings-search-max-batch-size', '2'],
        ['settings-search-max-batch-chars', '16000'],
        ['settings-search-doc-timeout-seconds', '120'],
      ] as const) {
        const input = page.getByTestId(testId);
        await input.fill(value);
        await input.press('Enter');
      }

      await expect
        .poll(readConfig, { timeout: 10_000 })
        .toMatch(/maxBatchSize:\s*2[\s\S]*maxBatchChars:\s*16000[\s\S]*docTimeoutMs:\s*120000/);
      expect(await readEmbeddedCount()).toBe(initialEmbeddedCount);

      await page.keyboard.press('Escape');
      await expect(page.getByTestId('settings-dialog')).toBeHidden();
      await openSettings(page);
      await page.getByTestId('settings-sidebar-item-search').click();
      await expect(page.getByTestId('settings-search-max-batch-size')).toHaveValue('2');
      await expect(page.getByTestId('settings-search-max-batch-chars')).toHaveValue('16000');
      await expect(page.getByTestId('settings-search-doc-timeout-seconds')).toHaveValue('120');

      for (let index = 0; index < 5; index += 1) {
        const name = `embedding-retuned-${index}`;
        await api.createPage(`${name}.md`);
        await api.replaceDoc(
          name,
          `# Retuned ${index}\n\nRETUNED-BATCH-DOCUMENT-${index} unique semantic content.`,
        );
      }
      await runSemanticSearch('retuned embedding batch');
      await expect
        .poll(
          () => {
            const retuned = requests.filter((input) =>
              input.some((text) => text.includes('RETUNED-BATCH-DOCUMENT')),
            );
            return retuned.length >= 3 && retuned.every((input) => input.length <= 2);
          },
          { timeout: 30_000 },
        )
        .toBe(true);

      await expect.poll(readEmbeddedCount, { timeout: 10_000 }).toBe(initialEmbeddedCount + 5);
      expect(requests.flat().some((input) => input.includes('DEFAULT-BATCH-DOCUMENT'))).toBe(false);
    } finally {
      await new Promise<void>((resolve, reject) =>
        fakeProvider.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});

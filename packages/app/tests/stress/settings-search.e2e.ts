/**
 * E2E coverage for the Settings sidebar search + scope badges.
 *
 * These are the real-browser seams the jsdom DOM tests structurally cannot
 * reach at fidelity:
 *   - The search box stays PINNED while the section list scrolls (real layout +
 *     scroll — jsdom has no layout).
 *   - A section result NAVIGATES the real composed dialog (real Shell → index →
 *     matchesCommandQuery → cmdk → onNavigate, over the real dev server).
 *   - A field result SCROLLS its target into view and FLASHES it — the flash is
 *     a real CSS keyframe here, not a jsdom classList assertion.
 *   - A markdownlint rule result opens the panel PRE-FILTERED to that rule, and
 *     rules are searchable only while the plugin is ENABLED (disabled-plugin
 *     exclusion), driven through the real enable/disable toggle.
 *   - The plugin panels carry the correct User/Project scope badge.
 *
 * Runnable via `pnpm exec playwright test tests/stress/settings-search.e2e.ts`;
 * wired into the CI `test:e2e` subset (packages/app/package.json).
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import {
  expect,
  SETTINGS_PANEL_TIMEOUT_MS,
  setPluginEnabled,
  test,
  waitForSettingsPanel,
} from './_helpers';

/**
 * Open the dialog only. The frame and sidebar ship in the main bundle, so this
 * wait is cheap and stays short — every wait BELOW that reaches panel-body
 * content carries `SETTINGS_PANEL_TIMEOUT_MS` instead, because the body is one
 * lazy chunk whose first resolve on a worker is an order of magnitude slower.
 */
async function openSettings(page: import('@playwright/test').Page) {
  await page.goto('/#settings');
  await expect(page.getByTestId('settings-dialog')).toBeVisible({ timeout: 10_000 });
}

test.describe('Settings search — navigation + pinned layout', () => {
  test('the search box stays pinned while the section list scrolls', async ({ page }) => {
    // Shrink the viewport so the dialog (max-h: 100dvh-4rem) is shorter than the
    // section list — forcing the sidebar scroll region to actually overflow.
    await page.setViewportSize({ width: 1000, height: 460 });
    await openSettings(page);

    const search = page.getByTestId('settings-search-input');
    await expect(search).toBeVisible();
    const before = await search.boundingBox();

    // Scroll a bottom-of-list item into view — this scrolls the inner group
    // region, NOT the pinned search box.
    await page.getByTestId('settings-sidebar-item-okignore').scrollIntoViewIfNeeded();

    const after = await search.boundingBox();
    await expect(search).toBeInViewport();
    // The search box has not moved: it is outside the scroll region.
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
    // Real body swapped to the Hotkeys section; query cleared → group nav back.
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
    // Rendered outcome: the field is scrolled into the viewport…
    await expect(field).toBeInViewport();
    // …and the real CSS flash keyframe is applied, then clears.
    await expect(field).toHaveClass(/animate-settings-nav-flash/, { timeout: 2_000 });
    await expect(field).not.toHaveClass(/animate-settings-nav-flash/, { timeout: 3_000 });
  });

  test('a merged former section is searchable and lands on its block in the absorbing page', async ({
    page,
  }) => {
    await openSettings(page);

    // Config sharing merged into Sync & sharing; its subsection entry
    // navigates there and flashes the sharing block's anchor.
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
    // Themes is a user-scope plugin, enabled by default.
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

    // Ensure markdownlint is ENABLED via the real project-plugins toggle. The
    // panel wait is the caller's job: it is this page's first body render, so it
    // pays the cold chunk, while the helper's own gate is budgeted only for the
    // config binding that leaves the switch disabled.
    await page.getByTestId('settings-sidebar-item-plugins-manage').click();
    await waitForSettingsPanel(page, 'settings-plugins-manage');
    await setPluginEnabled(page, 'markdownlint', true);

    // A rule is now searchable from the sidebar search; the result opens the
    // panel pre-filtered to that rule, and the header shows the Project badge.
    await page.getByTestId('settings-search-input').fill('MD013');
    const ruleResult = page.getByTestId('settings-search-result-rule:MD013');
    await expect(ruleResult).toBeVisible({ timeout: 5_000 });
    await ruleResult.click();

    await expect(page.getByTestId('settings-plugin-markdownlint')).toBeVisible();
    await expect(page.getByTestId('settings-scope-badge-project')).toBeVisible();
    await expect(page.getByTestId('markdownlint-rule-search')).toHaveValue('MD013');
    await expect(page.getByTestId('markdownlint-rule-row-MD013')).toBeVisible();
    await expect(page.getByTestId('markdownlint-rule-row-MD001')).toHaveCount(0);

    // Now DISABLE markdownlint; its rules drop out of the search index. No
    // panel wait here: the body chunk resolved above, so the helper's binding
    // gate is the only readiness left to wait on.
    await page.getByTestId('settings-sidebar-item-plugins-manage').click();
    await setPluginEnabled(page, 'markdownlint', false);

    await page.getByTestId('settings-search-input').fill('MD013');
    await expect(page.getByTestId('settings-search-result-rule:MD013')).toHaveCount(0);
    await expect(page.getByTestId('settings-search-empty')).toBeVisible({ timeout: 5_000 });
  });
});

test.describe('Settings → Search — embedding performance tuning', () => {
  test('persists overrides and hot-applies HTTP batching without restarting or replacing the cache', async ({
    page,
    api,
    workerServer,
  }) => {
    test.setTimeout(120_000);
    const requests: string[][] = [];
    let slowSpecialRequest = false;
    let delayedSpecialRequest = false;
    const fakeProvider = createServer((request, response) => {
      let body = '';
      request.setEncoding('utf8');
      request.on('data', (chunk) => {
        body += chunk;
      });
      request.on('end', () => {
        const parsed = JSON.parse(body) as { input?: string[] };
        const input = parsed.input ?? [];
        requests.push(input);
        const send = () => {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(
            JSON.stringify({
              data: input.map((_, index) => ({ index, embedding: [1, 0, 0, 0, 0, 0, 0, 0] })),
              usage: { total_tokens: input.length },
            }),
          );
        };
        if (
          slowSpecialRequest &&
          !delayedSpecialRequest &&
          input.some((text) => text.includes('SPECIAL-SLOW-DOCUMENT'))
        ) {
          delayedSpecialRequest = true;
          setTimeout(send, 31_000);
        } else {
          send();
        }
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
      await expect
        .poll(
          async () => {
            const status = await page.request.get('/api/semantic-status');
            return ((await status.json()) as { enabled?: boolean }).enabled;
          },
          { timeout: 10_000 },
        )
        .toBe(true);

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

      const cacheDir = join(workerServer.contentDir, '.ok', 'local', 'embeddings');
      await expect.poll(() => statSync(cacheDir).isDirectory(), { timeout: 10_000 }).toBe(true);
      const cacheDirectoryInode = statSync(cacheDir).ino;
      const originalPid = workerServer.pid;
      process.kill(originalPid, 0);

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

      await page.keyboard.press('Escape');
      await expect(page.getByTestId('settings-dialog')).toBeHidden();
      await openSettings(page);
      await page.getByTestId('settings-sidebar-item-search').click();
      await expect(page.getByTestId('settings-search-max-batch-size')).toHaveValue('2');
      await expect(page.getByTestId('settings-search-max-batch-chars')).toHaveValue('16000');
      await expect(page.getByTestId('settings-search-doc-timeout-seconds')).toHaveValue('120');

      requests.length = 0;
      slowSpecialRequest = true;
      await api.seedDocs(
        Array.from({ length: 5 }, (_, index) => ({
          name: `embedding-special-${index}`,
          markdown: `# Special ${index}\n\nSPECIAL-SLOW-DOCUMENT-${index} unique semantic content.`,
        })),
      );
      await runSemanticSearch('special embedding batch');
      await expect
        .poll(
          () => {
            const special = requests.filter((input) =>
              input.some((text) => text.includes('SPECIAL-SLOW-DOCUMENT')),
            );
            return (
              delayedSpecialRequest &&
              special.length >= 3 &&
              special.every((input) => input.length <= 2)
            );
          },
          { timeout: 50_000 },
        )
        .toBe(true);

      expect(workerServer.pid).toBe(originalPid);
      process.kill(originalPid, 0);
      expect(statSync(cacheDir).ino).toBe(cacheDirectoryInode);
    } finally {
      await new Promise<void>((resolve, reject) =>
        fakeProvider.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});

/**
 * Playwright E2E for the unified validation surface: the Problems
 * panel's project scope renders lint AND broken-link findings from
 * `GET /api/audit` with per-row source tags, and the file tree tints + badges
 * problem rows inside the real `@pierre/trees` shadow root — the rung jsdom
 * structurally cannot cover (unsafeCSS paints only in a browser).
 *
 * Freshness trigger 3 (an agent write to an UNOPENED doc tints its tree row
 * via the CC1 disk-ack relay, no project audit involved) is exercised against
 * the live persistence pipeline.
 */

import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import {
  expect,
  filterCriticalErrors,
  type LogEntry,
  test,
  waitForActiveProviderSynced as waitForProvider,
} from './_helpers';

// A hard tab trips markdownlint MD010 (warning under OK's tuned defaults).
const HARD_TAB_BODY = '# Heading\n\n\tindented with a hard tab\n';

/** Open the right-rail Problems tab. */
async function openProblemsTab(page: Page) {
  await page.locator('#tab-problems').click();
  await expect(
    page.locator('ul[aria-label="Problems"]').or(page.getByText('No problems found')),
  ).toBeVisible({ timeout: 5_000 });
}

/** Activate project scope and wait for the audit snapshot to land. */
async function openProjectScope(page: Page) {
  await page.getByTestId('panel-scope-project').click();
  await expect(page.getByTestId('problems-project-scope')).toBeVisible({ timeout: 5_000 });
  await expect(page.getByTestId('problems-audit-summary')).not.toBeEmpty({ timeout: 15_000 });
}

/** The file tree's shadow row for a tree path, evaluated in the live shadow root. */
function treeRowHandle(page: Page, treePath: string) {
  return page.locator('file-tree-container').evaluateHandle((host, path) => {
    return (host as Element & { shadowRoot: ShadowRoot | null }).shadowRoot?.querySelector(
      `[data-type="item"][data-item-path="${path}"]`,
    );
  }, treePath);
}

const errors: LogEntry[] = [];
let openDocName = '';
let lintDocName = '';
let linkDocName = '';

test.beforeEach(async ({ page, api, workerServer }) => {
  // markdownlint is opt-in; enable it so the lint plane carries findings.
  mkdirSync(join(workerServer.contentDir, '.ok'), { recursive: true });
  writeFileSync(
    join(workerServer.contentDir, '.ok', 'config.yml'),
    'contentRules:\n  markdownlint:\n    enabled: true\n',
    'utf-8',
  );
  errors.length = 0;
  page.on('pageerror', (err) => errors.push({ type: 'uncaught', text: err.message }));
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      const loc = msg.location();
      errors.push({ type: 'error', text: msg.text(), url: loc.url, line: loc.lineNumber });
    }
  });

  const suffix = randomUUID().slice(0, 8);
  openDocName = `uv-open-${suffix}`;
  lintDocName = `uv-lint-${suffix}`;
  linkDocName = `uv-link-${suffix}`;
  await api.createPage(`${openDocName}.md`);
  await api.createPage(`${lintDocName}.md`);
  await api.createPage(`${linkDocName}.md`);
  await api.replaceDoc(lintDocName, HARD_TAB_BODY);
  await api.replaceDoc(linkDocName, `# Linker\n\nSee [[uv-ghost-${suffix}]].\n`);

  await page.goto(`/#/${openDocName}`);
  await waitForProvider(page);
  await page.waitForSelector('.ProseMirror:not(.composer-prosemirror)');
});

test.afterEach(() => {
  expect(filterCriticalErrors(errors), 'Expected zero critical console errors').toEqual([]);
});

test.afterAll(({ workerServer }) => {
  writeFileSync(join(workerServer.contentDir, '.ok', 'config.yml'), '', 'utf-8');
});

test.describe('unified Problems — project scope', () => {
  test('lint and dead-link findings render together, source-tagged', async ({ page }) => {
    await openProblemsTab(page);
    await openProjectScope(page);

    // Both seeded files group in the plane.
    await expect(page.getByText(`${lintDocName}.md`)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(`${linkDocName}.md`)).toBeVisible();

    // Rows name their producing validator, not a generic category.
    const tags = page.getByTestId('problems-source-tag');
    await expect(tags.filter({ hasText: 'markdownlint' }).first()).toBeVisible();
    await expect(tags.filter({ hasText: 'links' }).first()).toBeVisible();

    // The chip carries the producer, so the subline shows the bare rule code.
    await expect(page.getByText('dead-link').first()).toBeVisible();
    // `getByText` substring-matches by default, so asserting `dead-link` alone
    // also passes against the old `links/dead-link`. Pin the absence too.
    await expect(page.getByText('links/dead-link')).toHaveCount(0);
  });
});

test.describe('unified Problems — file-tree indicators', () => {
  test('a project audit tints problem rows in the live shadow root, clean rows stay bare', async ({
    page,
  }) => {
    await openProblemsTab(page);
    await openProjectScope(page);

    // The tint attribute lands on the real shadow-DOM rows. Broken links are
    // warnings by default (validation.links), like the lint findings.
    await expect
      .poll(
        async () => {
          const row = await treeRowHandle(page, `${linkDocName}.md`);
          return row.evaluate((el) => el?.getAttribute('data-ok-problem') ?? null);
        },
        { timeout: 15_000 },
      )
      .toBe('warning');
    await expect
      .poll(async () => {
        const row = await treeRowHandle(page, `${lintDocName}.md`);
        return row.evaluate((el) => el?.getAttribute('data-ok-problem') ?? null);
      })
      .toBe('warning');

    // Count badge is injected next to the label.
    const badgeText = await (await treeRowHandle(page, `${linkDocName}.md`)).evaluate(
      (el) => el?.querySelector('[data-ok-problem-badge]')?.textContent ?? null,
    );
    expect(badgeText).toBe('1');

    // The unsafeCSS actually paints: a tinted row's label color differs from a
    // clean row's — the pixels jsdom cannot verify.
    const colors = await page.locator('file-tree-container').evaluate(
      (host, paths) => {
        const shadow = (host as Element & { shadowRoot: ShadowRoot | null }).shadowRoot;
        const colorOf = (path: string) => {
          const section = shadow?.querySelector(
            `[data-type="item"][data-item-path="${path}"] [data-item-section="content"]`,
          );
          return section ? getComputedStyle(section as Element).color : null;
        };
        return { problem: colorOf(paths[0] as string), clean: colorOf(paths[1] as string) };
      },
      [`${linkDocName}.md`, `${openDocName}.md`],
    );
    expect(colors.problem).not.toBeNull();
    expect(colors.clean).not.toBeNull();
    expect(colors.problem).not.toBe(colors.clean);
  });

  test('an agent write to an unopened doc tints its row via disk-ack, no audit run', async ({
    page,
    api,
  }) => {
    const suffix = randomUUID().slice(0, 8);
    const sleeperDoc = `uv-sleeper-${suffix}`;
    await api.createPage(`${sleeperDoc}.md`);

    // No Problems panel interaction at all — the only freshness path available
    // is the per-doc disk-ack re-validate.
    await api.replaceDoc(sleeperDoc, `# Sleeper\n\nSee [[uv-sleeper-ghost-${suffix}]].\n`);

    await expect
      .poll(
        async () => {
          const row = await treeRowHandle(page, `${sleeperDoc}.md`);
          return row.evaluate((el) => el?.getAttribute('data-ok-problem') ?? null);
        },
        // Bounded by the persistence debounce + disk-ack + 500ms revalidate
        // debounce — generous ceiling, converges much earlier in practice.
        { timeout: 30_000 },
      )
      .toBe('warning');
  });
});

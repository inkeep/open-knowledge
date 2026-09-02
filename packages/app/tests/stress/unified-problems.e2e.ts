import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import {
  expect,
  filterCriticalErrors,
  type LogEntry,
  openProjectPluginsPanel,
  setPluginEnabled,
  test,
  waitForActiveProviderSynced as waitForProvider,
} from './_helpers';

const HARD_TAB_BODY = '# Heading\n\n\tindented with a hard tab\n';

async function openProblemsTab(page: Page) {
  await page.locator('#tab-problems').click();
  await expect(
    page.locator('ul[aria-label="Problems"]').or(page.getByText('No problems found')),
  ).toBeVisible({ timeout: 5_000 });
}

async function openProjectScope(page: Page) {
  await page.getByTestId('panel-scope-project').click();
  await expect(page.getByTestId('problems-project-scope')).toBeVisible({ timeout: 5_000 });
  await expect(page.getByTestId('problems-audit-summary')).not.toBeEmpty({ timeout: 15_000 });
}

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

    await expect(page.getByText(`${lintDocName}.md`)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(`${linkDocName}.md`)).toBeVisible();

    await page.getByTestId('problems-audit-expand-toggle').click();

    const tags = page.getByTestId('problems-source-tag');
    await expect(tags.filter({ hasText: 'markdownlint' }).first()).toBeVisible();
    await expect(tags.filter({ hasText: 'links' }).first()).toBeVisible();

    await expect(page.getByText('dead-link').first()).toBeVisible();
    await expect(page.getByText('links/dead-link')).toHaveCount(0);
  });
});

test.describe('unified Problems — file-tree indicators', () => {
  test('a project audit tints problem rows in the live shadow root, clean rows stay bare', async ({
    page,
  }) => {
    await openProblemsTab(page);
    await openProjectScope(page);

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

    const badge = await (await treeRowHandle(page, `${linkDocName}.md`)).evaluate((el) => {
      const node = el?.querySelector('[data-ok-problem-badge]');
      if (!node) return null;
      return {
        text: node.textContent,
        title: (node as HTMLElement).title,
        pointerEvents: getComputedStyle(node).pointerEvents,
      };
    });
    expect(badge?.text).toBe('1');
    expect(badge?.pointerEvents).not.toBe('none');
    expect(badge?.title).toBe('1 warning in this file. Open the Problems panel for details.');

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

  test('the badge is a keyboard-reachable control with a real hit target', async ({ page }) => {
    await openProblemsTab(page);
    await openProjectScope(page);
    await expect
      .poll(
        async () => {
          const row = await treeRowHandle(page, `${lintDocName}.md`);
          return row.evaluate((el) => el?.getAttribute('data-ok-problem') ?? null);
        },
        { timeout: 15_000 },
      )
      .toBe('warning');

    const rowSelector = `[data-type="item"][data-item-path="${lintDocName}.md"]`;
    const badge = page
      .locator('file-tree-container')
      .locator(`${rowSelector} [data-ok-problem-badge]`);

    await page.locator('file-tree-container').evaluate((host, selector) => {
      const shadow = (host as Element & { shadowRoot: ShadowRoot | null }).shadowRoot;
      (shadow?.querySelector(selector) as HTMLElement | null)?.focus();
    }, rowSelector);
    await page.keyboard.press('Tab');

    const focused = await page.locator('file-tree-container').evaluate((host) => {
      const shadow = (host as Element & { shadowRoot: ShadowRoot | null }).shadowRoot;
      const active = shadow?.activeElement as HTMLElement | null;
      if (!active?.hasAttribute('data-ok-problem-badge')) return null;
      const style = getComputedStyle(active);
      const box = active.getBoundingClientRect();
      const probe = (dy: number) =>
        shadow?.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2 + dy) ?? null;
      return {
        role: active.getAttribute('role'),
        chipHeight: box.height,
        outlineWidth: style.outlineWidth,
        outlineStyle: style.outlineStyle,
        outlineColor: style.outlineColor,
        hitsAbove: probe(-11.5) === active,
        hitsBelow: probe(11.5) === active,
      };
    });

    expect(focused).not.toBeNull();
    expect(focused?.role).toBe('button');
    expect(await badge.ariaSnapshot()).toContain(
      'button "1 problem. 1 warning in this file. Open the Problems panel for details."',
    );
    expect(focused?.outlineStyle).not.toBe('none');
    expect(focused?.outlineWidth).not.toBe('0px');
    expect(focused?.outlineColor).not.toMatch(/transparent|rgba\(0, 0, 0, 0\)/);
    expect(focused?.chipHeight).toBeLessThan(24);
    expect(focused?.hitsAbove).toBe(true);
    expect(focused?.hitsBelow).toBe(true);

    await page.keyboard.press('Enter');
    await expect(page.getByTestId('panel-scope-doc')).toHaveAttribute('data-state', 'on', {
      timeout: 10_000,
    });
    await expect(page.getByTestId('problems-panel')).toBeFocused();
    await expect(page).toHaveURL(new RegExp(`#/${lintDocName}$`), { timeout: 10_000 });
  });

  test('a modified click on the badge stays the tree multi-select gesture', async ({ page }) => {
    await openProblemsTab(page);
    await openProjectScope(page);
    const badge = page
      .locator('file-tree-container')
      .locator(`[data-item-path="${lintDocName}.md"] [data-ok-problem-badge]`);
    await expect(badge).toBeVisible({ timeout: 15_000 });

    const selected = () =>
      page.locator('file-tree-container').evaluate((host) => {
        const shadow = (host as Element & { shadowRoot: ShadowRoot | null }).shadowRoot;
        return [...(shadow?.querySelectorAll('[data-item-selected]') ?? [])]
          .map((el) => el.getAttribute('data-item-path'))
          .sort();
      });

    await page
      .locator('file-tree-container')
      .locator(`[data-item-path="${openDocName}.md"]`)
      .click();
    await expect.poll(selected).toEqual([`${openDocName}.md`]);

    await badge.click({ modifiers: ['Meta'] });

    await expect.poll(selected).toEqual([`${lintDocName}.md`, `${openDocName}.md`].sort());
  });

  test('enabling the plugin from Settings lights up an UNOPENED doc row', async ({ page, api }) => {
    test.setTimeout(180_000);

    const suffix = randomUUID().slice(0, 8);
    const enableDoc = `uv-enable-${suffix}`;
    await api.createPage(`${enableDoc}.md`);
    await api.replaceDoc(enableDoc, HARD_TAB_BODY);

    const problemAttr = async () => {
      const row = await treeRowHandle(page, `${enableDoc}.md`);
      return row.evaluate((el) => el?.getAttribute('data-ok-problem') ?? null);
    };

    await expect.poll(problemAttr, { timeout: 30_000 }).toBe('warning');

    await openProjectPluginsPanel(page);

    await setPluginEnabled(page, 'markdownlint', false);
    await expect.poll(problemAttr, { timeout: 30_000 }).toBeNull();

    await setPluginEnabled(page, 'markdownlint', true);
    await expect.poll(problemAttr, { timeout: 30_000 }).toBe('warning');
  });

  test('enabling the frontmatter plugin lights up an UNOPENED doc with a schema violation', async ({
    page,
    api,
    workerServer,
  }) => {
    test.setTimeout(180_000);

    const suffix = randomUUID().slice(0, 8);
    const fmDoc = `uv-fm-${suffix}`;
    const schemaRel = join('.ok', 'schemas', `uv-fm-${suffix}.schema.json`);
    mkdirSync(join(workerServer.contentDir, '.ok', 'schemas'), { recursive: true });
    writeFileSync(
      join(workerServer.contentDir, schemaRel),
      JSON.stringify({
        $schema: 'http://json-schema.org/draft-07/schema#',
        type: 'object',
        required: ['title'],
      }),
      'utf-8',
    );
    writeFileSync(
      join(workerServer.contentDir, '.ok', 'config.yml'),
      [
        'contentRules:',
        '  markdownlint:',
        '    enabled: true',
        '  frontmatter:',
        '    enabled: false',
        '    schemas:',
        `      - file: ${schemaRel}`,
        `        appliesTo: '${fmDoc}'`,
        '        enabled: true',
        '',
      ].join('\n'),
      'utf-8',
    );

    await api.createPage(`${fmDoc}.md`);
    await api.replaceDoc(fmDoc, '---\nsummary: no title here\n---\n\n# Body\n\nClean prose.\n');

    const problemAttr = async () => {
      const row = await treeRowHandle(page, `${fmDoc}.md`);
      return row.evaluate((el) => el?.getAttribute('data-ok-problem') ?? null);
    };

    await expect.poll(problemAttr, { timeout: 20_000 }).toBeNull();

    await openProjectPluginsPanel(page);
    await setPluginEnabled(page, 'frontmatter', true);

    await expect.poll(problemAttr, { timeout: 30_000 }).toBe('warning');

    await setPluginEnabled(page, 'frontmatter', false);
    await expect.poll(problemAttr, { timeout: 30_000 }).toBeNull();
  });

  test('toggling a rule off clears an UNOPENED doc row, no Problems panel interaction', async ({
    page,
    api,
    baseURL,
    workerServer,
  }) => {
    const suffix = randomUUID().slice(0, 8);
    const toggleDoc = `uv-toggle-${suffix}`;
    await api.createPage(`${toggleDoc}.md`);
    await api.replaceDoc(toggleDoc, HARD_TAB_BODY);

    const problemAttr = async () => {
      const row = await treeRowHandle(page, `${toggleDoc}.md`);
      return row.evaluate((el) => el?.getAttribute('data-ok-problem') ?? null);
    };

    await expect.poll(problemAttr, { timeout: 30_000 }).toBe('warning');

    const configPath = join(workerServer.contentDir, '.markdownlint.json');
    try {
      const res = await fetch(`${baseURL}/api/lint/markdownlint-config`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ruleId: 'MD010', value: false }),
      });
      expect(res.ok, 'rule write should succeed').toBe(true);

      await expect.poll(problemAttr, { timeout: 30_000 }).toBeNull();
    } finally {
      rmSync(configPath, { force: true });
    }
  });

  test('a doc whose problems predate the page load tints on open, nothing touched', async ({
    page,
    api,
  }) => {
    const suffix = randomUUID().slice(0, 8);
    const priorLintDoc = `uv-prior-lint-${suffix}`;
    const priorLinkDoc = `uv-prior-link-${suffix}`;
    await api.createPage(`${priorLintDoc}.md`);
    await api.createPage(`${priorLinkDoc}.md`);
    await api.replaceDoc(priorLintDoc, HARD_TAB_BODY);
    await api.replaceDoc(priorLinkDoc, `# Linker\n\nSee [[uv-prior-ghost-${suffix}]].\n`);

    await page.reload();
    await waitForProvider(page);

    const attrOf = async (treePath: string) => {
      const row = await treeRowHandle(page, treePath);
      return row.evaluate((el) => el?.getAttribute('data-ok-problem') ?? null);
    };
    await expect.poll(() => attrOf(`${priorLintDoc}.md`), { timeout: 30_000 }).toBe('warning');
    await expect.poll(() => attrOf(`${priorLinkDoc}.md`), { timeout: 30_000 }).toBe('warning');
  });

  test('an agent write to an unopened doc tints its row via disk-ack', async ({ page, api }) => {
    await expect
      .poll(
        async () => {
          const row = await treeRowHandle(page, `${lintDocName}.md`);
          return row.evaluate((el) => el?.getAttribute('data-ok-problem') ?? null);
        },
        { timeout: 30_000 },
      )
      .toBe('warning');

    const suffix = randomUUID().slice(0, 8);
    const sleeperDoc = `uv-sleeper-${suffix}`;
    await api.createPage(`${sleeperDoc}.md`);

    await api.replaceDoc(sleeperDoc, `# Sleeper\n\nSee [[uv-sleeper-ghost-${suffix}]].\n`);

    await expect
      .poll(
        async () => {
          const row = await treeRowHandle(page, `${sleeperDoc}.md`);
          return row.evaluate((el) => el?.getAttribute('data-ok-problem') ?? null);
        },
        { timeout: 30_000 },
      )
      .toBe('warning');
  });
});

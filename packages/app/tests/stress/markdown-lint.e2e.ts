import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import {
  type ApiHelpers,
  expect,
  filterCriticalErrors,
  type LogEntry,
  SETTINGS_PANEL_TIMEOUT_MS,
  test,
  waitForActiveProviderSynced as waitForProvider,
} from './_helpers';

const HARD_TAB_BODY = '# Heading\n\n\tindented with a hard tab\n';
const CLEAN_BODY = '# Heading\n\nA clean paragraph with no violations.\n';
const MD010 = 'MD010';
const MD001_AND_TAB_BODY = '# Heading\n\n### Skipped level\n\n\tindented with a hard tab\n';
const MD001 = 'MD001';

async function switchToSource(page: Page) {
  await page.getByRole('radio', { name: 'Markdown source' }).click();
  await page.waitForSelector('.cm-content', { timeout: 10_000 });
  await page.waitForFunction(() => document.querySelectorAll('.cm-line').length > 0, null, {
    timeout: 5_000,
  });
}

async function openProblemsTab(page: Page) {
  await page.locator('#tab-problems').click();
  await expect(
    page.locator('ul[aria-label="Problems"]').or(page.getByText('No problems found')),
  ).toBeVisible({ timeout: 5_000 });
}

async function activeSourceLine(page: Page): Promise<number> {
  return page.evaluate(() => {
    const anchor = window.getSelection()?.anchorNode ?? null;
    const element = anchor instanceof Element ? anchor : (anchor?.parentElement ?? null);
    const line = element?.closest('.cm-line') ?? null;
    if (!line) return -1;
    return Array.from(document.querySelectorAll('.cm-content .cm-line')).indexOf(line) + 1;
  });
}

const errors: LogEntry[] = [];
let testDocName = '';

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

  await page.addInitScript(() => {
    try {
      localStorage.setItem('ok-acp-follow-file-v1', '0');
    } catch {}
  });

  testDocName = `mdlint-${randomUUID().slice(0, 8)}`;
  await api.createPage(`${testDocName}.md`);
  await page.goto(`/#/${testDocName}`);
  await waitForProvider(page);
  await page.waitForSelector('.ProseMirror:not(.composer-prosemirror)');
});

test.afterEach(() => {
  expect(filterCriticalErrors(errors), 'Expected zero critical console errors').toEqual([]);
});

test.afterAll(({ workerServer }) => {
  writeFileSync(join(workerServer.contentDir, '.ok', 'config.yml'), '', 'utf-8');
});

test.describe('markdown lint — source-mode decorations', () => {
  test('a hard tab paints a CM6 lint range + gutter marker', async ({ page, api }) => {
    await seed(api, testDocName, HARD_TAB_BODY);
    await switchToSource(page);

    await expect(page.locator('.cm-content .cm-lintRange')).not.toHaveCount(0);
    await expect(page.locator('.cm-gutter .cm-lint-marker').first()).toBeVisible();
  });

  test('a clean document paints no lint ranges (no false positives)', async ({ page, api }) => {
    await seed(api, testDocName, HARD_TAB_BODY);
    await switchToSource(page);
    await expect(page.locator('.cm-content .cm-lintRange')).not.toHaveCount(0);

    await seed(api, testDocName, CLEAN_BODY);
    await expect(page.locator('.cm-content .cm-lintRange')).toHaveCount(0);
  });

  test('editing to introduce a violation live-relints the open editor', async ({ page, api }) => {
    await seed(api, testDocName, CLEAN_BODY);
    await switchToSource(page);
    await expect(page.locator('.cm-content .cm-lintRange')).toHaveCount(0);

    await seed(api, testDocName, HARD_TAB_BODY);
    await expect(page.locator('.cm-content .cm-lintRange')).not.toHaveCount(0);
  });
});

test.describe('markdown lint — Problems panel composition', () => {
  test('the violation surfaces in the panel with its rule code and a count badge', async ({
    page,
    api,
  }) => {
    await seed(api, testDocName, HARD_TAB_BODY);
    await openProblemsTab(page);

    const violations = page.locator('ul[aria-label="Problems"] > li');
    await expect(violations).not.toHaveCount(0);
    await expect(page.getByText(MD010)).toBeVisible();

    await expect(page.locator('#tab-problems').getByText(/^\d+$/)).toBeVisible();
  });

  test('a clean document shows the empty state and no badge', async ({ page, api }) => {
    await seed(api, testDocName, HARD_TAB_BODY);
    await openProblemsTab(page);
    await expect(page.locator('ul[aria-label="Problems"] > li')).not.toHaveCount(0);

    await seed(api, testDocName, CLEAN_BODY);
    await expect(page.getByText('No problems found')).toBeVisible();
    await expect(page.locator('#tab-problems').getByText(/^\d+$/)).toHaveCount(0);
  });

  test('clicking a violation row emits a lint-nav event with the target line', async ({
    page,
    api,
  }) => {
    await seed(api, testDocName, HARD_TAB_BODY);
    await openProblemsTab(page);

    const navLine = page.evaluate<number>(
      () =>
        new Promise((resolve) => {
          window.addEventListener(
            'open-knowledge:lint-nav',
            (e) => resolve((e as CustomEvent).detail?.line ?? -1),
            { once: true },
          );
        }),
    );
    await page.locator('ul[aria-label="Problems"] > li button').first().click();
    expect(await navLine).toBe(3);
  });
});

test.describe('markdown lint — Problems panel project scope', () => {
  test('project scope lists violating files with per-file counts on demand', async ({
    page,
    api,
    workerServer,
  }) => {
    const doc2 = `mdlint-${randomUUID().slice(0, 8)}`;
    await api.createPage(`${doc2}.md`);
    await seed(api, doc2, HARD_TAB_BODY);
    await seed(api, testDocName, MD001_AND_TAB_BODY);

    await expect
      .poll(
        () => {
          try {
            return (
              readFileSync(join(workerServer.contentDir, `${testDocName}.md`), 'utf-8').includes(
                '### Skipped level',
              ) && readFileSync(join(workerServer.contentDir, `${doc2}.md`), 'utf-8').includes('\t')
            );
          } catch {
            return false;
          }
        },
        { timeout: 15_000 },
      )
      .toBe(true);

    await openProblemsTab(page);
    await page.getByTestId('panel-scope-project').click();

    const scopeBody = page.getByTestId('problems-project-scope');
    const group1 = scopeBody.getByTestId('problems-audit-group').filter({ hasText: testDocName });
    const group2 = scopeBody.getByTestId('problems-audit-group').filter({ hasText: doc2 });
    await expect(group1).toBeVisible({ timeout: 10_000 });
    await expect(group2).toBeVisible();
    await expect(group1.getByTestId('problems-audit-file-count')).toHaveText('2');
    await expect(group2.getByTestId('problems-audit-file-count')).toHaveText('1');
    await expect(group1).toHaveAttribute('data-state', 'closed');
    await expect(group2).toHaveAttribute('data-state', 'closed');
    await expect(scopeBody.getByText(MD001)).toHaveCount(0);
    await expect(scopeBody.getByText(MD010)).toHaveCount(0);

    await scopeBody.getByTestId('problems-audit-expand-toggle').click();
    await expect(group1).toHaveAttribute('data-state', 'open');
    await expect(group1.getByText(MD001)).toBeVisible();
    await expect(group2.getByText(MD010)).toBeVisible();
    await scopeBody.getByTestId('problems-audit-expand-toggle').click();
    await expect(group1).toHaveAttribute('data-state', 'closed');
    await expect(scopeBody.getByText(MD001)).toHaveCount(0);

    await expect(page.getByTestId('problems-audit-summary')).toContainText('warning');
  });

  test('clicking a project-scope diagnostic for a closed doc opens it at the diagnostic line', async ({
    page,
    api,
    workerServer,
  }) => {
    const doc2 = `mdlint-${randomUUID().slice(0, 8)}`;
    await api.createPage(`${doc2}.md`);
    await seed(api, doc2, HARD_TAB_BODY);
    await seed(api, testDocName, CLEAN_BODY);

    await expect
      .poll(
        () => {
          try {
            return readFileSync(join(workerServer.contentDir, `${doc2}.md`), 'utf-8').includes(
              '\t',
            );
          } catch {
            return false;
          }
        },
        { timeout: 15_000 },
      )
      .toBe(true);

    await switchToSource(page);
    await openProblemsTab(page);
    await page.getByTestId('panel-scope-project').click();

    const group = page.getByTestId('problems-audit-group').filter({ hasText: doc2 });
    await expect(group).toBeVisible({ timeout: 10_000 });
    await page.getByTestId('problems-audit-expand-toggle').click();
    await group.getByRole('button', { name: /Hard tabs/ }).click();

    await expect.poll(() => new URL(page.url()).hash).toBe(`#/${doc2}`);
    await waitForProvider(page);
    await expect(page.locator('.cm-content')).toContainText('indented with a hard tab');
    await expect.poll(() => activeSourceLine(page)).toBe(3);
  });
});

test.describe('markdown lint — settings rule browser', () => {
  test('toggling MD001 off writes the native config file and clears its decorations', async ({
    page,
    api,
    workerServer,
  }) => {
    await seed(api, testDocName, MD001_AND_TAB_BODY);
    await openProblemsTab(page);
    await expect(page.getByText(MD001)).toBeVisible();
    await expect(page.getByText(MD010)).toBeVisible();
    await switchToSource(page);
    await expect(page.locator('.cm-content .cm-lintRange')).not.toHaveCount(0);

    const configPath = join(workerServer.contentDir, '.markdownlint.json');
    try {
      await page.goto('/#settings');
      await page.getByTestId('settings-sidebar-item-plugin:markdownlint').click();
      const search = page.getByTestId('markdownlint-rule-search');
      await expect(search).toBeVisible({ timeout: SETTINGS_PANEL_TIMEOUT_MS });
      await search.fill('MD001');
      const toggle = page.getByTestId('markdownlint-rule-toggle-MD001');
      await expect(toggle).toHaveAttribute('aria-checked', 'true');
      await toggle.click();

      await expect(page.getByTestId('markdownlint-rule-modified-MD001')).toBeVisible({
        timeout: 10_000,
      });
      await expect(toggle).toHaveAttribute('aria-checked', 'false');
      const config = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
      expect(config.MD001).toBe(false);

      await page.goto(`/#/${testDocName}`);
      await waitForProvider(page);
      await switchToSource(page);
      await expect(page.locator('.cm-content .cm-lintRange')).not.toHaveCount(0);
      await openProblemsTab(page);
      await expect(page.getByText(MD010)).toBeVisible();
      await expect(page.getByText(MD001)).toHaveCount(0);
    } finally {
      rmSync(configPath, { force: true });
    }
  });

  test('editing MD013 line_length through the option field preserves the file’s other keys', async ({
    page,
    workerServer,
  }) => {
    const configPath = join(workerServer.contentDir, '.markdownlint.json');
    writeFileSync(
      configPath,
      `${JSON.stringify({ MD010: false, MD013: { line_length: 120, code_blocks: false } }, null, 2)}\n`,
    );
    try {
      await page.goto('/#settings');
      await page.getByTestId('settings-sidebar-item-plugin:markdownlint').click();
      const search = page.getByTestId('markdownlint-rule-search');
      await expect(search).toBeVisible({ timeout: SETTINGS_PANEL_TIMEOUT_MS });
      await search.fill('MD013');
      await page.getByTestId('markdownlint-rule-expand-MD013').click();

      const field = page.locator('#rule-option-MD013-line_length');
      await expect(field).toHaveValue('120');
      await field.fill('100');
      await field.press('Enter');

      await expect
        .poll(
          () => {
            const config = JSON.parse(readFileSync(configPath, 'utf-8')) as {
              MD013?: { line_length?: unknown };
            };
            return config.MD013?.line_length;
          },
          { timeout: 10_000 },
        )
        .toBe(100);
      const raw = readFileSync(configPath, 'utf-8');
      expect(JSON.parse(raw)).toEqual({
        MD010: false,
        MD013: { line_length: 100, code_blocks: false },
      });
      expect(raw).toContain('"MD010": false');
    } finally {
      rmSync(configPath, { force: true });
    }
  });
});

const MD009_BODY = '# Heading\n\nFirst paragraph.\n\nLast paragraph with trailing spaces   \n';

test.describe('markdown lint — WYSIWYG block decorations + navigation', () => {
  test('a serialization-erased violation (trailing spaces) marks its block in WYSIWYG', async ({
    page,
    api,
  }) => {
    await seed(api, testDocName, MD009_BODY);
    await expect(page.locator('.ProseMirror .ok-lint-block').first()).toBeVisible({
      timeout: 10_000,
    });
    await expect(
      page.locator('.ProseMirror .ok-lint-block', {
        hasText: 'Last paragraph with trailing spaces',
      }),
    ).toHaveCount(1);
    await expect(
      page.locator('.ProseMirror .ok-lint-block', { hasText: 'First paragraph' }),
    ).toHaveCount(0);

    await seed(api, testDocName, CLEAN_BODY);
    await expect(page.locator('.ProseMirror .ok-lint-block')).toHaveCount(0);
  });

  test('decorations render in a doc that ends with a heading (trailing empty paragraph)', async ({
    page,
    api,
  }) => {
    const headingFinalBody =
      '# Lint demo\n\nTrailing spaces here.   \n\n- dash item\n* star item\n\n### End heading\n';
    await seed(api, testDocName, headingFinalBody);
    await expect(page.locator('.ProseMirror .ok-lint-block').first()).toBeVisible({
      timeout: 10_000,
    });
  });

  test('a textless block (thematic break / image) gets a visible outline, not an invisible underline', async ({
    page,
    api,
  }) => {
    await seed(api, testDocName, '# Title\n\n---\n\ntext\n\n***\n\nEnd.\n');
    const atoms = page.locator('.ProseMirror .ok-lint-block-atom');
    await expect(atoms.first()).toBeVisible({ timeout: 10_000 });
    const outlined = await atoms.evaluateAll((els) =>
      els.every((el) => getComputedStyle(el).outlineStyle !== 'none'),
    );
    expect(outlined).toBe(true);
  });

  test('clicking a Problems row in WYSIWYG actually scrolls the block into view', async ({
    page,
    api,
  }) => {
    const filler = Array.from({ length: 40 }, (_, i) => `Filler paragraph number ${i + 1}.`).join(
      '\n\n',
    );
    const tallBody = `# Top heading\n\n${filler}\n\nParagraph with trailing spaces here.   \n\n### Bottom heading\n`;
    await seed(api, testDocName, tallBody);
    await openProblemsTab(page);
    await expect(page.getByText('MD009')).toBeVisible();

    const scroller = page.getByTestId('editor-scroll-container');
    await expect(scroller).toBeVisible();
    const before = await scroller.evaluate((el) => el.scrollTop);

    await page.locator('ul[aria-label="Problems"] > li button').first().click();

    await expect
      .poll(async () => scroller.evaluate((el) => el.scrollTop))
      .toBeGreaterThan(before + 100);
    await expect
      .poll(async () =>
        page.evaluate(() => {
          const pm = document.querySelector('.ProseMirror:not(.composer-prosemirror)');
          const scrollEl = document.querySelector('[data-testid="editor-scroll-container"]');
          if (!pm || !scrollEl) return false;
          const target = Array.from(pm.children).find((c) =>
            c.textContent?.includes('Paragraph with trailing spaces here.'),
          );
          if (!target) return false;
          const t = target.getBoundingClientRect();
          const s = scrollEl.getBoundingClientRect();
          return t.top >= s.top + 48 && t.top <= s.bottom;
        }),
      )
      .toBe(true);
  });

  test('clicking a Problems row in source mode scrolls the ancestor container to the line', async ({
    page,
    api,
  }) => {
    const filler = Array.from({ length: 40 }, (_, i) => `Filler paragraph number ${i + 1}.`).join(
      '\n\n',
    );
    const tallBody = `# Top heading\n\n${filler}\n\nParagraph with trailing spaces here.   \n`;
    await seed(api, testDocName, tallBody);
    await switchToSource(page);
    await openProblemsTab(page);
    await expect(page.getByText('MD009')).toBeVisible();

    const scroller = page.getByTestId('editor-scroll-container');
    await expect(scroller).toBeVisible();
    const before = await scroller.evaluate((el) => el.scrollTop);

    await page.locator('ul[aria-label="Problems"] > li button').first().click();

    await expect
      .poll(async () => scroller.evaluate((el) => el.scrollTop))
      .toBeGreaterThan(before + 100);
  });

  test('clicking a Problems row in WYSIWYG selects and scrolls to the offending block', async ({
    page,
    api,
  }) => {
    await seed(api, testDocName, MD009_BODY);
    await openProblemsTab(page);
    await expect(page.getByText('MD009')).toBeVisible();

    await page.locator('ul[aria-label="Problems"] > li button').first().click();

    await expect
      .poll(async () =>
        page.evaluate(() => {
          const anchor = window.getSelection()?.anchorNode ?? null;
          const element = anchor instanceof Element ? anchor : (anchor?.parentElement ?? null);
          const pm = document.querySelector('.ProseMirror:not(.composer-prosemirror)');
          if (!pm || !element) return -1;
          const top = Array.from(pm.children).find((child) => child.contains(element));
          return top ? Array.from(pm.children).indexOf(top) : -1;
        }),
      )
      .toBe(2);
  });

  test('project-scope click on a closed doc opens it AND scrolls on the first click', async ({
    page,
    api,
    workerServer,
  }) => {
    const doc2 = `mdlint-${randomUUID().slice(0, 8)}`;
    await api.createPage(`${doc2}.md`);
    const filler = Array.from({ length: 40 }, (_, i) => `Filler line ${i + 1}.`).join('\n\n');
    const doc2Body = `# ${doc2}\n\n${filler}\n\nParagraph with trailing spaces here.   \n\n### Bottom heading\n`;
    await seed(api, doc2, doc2Body);
    await seed(api, testDocName, CLEAN_BODY);

    await expect
      .poll(
        () => {
          try {
            return readFileSync(join(workerServer.contentDir, `${doc2}.md`), 'utf-8').includes(
              'trailing spaces here.',
            );
          } catch {
            return false;
          }
        },
        { timeout: 15_000 },
      )
      .toBe(true);

    await openProblemsTab(page);
    await page.getByTestId('panel-scope-project').click();
    const group = page.getByTestId('problems-audit-group').filter({ hasText: doc2 });
    await expect(group).toBeVisible({ timeout: 10_000 });
    await page.getByTestId('problems-audit-expand-toggle').click();
    await expect(group.getByRole('button', { name: /Trailing spaces/ }).first()).toBeVisible({
      timeout: 10_000,
    });

    await group
      .getByRole('button', { name: /Trailing spaces/ })
      .first()
      .click();
    await expect.poll(() => new URL(page.url()).hash).toBe(`#/${doc2}`);
    await waitForProvider(page);
    await page.waitForSelector('.ProseMirror:not(.composer-prosemirror)');

    const scroller = page.locator('[data-testid="editor-scroll-container"]:visible');
    await expect(scroller).toBeVisible();
    await expect.poll(async () => scroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(100);
  });
});

test.describe('markdown lint — auto-fix', () => {
  const FIXABLE_BODY = '# Title\n\nParagraph with trailing spaces.   \n';

  test('the Problems panel Fix button applies the fix and the violation clears', async ({
    page,
    api,
  }) => {
    await seed(api, testDocName, FIXABLE_BODY);
    await openProblemsTab(page);
    await expect(page.getByText('MD009')).toBeVisible();
    const fix = page.getByTestId('problems-fix').first();
    await expect(fix).toBeAttached();
    await fix.click();
    await expect(page.getByText('MD009')).toHaveCount(0);
    await expect(page.getByText('No problems found')).toBeVisible();
    await expect(page.locator('.ProseMirror .ok-lint-block')).toHaveCount(0);
  });

  test('the WYSIWYG tooltip Fix button applies the fix', async ({ page, api }) => {
    await seed(api, testDocName, FIXABLE_BODY);
    const block = page.locator('.ProseMirror .ok-lint-block').first();
    await expect(block).toBeVisible({ timeout: 10_000 });
    await block.hover();
    const tooltipFix = page.locator('.ok-lint-tooltip-fix');
    await expect(tooltipFix).toBeVisible();
    await tooltipFix.click();
    await expect(page.locator('.ProseMirror .ok-lint-block')).toHaveCount(0);
  });
});

test.describe('markdown lint — WYSIWYG hover callout vs the editing region', () => {
  const OCCLUDING_BODY =
    '# Title\n\nA long paragraph that wraps across more than one visual line in the editor, so a click can land at the measured vertical centre of a known line box while the pointer keeps resting on the block.   \n';

  const CARET_OCCLUSION_TOLERANCE_PX = 1;

  interface EdgeRect {
    top: number;
    bottom: number;
    left: number;
    right: number;
  }

  interface CalloutGeometry {
    tooltip: EdgeRect | null;
    caretLine: EdgeRect | null;
    caretOcclusionPx: number;
    elementAtCaret: string | null;
  }

  function readCalloutGeometry(page: Page): Promise<CalloutGeometry> {
    return page.evaluate(() => {
      const toEdges = (r: DOMRect) => ({
        top: r.top,
        bottom: r.bottom,
        left: r.left,
        right: r.right,
      });
      const visible =
        Array.from(document.querySelectorAll<HTMLElement>('.ok-lint-tooltip')).find(
          (el) => !el.hidden,
        ) ?? null;
      const selection = window.getSelection();
      let caretLine: EdgeRect | null = null;
      let elementAtCaret: string | null = null;
      if (selection && selection.rangeCount > 0) {
        const range = selection.getRangeAt(0).cloneRange();
        const rects = range.getClientRects();
        const caret = rects.length > 0 ? rects[0] : range.getBoundingClientRect();
        const focus = selection.focusNode;
        const focusElement = focus instanceof Element ? focus : (focus?.parentElement ?? null);
        const blockRect =
          focusElement?.closest('.ProseMirror > *')?.getBoundingClientRect() ?? null;
        caretLine = {
          top: caret.top,
          bottom: caret.bottom,
          left: blockRect ? blockRect.left : caret.left,
          right: blockRect ? blockRect.right : caret.right,
        };
        elementAtCaret =
          document.elementFromPoint(caret.left + 1, (caret.top + caret.bottom) / 2)?.className ??
          null;
      }
      const tooltip = visible ? toEdges(visible.getBoundingClientRect()) : null;
      let caretOcclusionPx = 0;
      if (tooltip && caretLine) {
        const horizontalOverlap =
          Math.min(tooltip.right, caretLine.right) - Math.max(tooltip.left, caretLine.left);
        const verticalOverlap =
          Math.min(tooltip.bottom, caretLine.bottom) - Math.max(tooltip.top, caretLine.top);
        caretOcclusionPx = horizontalOverlap > 0 ? Math.max(0, verticalOverlap) : 0;
      }
      return { tooltip, caretLine, caretOcclusionPx, elementAtCaret };
    });
  }

  const visibleCallouts = (page: Page) => page.locator('.ok-lint-tooltip:visible');

  async function lintBlockBox(page: Page) {
    const block = page.locator('.ProseMirror:not(.composer-prosemirror) .ok-lint-block').first();
    await expect(block).toBeVisible({ timeout: 15_000 });
    const box = await block.boundingBox();
    if (!box) throw new Error('lint block has no layout box');
    return box;
  }

  test('the hover callout clears the line box the caret sits in', async ({ page, api }) => {
    await seed(api, testDocName, OCCLUDING_BODY);
    const box = await lintBlockBox(page);

    await page.mouse.click(box.x + 80, box.y + 6);
    await expect(visibleCallouts(page)).not.toHaveCount(0);
    const probe = await readCalloutGeometry(page);
    expect(probe.caretLine, 'no caret after clicking into the lint block').not.toBeNull();
    const lineBox = probe.caretLine as EdgeRect;
    expect(lineBox.bottom - lineBox.top).toBeGreaterThan(8);
    expect(lineBox.right - lineBox.left).toBeGreaterThan(50);

    await page.mouse.move(box.x + 20, 60);
    await expect(visibleCallouts(page)).toHaveCount(0);
    await page.mouse.click(box.x + 150, (lineBox.top + lineBox.bottom) / 2);
    await expect(visibleCallouts(page)).not.toHaveCount(0);
    await expect
      .poll(
        async () => {
          const { tooltip } = await readCalloutGeometry(page);
          return tooltip ? tooltip.top !== 0 || tooltip.left !== 0 : false;
        },
        {
          message: 'the hover callout never received a computed position',
        },
      )
      .toBe(true);

    const geometry = await readCalloutGeometry(page);
    expect(geometry.tooltip, 'the hover callout vanished before it was measured').not.toBeNull();
    expect(
      geometry.caretLine && Math.abs(geometry.caretLine.top - lineBox.top),
      'the second click landed on a different line than the one that was measured',
    ).toBeLessThan(2);
    expect(
      geometry.caretOcclusionPx,
      `hover callout overlaps the caret line box by ${geometry.caretOcclusionPx.toFixed(2)}px — ` +
        `callout=${JSON.stringify(geometry.tooltip)} caretLine=${JSON.stringify(geometry.caretLine)} ` +
        `topmostElementAtCaret=${geometry.elementAtCaret}`,
    ).toBeLessThanOrEqual(CARET_OCCLUSION_TOLERANCE_PX);
  });

  test('typing with the pointer resting on the block retires the hover callout', async ({
    page,
    api,
  }) => {
    await seed(api, testDocName, OCCLUDING_BODY);
    const box = await lintBlockBox(page);

    await page.mouse.click(box.x + 80, box.y + box.height / 2);
    await expect(visibleCallouts(page)).not.toHaveCount(0);

    await page.keyboard.type('typing under the callout', { delay: 25 });
    await expect(visibleCallouts(page)).toHaveCount(0);
  });

  test('arrow-key caret movement retires the hover callout', async ({ page, api }) => {
    await seed(api, testDocName, OCCLUDING_BODY);
    const box = await lintBlockBox(page);

    await page.mouse.click(box.x + 80, box.y + 6);
    await expect(visibleCallouts(page)).not.toHaveCount(0);

    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await expect(visibleCallouts(page)).toHaveCount(0);
  });

  test('the hover callout comes back when the pointer moves after a keyboard dismissal', async ({
    page,
    api,
  }) => {
    await seed(api, testDocName, OCCLUDING_BODY);
    const box = await lintBlockBox(page);

    await page.mouse.click(box.x + 80, box.y + 6);
    await expect(visibleCallouts(page)).not.toHaveCount(0);

    await page.keyboard.press('ArrowRight');
    await expect(visibleCallouts(page)).toHaveCount(0);

    await page.mouse.move(box.x + 20, 60);
    await page.mouse.move(box.x + 140, box.y + 6);
    await expect(visibleCallouts(page)).not.toHaveCount(0);
    await expect(visibleCallouts(page).first()).toContainText('MD009');
  });

  const INLINE_PNG =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAGQAAABkCAYAAABw4pVUAAAAJ0lEQVR4nO3BMQEAAADCoPVPbQhfoAAAAAAAAAAAAAAAAAAAAOBrAB+wAAF7bJcRAAAAAElFTkSuQmCC';
  const TEXTLESS_BODY = `# Title\n\nA paragraph of ordinary text.\n\n![](${INLINE_PNG})\n\nMore ordinary text.\n\n---\n\nEven more text.\n\n***\n\nEnd.\n`;

  const MAX_ANCHOR_GAP_PX = 24;

  test('the hover callout on a textless block anchors to that block', async ({ page, api }) => {
    await seed(api, testDocName, TEXTLESS_BODY);
    const atoms = page.locator('.ProseMirror:not(.composer-prosemirror) .ok-lint-block-atom');
    await expect(atoms.first()).toBeVisible({ timeout: 15_000 });
    const count = await atoms.count();
    expect(count, 'expected both textless shapes to be decorated').toBeGreaterThanOrEqual(2);

    for (let index = 0; index < count; index += 1) {
      const atom = atoms.nth(index);
      const box = await atom.boundingBox();
      expect(box, `textless lint block ${index} has no layout box`).not.toBeNull();
      const blockBox = box as NonNullable<typeof box>;

      await page.mouse.move(blockBox.x + 20, 60);
      await expect(visibleCallouts(page)).toHaveCount(0);
      await page.mouse.move(blockBox.x + blockBox.width * 0.25, blockBox.y + blockBox.height / 2);
      await expect(visibleCallouts(page)).not.toHaveCount(0);
      await expect
        .poll(
          async () => {
            const { tooltip } = await readCalloutGeometry(page);
            return tooltip ? tooltip.top !== 0 || tooltip.left !== 0 : false;
          },
          { message: 'the hover callout never received a computed position' },
        )
        .toBe(true);

      const { tooltip } = await readCalloutGeometry(page);
      expect(tooltip, 'the hover callout vanished before it was measured').not.toBeNull();
      const callout = tooltip as EdgeRect;
      const gapPx = blockBox.y - callout.bottom;
      expect(
        gapPx,
        `hover callout sits ${gapPx.toFixed(2)}px above the block it describes — ` +
          `callout=${JSON.stringify(callout)} block=${JSON.stringify(blockBox)}`,
      ).toBeLessThanOrEqual(MAX_ANCHOR_GAP_PX);
      expect(
        gapPx,
        `hover callout overlaps the block it describes by ${(-gapPx).toFixed(2)}px — ` +
          `callout=${JSON.stringify(callout)} block=${JSON.stringify(blockBox)}`,
      ).toBeGreaterThanOrEqual(0);
    }
  });
});

async function seed(api: ApiHelpers, docName: string, markdown: string) {
  await api.replaceDoc(docName, markdown);
}
